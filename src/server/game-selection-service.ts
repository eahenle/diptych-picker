import type { PendingComparisonReceipt } from "@/domain/challenger-state";
import {
  beginChampionRetirement,
  beginBothLose,
  beginBufferedSelection,
  beginTie,
  candidateAt,
  completeBothLose,
  completeChampionRetirement,
  completeSelection,
  completeTie,
  oppositeSide,
  willRetireChampion,
  type GameRules,
  type GameState,
  type Side,
} from "@/domain/game";
import {
  deriveDequeueOperationId,
  type ImportSession,
} from "@/domain/import-session";
import { recordPromptCardDecision } from "@/domain/prompt-deck";
import type { ChallengerRepository } from "./challenger-repository";
import {
  type CandidateDequeueRequest,
  type CandidateDequeueService,
  summarizeImportSupply,
} from "./candidate-dequeue-service";
import { applyAdaptivePreferences } from "./game-adaptation";
import {
  MissingGameError,
  SelectionConflictError,
} from "./game-service-errors";
import {
  comparisonReceipt,
  recordBothLose,
  recordComparison,
  recordTie,
  tieReferenceSide,
} from "./game-comparison";
import type { GenerationJobPublisher } from "./generation-job-publisher";
import type { PreparedSelectionReconciler } from "./prepared-selection-reconciler";
import type { PromptCardReconciler } from "./prompt-card-reconciler";
import type { RefillCapacityService } from "./refill-capacity-service";
import type { ImportSessionRepository } from "./import-session-repository";
import type { GameRepository } from "./repository";
import type {
  LockedStateContext,
  StateLockCoordinator,
} from "./state-lock-coordinator";

interface GameSelectionServiceOptions {
  gameRepository: GameRepository;
  challengerRepository: ChallengerRepository;
  importSessionRepository: ImportSessionRepository;
  stateLockCoordinator: StateLockCoordinator;
  candidateDequeueService: Pick<CandidateDequeueService, "dequeueLocked">;
  promptCardReconciler: Pick<PromptCardReconciler, "reconcileEditor">;
  preparedSelectionReconciler: Pick<PreparedSelectionReconciler, "baseline">;
  refillCapacityService: Pick<RefillCapacityService, "plan">;
  generationJobPublisher: Pick<GenerationJobPublisher, "ensureAll">;
  config: {
    initialRating: number;
    eloKFactor: number;
  };
  rulesFor: (game: GameState) => GameRules;
  now: () => string;
}

export class GameSelectionService {
  constructor(private readonly options: GameSelectionServiceOptions) {}

