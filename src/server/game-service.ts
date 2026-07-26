import {
  drawFallback,
  popReady,
  backfillGeneratedPool,
  type BufferedCandidate,
  type ChallengerState,
  type PendingComparisonReceipt,
} from "@/domain/challenger-state";
import {
  beginChampionRetirement,
  beginBothLose,
  beginBufferedSelection,
  beginTie,
  candidateAt,
  completeChampionRetirement,
  completeBothLose,
  completeSelection,
  completeTie,
  oppositeSide,
  preferenceProfileFromSeed,
  willRetireChampion,
  type GameRules,
  type GameState,
  type PreferenceProfile,
  type Side,
} from "@/domain/game";
import {
  recordPromptCardDecision,
  type CreatePromptCardInput,
} from "@/domain/prompt-deck";
import type {
  GenerationMailbox,
  PromptCardBlenderMailbox,
  PromptCardEditorMailbox,
} from "./agent-mailbox";
import type { ChallengerRepository } from "./challenger-repository";
import { challengerConfig } from "./challenger-config";
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
import { GameSettingsService } from "./game-settings-service";
import { refillContext } from "./game-refill";
import { effectiveGameRules } from "./game-rules";
import { GenerationJobPublisher } from "./generation-job-publisher";
import { GenerationSelectionReconciler } from "./generation-selection-reconciler";
import { LeaderboardProfileReconciler } from "./leaderboard-profile-reconciler";
import type { LeaderboardProfileCoordinator } from "./leaderboard-profile-service";
import { PromptCardReconciler } from "./prompt-card-reconciler";
import type { PromptCardWriterCoordinator } from "./prompt-card-writer-service";
import { PromptDeckService } from "./prompt-deck-service";
import { PreferenceService } from "./preference-service";
import { PreparedSelectionReconciler } from "./prepared-selection-reconciler";
import type { AssetStore } from "./providers";
import { RefillResultReconciler } from "./refill-result-reconciler";
import type { GameRepository } from "./repository";
import { RefillCapacityService } from "./refill-capacity-service";

export {
  GameRulesError,
  MissingGameError,
  PreferencePresetLimitError,
  PromptDeckError,
  SelectionConflictError,
} from "./game-service-errors";

export interface GameServiceConfig {
  bufferTarget: number;
  poolMaximum: number;
  initialRating: number;
  eloKFactor: number;
  turnaroundEmaAlpha: number;
  initialTurnaroundMs: number;
  fallbackDelayMs: number;
  fallbackMaximumConsecutive: number;
}

export class GameService {
  private reconciliation: Promise<GameState | null> | null = null;
  private readonly generationJobPublisher: GenerationJobPublisher;
  private readonly generationSelectionReconciler: GenerationSelectionReconciler;
  private readonly leaderboardProfileReconciler: LeaderboardProfileReconciler;
  private readonly promptCardReconciler: PromptCardReconciler;
  private readonly promptDeckService: PromptDeckService;
  private readonly gameSettingsService: GameSettingsService;
  private readonly preferenceService: PreferenceService;
  private readonly preparedSelectionReconciler: PreparedSelectionReconciler;
  private readonly refillResultReconciler: RefillResultReconciler;
  private readonly refillCapacityService: RefillCapacityService;

