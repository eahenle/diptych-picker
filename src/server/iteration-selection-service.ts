import { isDeepStrictEqual } from "node:util";
import { ZodError } from "zod";
import type { ChallengerState } from "@/domain/challenger-state";
import {
  beginSelection,
  candidateAt,
  completeSelection,
  failSelection,
  oppositeSide,
  preferenceProfileFromSeed,
  recentConcepts,
  type Candidate,
  type GameRules,
  type GameState,
  type Side,
} from "@/domain/game";
import {
  parseIterationCommand,
  pendingImageIterationSchema,
  ITERATION_HISTORY_LIMIT,
  type PendingImageIteration,
  type IterationSelection,
} from "@/domain/image-iteration";
import { recordPromptCardDecision } from "@/domain/prompt-deck";
import type {
  GenerationJob,
  GenerationMailbox,
  GenerationResult,
} from "./agent-mailbox";
import type { ChallengerRepository } from "./challenger-repository";
import type { PreparedSelectionReconciler } from "./prepared-selection-reconciler";
import { applyAdaptivePreferences } from "./game-adaptation";
import {
  comparisonReceipt,
  createCandidateRating,
  recordComparison,
} from "./game-comparison";
import {
  IterationSelectionError,
  MissingGameError,
  SelectionConflictError,
} from "./game-service-errors";
import type { GenerationJobPublisher } from "./generation-job-publisher";
import {
  InvalidIterationReviewError,
  verifyIterationCompletion,
} from "./image-iteration-review";
import type { AssetStore } from "./providers";
import { candidateFromGenerationResult } from "./refill-result-reconciler";
import type { GameRepository } from "./repository";
import type { StateLockCoordinator } from "./state-lock-coordinator";

interface IterationSelectionOptions {
  gameRepository: GameRepository;
  challengerRepository: ChallengerRepository;
  stateLocks: StateLockCoordinator;
  mailbox: GenerationMailbox;
  publisher: Pick<GenerationJobPublisher, "ensure">;
  assetVerifier: Pick<AssetStore, "verify">;
  baseline: PreparedSelectionReconciler["baseline"];
  cleanup: (game: GameState) => Promise<GameState>;
  readImageDigest?: (candidate: Candidate) => Promise<string>;
  config: { initialRating: number; eloKFactor: number };
  rulesFor: (game: GameState) => GameRules;
  now: () => string;
  createId: () => string;
}

export class IterationSelectionService {
  constructor(private readonly options: IterationSelectionOptions) {}