  async select(
    winnerSide: Side,
    expectedRoundNumber: number,
  ): Promise<GameState> {
    const outcome = await this.withStateLocks(async (lockContext) => {
      const current = await this.options.gameRepository.load();
      if (!current) {
        throw new MissingGameError("Start a game before choosing an image");
      }
      if (current.round.roundNumber !== expectedRoundNumber) {
        throw new SelectionConflictError(
          "The round changed before this selection arrived",
        );
      }

      const challengerState = await this.options.challengerRepository.load();
      if (!challengerState) {
        throw new MissingGameError(
          "Start a game before choosing a buffered challenger",
        );
      }

      const selectedAt = this.options.now();
      const rules = this.options.rulesFor(current);
      const retirement = willRetireChampion(
        current,
        winnerSide,
        rules.championRetirementStreak,
      );
      const inFlight = retirement
        ? beginChampionRetirement(
            current,
            winnerSide,
            selectedAt,
            rules.championRetirementStreak,
          )
        : beginBufferedSelection(current, winnerSide, selectedAt);
      if (!inFlight) {
        throw new SelectionConflictError(
          "A challenger is already being generated",
        );
      }

      const retainedWinner = candidateAt(current.round, winnerSide);
      const rejectedCandidate = candidateAt(
        current.round,
        oppositeSide(winnerSide),
      );
      const originalReceipt = comparisonReceipt(
        current,
        winnerSide,
        selectedAt,
      );
      let nextChallengers = recordComparison(
        {
          ...challengerState,
          pendingSelectionBaseline:
            this.options.preparedSelectionReconciler.baseline(challengerState),
        },
        retainedWinner,
        rejectedCandidate,
        originalReceipt,
        { ...this.options.config, poolMaximum: rules.poolMaximum },
      );
      await this.options.gameRepository.save(
        recordPromptCardDecision(
          inFlight,
          [retainedWinner],
          [rejectedCandidate],
          selectedAt,
          "Selected comparison winner",
        ),
      );
      await this.options.challengerRepository.save(nextChallengers);

      const importSession = await this.options.importSessionRepository.load();
      const importSessionId = activatedImportSessionId(importSession);
      let importSupply = summarizeImportSupply(
        importSessionId ? importSession : null,
      );
      let nextGame = inFlight;
      if (retirement) {
        const leftDraw = await this.dequeue(lockContext, {
          importSessionId,
          challengerSessionId: nextChallengers.sessionId,
          originalReceipt,
          replacementSlot: "pair-left",
          reason: "retirement",
          invocation: "live",
          roundNumber: current.round.roundNumber + 1,
          excludedCandidateIds: [
            current.round.leftCandidate.id,
            current.round.rightCandidate.id,
          ],
        });
        nextChallengers = leftDraw.challengers;
        importSupply = leftDraw.importSupply;
        const rightDraw = leftDraw.candidate
          ? await this.dequeue(lockContext, {
              importSessionId,
              challengerSessionId: nextChallengers.sessionId,
              originalReceipt,
              replacementSlot: "pair-right",
              reason: "retirement",
              invocation: "live",
              roundNumber: current.round.roundNumber + 1,
              excludedCandidateIds: [
                current.round.leftCandidate.id,
                current.round.rightCandidate.id,
                leftDraw.candidate.id,
              ],
            })
          : null;
        if (rightDraw) {
          nextChallengers = rightDraw.challengers;
          importSupply = rightDraw.importSupply;
        }
        if (leftDraw.candidate && rightDraw?.candidate) {
          nextGame = completeChampionRetirement(
            inFlight,
            leftDraw.candidate,
            rightDraw.candidate,
          );
        }
      } else {
        const draw = await this.dequeue(lockContext, {
          importSessionId,
          challengerSessionId: nextChallengers.sessionId,
          originalReceipt,
          replacementSlot: "single",
          reason: "selection",
          invocation: "live",
          roundNumber: current.round.roundNumber + 1,
          excludedCandidateIds: [
            current.round.leftCandidate.id,
            current.round.rightCandidate.id,
          ],
        });
        nextChallengers = draw.challengers;
        importSupply = draw.importSupply;
        if (draw.candidate) {
          nextGame = completeSelection(inFlight, draw.candidate);
        }
      }

      nextGame = recordPromptCardDecision(
        nextGame,
        [retainedWinner],
        [rejectedCandidate],
        selectedAt,
        "Selected comparison winner",
      );
      const adapted = applyAdaptivePreferences(nextGame, nextChallengers);
      nextGame = adapted.game;
      nextChallengers = adapted.challengers;
      const capacity = this.options.refillCapacityService.plan(
        nextChallengers,
        {
          game: nextGame,
          winnerSide,
          retainedWinner,
          rejectedCandidate,
        },
        importSupply,
      );
      await this.options.challengerRepository.save(capacity.state);
      await this.options.gameRepository.save(nextGame);
      nextGame =
        await this.options.promptCardReconciler.reconcileEditor(nextGame);
      if (nextGame.round.status === "idle") {
        await this.options.challengerRepository.save({
          ...capacity.state,
          pendingComparison: null,
          preparedDequeues: [],
          pendingSelectionBaseline: null,
        });
      }
      return { game: nextGame, jobs: capacity.jobs };
    });
    await this.options.generationJobPublisher.ensureAll(outcome.jobs);
    return outcome.game;
  }

  async tie(expectedRoundNumber: number): Promise<GameState> {
    return this.replacePair(expectedRoundNumber, "tie");
  }

  async bothLose(expectedRoundNumber: number): Promise<GameState> {
    return this.replacePair(expectedRoundNumber, "both-lose");
  }