  constructor(
    private readonly gameRepository: GameRepository,
    private readonly challengerRepository: ChallengerRepository,
    private readonly mailbox: GenerationMailbox,
    private readonly assetVerifier: Pick<AssetStore, "verify">,
    private readonly config: GameServiceConfig = challengerConfig,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly random: () => number = Math.random,
    leaderboardProfiles?: LeaderboardProfileCoordinator,
    promptCardEditor?: PromptCardEditorMailbox,
    private readonly promptCardBlender?: PromptCardBlenderMailbox,
    private readonly promptCardWriter?: PromptCardWriterCoordinator,
  ) {
    this.generationJobPublisher = new GenerationJobPublisher(this.mailbox);
    this.generationSelectionReconciler = new GenerationSelectionReconciler({
      repository: this.gameRepository,
      mailbox: this.mailbox,
      assetVerifier: this.assetVerifier,
      ensureEnqueued: (job) => this.generationJobPublisher.ensure(job),
    });
    this.leaderboardProfileReconciler = new LeaderboardProfileReconciler({
      repository: this.challengerRepository,
      coordinator: leaderboardProfiles,
      createId: this.createId,
      now: this.now,
    });
    this.refillCapacityService = new RefillCapacityService({
      gameRepository: this.gameRepository,
      challengerRepository: this.challengerRepository,
      publisher: this.generationJobPublisher,
      rulesFor: (game) => this.rulesFor(game),
      leaderboardVisualProfile: (state, game) =>
        this.leaderboardProfileReconciler.current(state, game),
      createId: this.createId,
      now: this.now,
      random: this.random,
    });
    this.promptCardReconciler = new PromptCardReconciler({
      repository: this.gameRepository,
      editor: promptCardEditor,
      blender: this.promptCardBlender,
      writer: this.promptCardWriter,
      createId: this.createId,
      now: this.now,
    });
    this.promptDeckService = new PromptDeckService({
      gameRepository: this.gameRepository,
      challengerRepository: this.challengerRepository,
      jobPublisher: this.promptCardReconciler,
      blender: this.promptCardBlender,
      writer: this.promptCardWriter,
      createId: this.createId,
      now: this.now,
    });
    this.gameSettingsService = new GameSettingsService({
      gameRepository: this.gameRepository,
      challengerRepository: this.challengerRepository,
      addRefillCapacity: (state, context) =>
        this.refillCapacityService.plan(state, context),
      ensureJobsEnqueued: (jobs) => this.generationJobPublisher.ensureAll(jobs),
      createId: this.createId,
      now: this.now,
    });
    this.preferenceService = new PreferenceService({
      gameRepository: this.gameRepository,
      challengerRepository: this.challengerRepository,
      addRefillCapacity: (state, context) =>
        this.refillCapacityService.plan(state, context),
      ensureJobsEnqueued: (jobs) => this.generationJobPublisher.ensureAll(jobs),
      now: this.now,
    });
    this.preparedSelectionReconciler = new PreparedSelectionReconciler({
      gameRepository: this.gameRepository,
      challengerRepository: this.challengerRepository,
      initialRating: this.config.initialRating,
      eloKFactor: this.config.eloKFactor,
      fallbackDelayMs: this.config.fallbackDelayMs,
      now: this.now,
      random: this.random,
      rulesFor: (game) => this.rulesFor(game),
    });
    this.refillResultReconciler = new RefillResultReconciler({
      gameRepository: this.gameRepository,
      challengerRepository: this.challengerRepository,
      mailbox: this.mailbox,
      assetVerifier: this.assetVerifier,
      initialRating: this.config.initialRating,
      turnaroundEmaAlpha: this.config.turnaroundEmaAlpha,
      ensureEnqueued: (job) => this.generationJobPublisher.ensure(job),
      completePreparedSelection: (game, challengers) =>
        this.preparedSelectionReconciler.complete(game, challengers),
      removeDisplayedCandidatesFromReady: (game, challengers) =>
        this.preparedSelectionReconciler.removeDisplayedCandidatesFromReady(
          game,
          challengers,
        ),
    });
  }

  async assertIdle(): Promise<void> {
    await this.gameRepository.withLock(async () => {
      if ((await this.gameRepository.load())?.round.status === "generating") {
        throw new SelectionConflictError(
          "A challenger is already being generated",
        );
      }
    });
  }

  async dismissGenerationNotice(): Promise<GameState> {
    return this.gameSettingsService.dismissGenerationNotice();
  }

  async savePreferencePreset(
    name: string,
    profile: PreferenceProfile,
  ): Promise<GameState> {
    return this.gameSettingsService.savePreferencePreset(name, profile);
  }

  async deletePreferencePreset(presetId: string): Promise<GameState> {
    return this.gameSettingsService.deletePreferencePreset(presetId);
  }

  async updateGameRules(rules: GameRules): Promise<GameState> {
    return this.gameSettingsService.updateGameRules(rules);
  }

  async createPromptCard(input: CreatePromptCardInput): Promise<GameState> {
    return this.promptDeckService.create(input);
  }

  async requestPromptCardBlend(
    cardIds: [string, string],
    ratio: number,
  ): Promise<GameState> {
    return this.promptDeckService.requestBlend(cardIds, ratio);
  }

  async requestPromptCardWriter(candidateIds: string[]): Promise<GameState> {
    return this.promptDeckService.requestWriter(candidateIds);
  }

  async updatePromptDeck(
    update:
      | { kind: "deck"; enabled: boolean }
      | { kind: "card"; cardId: string; active?: boolean; weight?: number }
      | {
          kind: "suggestion";
          suggestionId: string;
          action: "accept" | "discard";
        },
  ): Promise<GameState> {
    return this.promptDeckService.update(update);
  }

  async updatePreferenceSeed(
    preferenceSeed: string,
    preferenceProfile: PreferenceProfile = preferenceProfileFromSeed(
      preferenceSeed,
    ),
    expectedPreferenceProfile?: PreferenceProfile,
    variationSourceCandidateId?: string | null,
  ): Promise<GameState> {
    return this.preferenceService.update(
      preferenceSeed,
      preferenceProfile,
      expectedPreferenceProfile,
      variationSourceCandidateId,
    );
  }