  async select(
    side: Side,
    roundNumber: number,
    request: IterationSelection,
  ): Promise<GameState> {
    const command = request.command.trim();
    let parsed;
    try {
      parsed = parseIterationCommand(command);
    } catch (error) {
      throw new IterationSelectionError((error as Error).message);
    }
    return this.options.stateLocks.withStateLocks(
      ["game", "challenger"],
      async () => {
        const [game, challengers] = await Promise.all([
          this.options.gameRepository.load(),
          this.options.challengerRepository.load(),
        ]);
        if (!game || !challengers)
          throw new MissingGameError(
            "Start a game before requesting a variation",
          );
        const winner = candidateAt(game.round, side);
        if (
          game.round.roundNumber !== roundNumber ||
          winner.id !== request.winnerCandidateId
        ) {
          throw new SelectionConflictError(
            "The comparison changed before this variation was requested",
          );
        }
        if (game.round.status === "generating") {
          const pending = game.pendingSelection;
          if (
            pending?.kind === "generation" &&
            pending.iteration &&
            pending.winnerSide === side &&
            pending.iteration.context.sessionId === challengers.sessionId &&
            pending.iteration.context.command === command &&
            pending.iteration.source.candidateId === request.sourceCandidateId
          ) {
            return game;
          }
          throw new SelectionConflictError(
            "A challenger is already being generated",
          );
        }
        const source = [
          game.round.leftCandidate,
          game.round.rightCandidate,
          ...challengers.ratings.map(({ candidate }) => candidate),
          ...challengers.importQueue.map(({ candidate }) => candidate),
        ].find(({ id }) => id === request.sourceCandidateId);
        if (!source)
          throw new SelectionConflictError(
            "That variation source is no longer available in this game",
          );

        const readImageDigest = this.options.readImageDigest;
        if (!readImageDigest)
          throw new IterationSelectionError(
            "Variation source images are unavailable",
          );
        let winnerImageSha256: string;
        let sourceImageSha256: string;
        try {
          winnerImageSha256 = await readImageDigest(winner);
          sourceImageSha256 =
            source.id === winner.id
              ? winnerImageSha256
              : await readImageDigest(source);
        } catch {
          throw new IterationSelectionError(
            "The selected image or variation source could not be read",
          );
        }
        const iteration = pendingImageIterationSchema.parse({
          context: {
            command,
            sessionId: challengers.sessionId,
            sourceImageUrl: source.imageUrl,
            sourceImageSha256,
            winnerImageSha256,
            history: iterationHistory(
              game,
              challengers.ratings.map(({ candidate }) => candidate),
            ),
          },
          source: { candidateId: source.id, concept: source.concept },
          plan: {
            temperature: parsed.temperature,
            mandatoryAnchors: parsed.preserveAnchors,
            optionalAnchors: [],
            exclusions: [],
          },
        });
        const inFlight = beginSelection(
          game,
          side,
          this.options.now(),
          this.options.createId(),
        );
        if (inFlight?.pendingSelection?.kind !== "generation")
          throw new SelectionConflictError(
            "A challenger is already being generated",
          );
        const pending = { ...inFlight.pendingSelection, iteration };
        const updated = { ...inFlight, pendingSelection: pending };
        await this.options.gameRepository.save(updated);
        await this.options.publisher.ensure(this.expectedJob(updated, pending));
        return updated;
      },
    );
  }

  // Called by GameReconciler with the game and challenger locks already held.
  async reconcile(game: GameState): Promise<GameState> {
    const pending = game.pendingSelection;
    if (pending?.kind !== "generation" || !pending.iteration) return game;
    const challengers = await this.options.challengerRepository.load();
    if (challengers?.sessionId !== pending.iteration.context.sessionId) {
      return this.fail(
        game,
        pending.generationJobId,
        "The variation belongs to an earlier game",
      );
    }

    const expected = this.expectedJob(game, pending);
    let work: GenerationJob | null;
    let result: GenerationResult | null;
    try {
      [work, result] = await Promise.all([
        this.options.mailbox.readWork(expected.id),
        this.options.mailbox.readResult(expected.id),
      ]);
    } catch (error) {
      if (!(
        error instanceof InvalidIterationReviewError ||
        error instanceof ZodError ||
        error instanceof SyntaxError
      ))
        throw error;
      return this.fail(
        game,
        expected.id,
        "The variation result could not be verified",
      );
    }
    if (
      (work && !isDeepStrictEqual(work, expected)) ||
      (result && (!work || result.jobId !== expected.id))
    ) {
      return this.fail(
        game,
        expected.id,
        "The variation result does not match its request",
      );
    }
    if (!result) {
      if (!work) await this.options.publisher.ensure(expected);
      return game;
    }
    if (result.status === "failed")
      return this.fail(game, expected.id, result.message);

    const generated = candidateFromGenerationResult(result, expected);
    const digest = result.asset.filename.slice(0, -".png".length);
    try {
      if (
        !generated ||
        !/^[a-f0-9]{64}$/.test(digest) ||
        generated.id === expected.retainedWinner.id ||
        generated.id === expected.rejectedCandidate.id
      ) {
        throw new Error("The challenger must be a new independent image");
      }
      verifyIterationCompletion(
        pending.iteration.plan,
        result.anchorReview,
        expected.id,
        digest,
        pending.iteration.context,
        result.proposal.iterationDirection,
      );
      await this.options.assetVerifier.verify(result.asset);
    } catch (error) {
      return this.fail(game, expected.id, (error as Error).message);
    }

    const receipt = comparisonReceipt(
      game,
      pending.winnerSide,
      pending.selectedAt,
    );
    const previous = challengers.ratings.find(
      ({ candidate }) => candidate.id === generated.id,
    );
    if (
      previous &&
      (!isDeepStrictEqual(previous.candidate, generated) ||
        !isDeepStrictEqual(challengers.pendingComparison, receipt))
    ) {
      return this.fail(game, expected.id, "The challenger ID was already used");
    }
    const decision = recordPromptCardDecision(
      completeSelection(game, generated),
      [expected.retainedWinner],
      [expected.rejectedCandidate],
      pending.selectedAt,
      "Selected comparison winner",
    );
    const compared = previous
      ? challengers
      : recordComparison(
          {
            ...challengers,
            pendingSelectionBaseline: this.options.baseline(challengers),
            ratings: [
              ...challengers.ratings,
              createCandidateRating(
                generated,
                "generated",
                false,
                this.options.config.initialRating,
              ),
            ],
          },
          expected.retainedWinner,
          expected.rejectedCandidate,
          receipt,
          {
            ...this.options.config,
            poolMaximum: this.options.rulesFor(game).poolMaximum,
          },
        );
    const adapted = applyAdaptivePreferences(
      decision,
      compared,
      compared.leaderboardVisualProfile ?? null,
    );
    await this.options.challengerRepository.save(adapted.challengers);
    return this.saveTerminal(adapted.game, expected.id, adapted.challengers);
  }