  private async replacePair(
    expectedRoundNumber: number,
    outcome: "tie" | "both-lose",
  ): Promise<GameState> {
    const result = await this.withStateLocks(async (lockContext) => {
      const current = await this.options.gameRepository.load();
      if (!current) {
        throw new MissingGameError(
          outcome === "tie"
            ? "Start a game before declaring a tie"
            : "Start a game before rejecting both candidates",
        );
      }
      if (current.round.roundNumber !== expectedRoundNumber) {
        throw new SelectionConflictError(
          outcome === "tie"
            ? "The round changed before this tie arrived"
            : "The round changed before this dual rejection arrived",
        );
      }

      const challengerState = await this.options.challengerRepository.load();
      if (!challengerState) {
        throw new MissingGameError(
          "Start a game before replacing tied candidates",
        );
      }

      const selectedAt = this.options.now();
      const referenceSide = tieReferenceSide(
        current,
        challengerState,
        this.options.config.initialRating,
      );
      const inFlight =
        outcome === "tie"
          ? beginTie(current, referenceSide, selectedAt)
          : beginBothLose(current, referenceSide, selectedAt);
      if (!inFlight) {
        throw new SelectionConflictError(
          "A challenger is already being generated",
        );
      }

      const left = current.round.leftCandidate;
      const right = current.round.rightCandidate;
      const receipt: PendingComparisonReceipt = {
        kind: outcome,
        selectedAt,
        roundNumber: current.round.roundNumber,
        leftId: left.id,
        rightId: right.id,
      };
      const baseline = {
        ...challengerState,
        pendingSelectionBaseline:
          this.options.preparedSelectionReconciler.baseline(challengerState),
      };
      let nextChallengers =
        outcome === "tie"
          ? recordTie(baseline, left, right, receipt, {
              ...this.options.config,
              poolMaximum: this.options.rulesFor(current).poolMaximum,
            })
          : recordBothLose(
              baseline,
              left,
              right,
              receipt,
              this.options.config.initialRating,
            );
      await this.options.gameRepository.save(
        outcome === "both-lose"
          ? recordPromptCardDecision(
              inFlight,
              [],
              [left, right],
              selectedAt,
              "Both images rejected",
            )
          : inFlight,
      );
      await this.options.challengerRepository.save(nextChallengers);

      const importSession = await this.options.importSessionRepository.load();
      const importSessionId = activatedImportSessionId(importSession);
      let importSupply = summarizeImportSupply(
        importSessionId ? importSession : null,
      );
      let nextGame = inFlight;
      const leftDraw = await this.dequeue(lockContext, {
        importSessionId,
        challengerSessionId: nextChallengers.sessionId,
        originalReceipt: receipt,
        replacementSlot: "pair-left",
        reason: outcome,
        invocation: "live",
        roundNumber: current.round.roundNumber + 1,
        excludedCandidateIds: [left.id, right.id],
      });
      nextChallengers = leftDraw.challengers;
      importSupply = leftDraw.importSupply;
      const rightDraw = leftDraw.candidate
        ? await this.dequeue(lockContext, {
            importSessionId,
            challengerSessionId: nextChallengers.sessionId,
            originalReceipt: receipt,
            replacementSlot: "pair-right",
            reason: outcome,
            invocation: "live",
            roundNumber: current.round.roundNumber + 1,
            excludedCandidateIds: [left.id, right.id, leftDraw.candidate.id],
          })
        : null;
      if (rightDraw) {
        nextChallengers = rightDraw.challengers;
        importSupply = rightDraw.importSupply;
      }
      if (leftDraw.candidate && rightDraw?.candidate) {
        nextGame =
          outcome === "tie"
            ? completeTie(inFlight, leftDraw.candidate, rightDraw.candidate)
            : completeBothLose(
                inFlight,
                leftDraw.candidate,
                rightDraw.candidate,
              );
      }

      if (outcome === "both-lose") {
        nextGame = recordPromptCardDecision(
          nextGame,
          [],
          [left, right],
          selectedAt,
          "Both images rejected",
        );
      }

      if (outcome === "both-lose" && nextGame.round.status === "idle") {
        const adapted = applyAdaptivePreferences(nextGame, nextChallengers);
        nextGame = adapted.game;
        nextChallengers = adapted.challengers;
      }

      const reference = candidateAt(current.round, referenceSide);
      const contrasted = candidateAt(
        current.round,
        oppositeSide(referenceSide),
      );
      const capacity = this.options.refillCapacityService.plan(
        nextChallengers,
        {
          game: nextGame,
          winnerSide: referenceSide,
          retainedWinner: reference,
          rejectedCandidate: contrasted,
          comparisonOutcome: outcome,
        },
        importSupply,
      );
      await this.options.challengerRepository.save(capacity.state);
      await this.options.gameRepository.save(nextGame);
      nextGame =
        await this.options.promptCardReconciler.reconcileEditor(nextGame);
      if (nextGame.round.status === "idle") {
        await this.options.challengerRepository.save({
          ...capacity.state,
          pendingComparison: null,
          preparedDequeues: [],
          pendingSelectionBaseline: null,
        });
      }
      return { game: nextGame, jobs: capacity.jobs };
    });
    await this.options.generationJobPublisher.ensureAll(result.jobs);
    return result.game;
  }

  private dequeue(
    context: LockedStateContext,
    request: Omit<CandidateDequeueRequest, "dequeueOperationId">,
  ) {
    return this.options.candidateDequeueService.dequeueLocked(context, {
      ...request,
      dequeueOperationId: deriveDequeueOperationId(
        request.importSessionId,
        request.challengerSessionId,
        request.originalReceipt,
        request.replacementSlot,
      ),
    });
  }

  private withStateLocks<T>(
    operation: (context: LockedStateContext) => Promise<T>,
  ): Promise<T> {
    return this.options.stateLockCoordinator.withStateLocks(
      ["activation-intent", "import-session", "game", "challenger"],
      operation,
    );
  }
}

function activatedImportSessionId(
  session: ImportSession | null,
): string | null {
  return session?.activatedAt &&
    (session.status === "active" || session.status === "completed")
    ? session.id
    : null;
}