  async select(
    winnerSide: Side,
    expectedRoundNumber: number,
  ): Promise<GameState> {
    return this.withStateLocks(async () => {
      const current = await this.gameRepository.load();
      if (!current) {
        throw new MissingGameError("Start a game before choosing an image");
      }
      if (current.round.roundNumber !== expectedRoundNumber) {
        throw new SelectionConflictError(
          "The round changed before this selection arrived",
        );
      }

      const challengerState = await this.challengerRepository.load();
      if (!challengerState) {
        throw new MissingGameError(
          "Start a game before choosing a buffered challenger",
        );
      }

      const selectedAt = this.now();
      const rules = this.rulesFor(current);
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
      let nextChallengers = recordComparison(
        {
          ...challengerState,
          pendingSelectionBaseline:
            this.preparedSelectionReconciler.baseline(challengerState),
        },
        retainedWinner,
        rejectedCandidate,
        comparisonReceipt(current, winnerSide, selectedAt),
        { ...this.config, poolMaximum: rules.poolMaximum },
      );
      let preparedReadyHeads: BufferedCandidate[] = [];
      let nextGame = inFlight;
      if (retirement) {
        if (nextChallengers.ready.length >= 2) {
          preparedReadyHeads = nextChallengers.ready.slice(0, 2);
          const leftDraw = popReady(nextChallengers);
          const rightDraw = popReady(leftDraw.state);
          nextChallengers = rightDraw.state;
          nextGame = completeChampionRetirement(
            inFlight,
            leftDraw.candidate!,
            rightDraw.candidate!,
          );
        }
      } else {
        let draw = popReady(nextChallengers);
        if (draw.candidate) {
          preparedReadyHeads = nextChallengers.ready.slice(0, 1);
          nextChallengers = draw.state;
          nextGame = completeSelection(inFlight, draw.candidate);
        } else {
          draw = this.drawFallback(nextChallengers, current);
          nextChallengers = draw.state;
          if (draw.candidate)
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
      const capacity = this.refillCapacityService.plan(nextChallengers, {
        game: nextGame,
        winnerSide,
        retainedWinner,
        rejectedCandidate,
      });
      const durableChallengers =
        preparedReadyHeads.length > 0
          ? {
              ...capacity.state,
              ready: [...preparedReadyHeads, ...capacity.state.ready],
            }
          : capacity.state;
      // Persist a replayable selection before committing either side of the
      // cross-repository transition. A prepared FIFO head remains durable
      // until the completed game round is safely stored.
      await this.gameRepository.save(
        recordPromptCardDecision(
          inFlight,
          [retainedWinner],
          [rejectedCandidate],
          selectedAt,
          "Selected comparison winner",
        ),
      );
      await this.challengerRepository.save(durableChallengers);
      await this.gameRepository.save(nextGame);
      nextGame = await this.promptCardReconciler.reconcileEditor(nextGame);
      if (nextGame.round.status === "idle") {
        await this.challengerRepository.save({
          ...capacity.state,
          pendingComparison: null,
          pendingSelectionBaseline: null,
        });
      }
      await this.generationJobPublisher.ensureAll(capacity.jobs);
      return nextGame;
    });
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
    return this.withStateLocks(async () => {
      const current = await this.gameRepository.load();
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

      const challengerState = await this.challengerRepository.load();
      if (!challengerState) {
        throw new MissingGameError(
          "Start a game before replacing tied candidates",
        );
      }

      const selectedAt = this.now();
      const referenceSide = tieReferenceSide(
        current,
        challengerState,
        this.config.initialRating,
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
          this.preparedSelectionReconciler.baseline(challengerState),
      };
      let nextChallengers =
        outcome === "tie"
          ? recordTie(baseline, left, right, receipt, {
              ...this.config,
              poolMaximum: this.rulesFor(current).poolMaximum,
            })
          : recordBothLose(
              baseline,
              left,
              right,
              receipt,
              this.config.initialRating,
            );
      let preparedReadyHeads: BufferedCandidate[] = [];
      let nextGame = inFlight;
      const replacements =
        this.preparedSelectionReconciler.drawPairReplacements(
          nextChallengers,
          current,
        );
      nextChallengers = replacements.state;
      if (replacements.candidates) {
        preparedReadyHeads = replacements.readyHeads;
        nextGame =
          outcome === "tie"
            ? completeTie(inFlight, ...replacements.candidates)
            : completeBothLose(inFlight, ...replacements.candidates);
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
      const capacity = this.refillCapacityService.plan(nextChallengers, {
        game: nextGame,
        winnerSide: referenceSide,
        retainedWinner: reference,
        rejectedCandidate: contrasted,
        comparisonOutcome: outcome,
      });
      const durableChallengers =
        preparedReadyHeads.length > 0
          ? {
              ...capacity.state,
              ready: [...preparedReadyHeads, ...capacity.state.ready],
            }
          : capacity.state;
      await this.gameRepository.save(
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
      await this.challengerRepository.save(durableChallengers);
      await this.gameRepository.save(nextGame);
      nextGame = await this.promptCardReconciler.reconcileEditor(nextGame);
      if (nextGame.round.status === "idle") {
        await this.challengerRepository.save({
          ...capacity.state,
          pendingComparison: null,
          pendingSelectionBaseline: null,
        });
      }
      await this.generationJobPublisher.ensureAll(capacity.jobs);
      return nextGame;
    });
  }

  async ensureRefillCapacity(): Promise<void> {
    await this.refillCapacityService.ensure();
  }

  async reconcile(): Promise<GameState | null> {
    if (this.reconciliation) return this.reconciliation;

    const reconciliation = this.withStateLocks(() => this.reconcileLocked());
    this.reconciliation = reconciliation;
    try {
      return await reconciliation;
    } finally {
      if (this.reconciliation === reconciliation) this.reconciliation = null;
    }
  }

  private async reconcileLocked(): Promise<GameState | null> {
    let game = await this.gameRepository.load();
    if (!game) return null;

    game = await this.generationSelectionReconciler.cleanup(game);

    game = await this.promptCardReconciler.reconcile(game);

    if (
      game.round.status === "generating" &&
      game.pendingSelection?.kind === "generation"
    ) {
      return this.generationSelectionReconciler.reconcile(game);
    }

    let challengers = await this.challengerRepository.load();
    if (!challengers) return game;

    const backfilled = backfillGeneratedPool(
      challengers,
      this.rulesFor(game).poolMaximum,
    );
    if (backfilled !== challengers) {
      challengers = backfilled;
      await this.challengerRepository.save(challengers);
    }

    challengers = await this.leaderboardProfileReconciler.reconcile(
      game,
      challengers,
    );

    challengers = await this.preparedSelectionReconciler.prepare(
      game,
      challengers,
    );

    const prepared = await this.preparedSelectionReconciler.complete(
      game,
      challengers,
    );
    game = prepared.game;
    challengers =
      await this.preparedSelectionReconciler.removeDisplayedCandidatesFromReady(
        prepared.game,
        prepared.challengers,
      );

    const refills = await this.refillResultReconciler.reconcile(
      game,
      challengers,
    );
    game = refills.game;
    challengers = refills.challengers;

    if (
      game.round.status === "generating" &&
      game.pendingSelection?.kind === "buffer"
    ) {
      let draw = popReady(challengers);
      if (!draw.candidate) draw = this.drawFallback(challengers, game);
      challengers = draw.state;
      if (draw.candidate) {
        const adapted = applyAdaptivePreferences(
          completeSelection(game, draw.candidate),
          challengers,
        );
        game = adapted.game;
        challengers = adapted.challengers;
        await this.gameRepository.save(game);
        challengers = {
          ...challengers,
          pendingComparison: null,
          pendingSelectionBaseline: null,
        };
        await this.challengerRepository.save(challengers);
      }
    }

    const context = refillContext(game, challengers);
    if (context) {
      const capacity = this.refillCapacityService.plan(challengers, context);
      challengers = capacity.state;
      if (capacity.jobs.length > 0) {
        await this.challengerRepository.save(challengers);
        await this.generationJobPublisher.ensureAll(capacity.jobs);
      }
    }

    return game;
  }

  private drawFallback(
    state: ChallengerState,
    game: GameState,
  ): ReturnType<typeof drawFallback> {
    const recentCandidateIds = game.history
      .slice(-10)
      .flatMap((decision) =>
        decision.outcome === "tie" || decision.outcome === "both-lose"
          ? [decision.leftId, decision.rightId]
          : [decision.winnerId, decision.loserId],
      );
    return drawFallback(state, {
      now: this.now(),
      currentCandidateIds: [
        game.round.leftCandidate.id,
        game.round.rightCandidate.id,
      ],
      recentCandidateIds,
      random: this.random,
      delayMs: this.config.fallbackDelayMs,
      maximumConsecutiveDraws: this.rulesFor(game).fallbackMaximumConsecutive,
    });
  }

  private rulesFor(game: GameState): GameRules {
    return effectiveGameRules(game, this.config);
  }

  private withStateLocks<T>(operation: () => Promise<T>): Promise<T> {
    return this.gameRepository.withLock(() =>
      this.challengerRepository.withLock(operation),
    );
  }
}