  private expectedJob(
    game: GameState,
    pending: Extract<
      NonNullable<GameState["pendingSelection"]>,
      { kind: "generation" }
    >,
  ): Extract<GenerationJob, { kind: "challenger" }> {
    const iteration = pending.iteration!;
    return {
      id: pending.generationJobId,
      kind: "challenger",
      createdAt: pending.selectedAt,
      roundNumber: game.round.roundNumber,
      winnerSide: pending.winnerSide,
      retainedWinner: candidateAt(game.round, pending.winnerSide),
      rejectedCandidate: candidateAt(
        game.round,
        oppositeSide(pending.winnerSide),
      ),
      selectionHistory: game.history.slice(-12),
      recentConcepts: recentConcepts(game, 10),
      preferenceSeed: game.preferenceSeed,
      preferenceProfile:
        game.preferenceProfile ??
        preferenceProfileFromSeed(game.preferenceSeed),
      variationSource: iteration.source,
      iterationPlan: iteration.plan,
      iterationContext: iteration.context,
    };
  }

  private async fail(
    game: GameState,
    jobId: string,
    message: string,
  ): Promise<GameState> {
    return this.saveTerminal(
      failSelection(game, `Variation failed: ${message}`),
      jobId,
    );
  }

  private async saveTerminal(
    game: GameState,
    jobId: string,
    challengers?: ChallengerState,
  ): Promise<GameState> {
    const awaitingCleanup = { ...game, mailboxCleanupJobId: jobId };
    await this.options.gameRepository.save(awaitingCleanup);
    if (challengers) {
      await this.options.challengerRepository.save({
        ...challengers,
        pendingComparison: null,
        pendingSelectionBaseline: null,
      });
    }
    return this.options.cleanup(awaitingCleanup);
  }
}

function iterationHistory(
  game: GameState,
  candidates: Candidate[],
): PendingImageIteration["context"]["history"] {
  const observations = new Map(
    candidates.map((candidate) => [
      candidate.id,
      candidate.lineage?.iteration?.observedFingerprint,
    ]),
  );
  const entry = (outcome: "selected" | "rejected", id: string) => {
    const fingerprint = observations.get(id);
    return { outcome, ...(fingerprint ? { fingerprint } : {}) };
  };
  return game.history
    .slice(-ITERATION_HISTORY_LIMIT)
    .flatMap((decision) => {
      if (decision.outcome === "tie") return [];
      if (decision.outcome === "both-lose")
        return [
          entry("rejected", decision.leftId),
          entry("rejected", decision.rightId),
        ];
      return [
        entry("selected", decision.winnerId),
        entry("rejected", decision.loserId),
      ];
    })
    .slice(-ITERATION_HISTORY_LIMIT);
}
