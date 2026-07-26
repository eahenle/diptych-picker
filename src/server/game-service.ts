import { isDeepStrictEqual } from "node:util";
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
  type PreferencePreset,
  type Side,
} from "@/domain/game";
import {
  recordPromptCardDecision,
  type CreatePromptCardInput,
} from "@/domain/prompt-deck";
import type {
  GenerationJob,
  GenerationMailbox,
  PromptCardBlenderMailbox,
  PromptCardEditorMailbox,
} from "./agent-mailbox";
import type { ChallengerRepository } from "./challenger-repository";
import { challengerConfig } from "./challenger-config";
import {
  appendPreferenceRevision,
  applyAdaptivePreferences,
} from "./game-adaptation";
import {
  GameRulesError,
  MissingGameError,
  PreferencePresetLimitError,
  SelectionConflictError,
} from "./game-service-errors";
import {
  comparisonReceipt,
  recordBothLose,
  recordComparison,
  recordTie,
  tieReferenceSide,
} from "./game-comparison";
import {
  planRefillCapacity,
  refillContext,
  type RefillCapacityResult,
  type RefillContext,
} from "./game-refill";
import { effectiveGameRules, validGameRules } from "./game-rules";
import { GenerationSelectionReconciler } from "./generation-selection-reconciler";
import { LeaderboardProfileReconciler } from "./leaderboard-profile-reconciler";
import type { LeaderboardProfileCoordinator } from "./leaderboard-profile-service";
import { PromptCardReconciler } from "./prompt-card-reconciler";
import type { PromptCardWriterCoordinator } from "./prompt-card-writer-service";
import { PromptDeckService } from "./prompt-deck-service";
import { PreparedSelectionReconciler } from "./prepared-selection-reconciler";
import type { AssetStore } from "./providers";
import { RefillResultReconciler } from "./refill-result-reconciler";
import type { GameRepository } from "./repository";

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
  private readonly generationSelectionReconciler: GenerationSelectionReconciler;
  private readonly leaderboardProfileReconciler: LeaderboardProfileReconciler;
  private readonly promptCardReconciler: PromptCardReconciler;
  private readonly promptDeckService: PromptDeckService;
  private readonly preparedSelectionReconciler: PreparedSelectionReconciler;
  private readonly refillResultReconciler: RefillResultReconciler;

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
    this.generationSelectionReconciler = new GenerationSelectionReconciler({
      repository: this.gameRepository,
      mailbox: this.mailbox,
      assetVerifier: this.assetVerifier,
      ensureEnqueued: (job) => this.ensureEnqueued(job),
    });
    this.leaderboardProfileReconciler = new LeaderboardProfileReconciler({
      repository: this.challengerRepository,
      coordinator: leaderboardProfiles,
      createId: this.createId,
      now: this.now,
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
      ensureEnqueued: (job) => this.ensureEnqueued(job),
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
    return this.gameRepository.withLock(async () => {
      const current = await this.gameRepository.load();
      if (!current) {
        throw new MissingGameError("Start a game before dismissing a notice");
      }
      const updated = this.withoutGenerationNotice(current);
      if (updated !== current) await this.gameRepository.save(updated);
      return updated;
    });
  }

  async savePreferencePreset(
    name: string,
    profile: PreferenceProfile,
  ): Promise<GameState> {
    return this.gameRepository.withLock(async () => {
      const current = await this.gameRepository.load();
      if (!current) {
        throw new MissingGameError("Start a game before saving a preset");
      }
      const normalizedName = name.trim();
      const presets = current.preferencePresets ?? [];
      const existing = presets.find(
        (preset) => preset.name.toLowerCase() === normalizedName.toLowerCase(),
      );
      if (!existing && presets.length >= 20) {
        throw new PreferencePresetLimitError(
          "Delete a preset before saving another (maximum 20).",
        );
      }
      const updatedAt = this.now();
      const reusableProfile: PreferenceProfile = {
        ...profile,
        adaptationLastDecision: 0,
        adaptationSourceWinnerIds: [],
        adaptationSourceRejectedIds: [],
      };
      const preset: PreferencePreset = {
        id: existing?.id ?? this.createId(),
        name: normalizedName,
        createdAt: existing?.createdAt ?? updatedAt,
        updatedAt,
        profile: reusableProfile,
      };
      const updated: GameState = {
        ...current,
        preferencePresets: existing
          ? presets.map((item) => (item.id === existing.id ? preset : item))
          : [...presets, preset],
      };
      await this.gameRepository.save(updated);
      return updated;
    });
  }

  async deletePreferencePreset(presetId: string): Promise<GameState> {
    return this.gameRepository.withLock(async () => {
      const current = await this.gameRepository.load();
      if (!current) {
        throw new MissingGameError("Start a game before deleting a preset");
      }
      const preferencePresets = (current.preferencePresets ?? []).filter(
        (preset) => preset.id !== presetId,
      );
      if (preferencePresets.length === current.preferencePresets?.length) {
        return current;
      }
      const updated: GameState = { ...current, preferencePresets };
      await this.gameRepository.save(updated);
      return updated;
    });
  }

  async updateGameRules(rules: GameRules): Promise<GameState> {
    if (!validGameRules(rules)) {
      throw new GameRulesError("One or more game rules are out of range.");
    }
    return this.withStateLocks(async () => {
      const [current, challengers] = await Promise.all([
        this.gameRepository.load(),
        this.challengerRepository.load(),
      ]);
      if (!current || !challengers) {
        throw new MissingGameError("Start a game before editing its rules");
      }
      const updated: GameState = {
        ...current,
        gameRules: { ...rules },
      };
      let nextChallengers = backfillGeneratedPool(
        challengers,
        rules.poolMaximum,
      );
      const context = refillContext(updated, nextChallengers);
      const capacity = context
        ? this.addRefillCapacity(nextChallengers, context)
        : { state: nextChallengers, jobs: [] };
      nextChallengers = capacity.state;
      await this.gameRepository.save(updated);
      if (nextChallengers !== challengers) {
        await this.challengerRepository.save(nextChallengers);
      }
      await this.ensureJobsEnqueued(capacity.jobs);
      return updated;
    });
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
    return this.withStateLocks(async () => {
      const [current, challengers] = await Promise.all([
        this.gameRepository.load(),
        this.challengerRepository.load(),
      ]);
      if (!current) {
        throw new MissingGameError("Start a game before editing preferences");
      }
      if (
        expectedPreferenceProfile !== undefined &&
        !isDeepStrictEqual(
          current.preferenceProfile ??
            preferenceProfileFromSeed(current.preferenceSeed),
          expectedPreferenceProfile,
        )
      ) {
        throw new SelectionConflictError(
          "Preferences changed while this editor was open. Reopen Preferences and try again.",
        );
      }
      if (current.round.status === "generating") {
        throw new SelectionConflictError(
          "A challenger is already being generated",
        );
      }

      const variationSource = this.resolveVariationSource(
        current,
        challengers,
        variationSourceCandidateId,
      );
      const profileChanged = !isDeepStrictEqual(
        current.preferenceProfile ??
          preferenceProfileFromSeed(current.preferenceSeed),
        preferenceProfile,
      );
      const variationSourceChanged =
        current.variationSource?.candidateId !== variationSource?.candidateId;
      const preferenceRevisions =
        profileChanged || variationSourceChanged
          ? appendPreferenceRevision(
              current,
              preferenceProfile,
              variationSource ? "variation" : "manual",
              this.now(),
              variationSource,
            )
          : current.preferenceRevisions;
      const updated = this.withoutGenerationNotice({
        ...current,
        preferenceSeed,
        preferenceProfile,
        ...(preferenceRevisions ? { preferenceRevisions } : {}),
        ...(variationSource ? { variationSource } : {}),
      });
      if (!variationSource) delete updated.variationSource;
      await this.gameRepository.save(updated);
      const generationPreferencesChanged =
        current.preferenceSeed !== preferenceSeed ||
        (current.preferenceProfile?.adaptationMode ?? "static") !==
          preferenceProfile.adaptationMode ||
        (current.preferenceProfile?.adaptationStrength ?? "guided") !==
          (preferenceProfile.adaptationStrength ?? "guided") ||
        current.variationSource?.candidateId !==
          updated.variationSource?.candidateId;
      if (!challengers || !generationPreferencesChanged) {
        return updated;
      }

      // Ready candidates and completed refill results were proposed against
      // the previous brief. Keep unfinished records until their workers reach
      // a terminal state, but exclude them from replacement capacity and
      // discard their eventual results during reconciliation.
      let refreshed: ChallengerState = { ...challengers, ready: [] };
      const context = refillContext(updated, refreshed);
      const capacity: RefillCapacityResult = context
        ? this.addRefillCapacity(refreshed, context)
        : { state: refreshed, jobs: [] };
      refreshed = capacity.state;
      await this.challengerRepository.save(refreshed);
      await this.ensureJobsEnqueued(capacity.jobs);
      return updated;
    });
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
      const capacity = this.addRefillCapacity(nextChallengers, {
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
      await this.ensureJobsEnqueued(capacity.jobs);
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
      const capacity = this.addRefillCapacity(nextChallengers, {
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
      await this.ensureJobsEnqueued(capacity.jobs);
      return nextGame;
    });
  }

  async ensureRefillCapacity(): Promise<void> {
    await this.withStateLocks(async () => {
      const [game, challengers] = await Promise.all([
        this.gameRepository.load(),
        this.challengerRepository.load(),
      ]);
      if (!game || !challengers) return;

      const context = refillContext(game, challengers);
      if (!context) return;
      const capacity = this.addRefillCapacity(challengers, context);
      if (capacity.jobs.length === 0) return;
      await this.challengerRepository.save(capacity.state);
      await this.ensureJobsEnqueued(capacity.jobs);
    });
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
      const capacity = this.addRefillCapacity(challengers, context);
      challengers = capacity.state;
      if (capacity.jobs.length > 0) {
        await this.challengerRepository.save(challengers);
        await this.ensureJobsEnqueued(capacity.jobs);
      }
    }

    return game;
  }

  private addRefillCapacity(
    state: ChallengerState,
    context: RefillContext,
  ): RefillCapacityResult {
    return planRefillCapacity(state, context, {
      bufferTarget: this.rulesFor(context.game).bufferTarget,
      leaderboardVisualProfile: this.leaderboardProfileReconciler.current(
        state,
        context.game,
      ),
      createId: this.createId,
      now: this.now,
      random: this.random,
    });
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

  private resolveVariationSource(
    game: GameState,
    challengers: ChallengerState | null,
    candidateId: string | null | undefined,
  ) {
    if (candidateId === undefined) return game.variationSource;
    if (candidateId === null) return undefined;
    const candidates = [
      game.round.leftCandidate,
      game.round.rightCandidate,
      ...(challengers?.ratings.map(({ candidate }) => candidate) ?? []),
    ];
    const source = candidates.find((candidate) => candidate.id === candidateId);
    if (!source) {
      throw new SelectionConflictError(
        "That variation source is no longer available in this game.",
      );
    }
    return { candidateId: source.id, concept: source.concept };
  }

  private async ensureJobsEnqueued(jobs: readonly GenerationJob[]) {
    for (const job of jobs) await this.ensureEnqueued(job);
  }

  private async ensureEnqueued(job: GenerationJob): Promise<void> {
    try {
      await this.mailbox.enqueue(job);
    } catch (error) {
      const work = await this.mailbox.readWork(job.id);
      if (work && this.sameJob(work, job)) return;
      throw error;
    }
  }

  private sameJob(left: GenerationJob, right: GenerationJob): boolean {
    return isDeepStrictEqual(left, right);
  }

  private withoutGenerationNotice(game: GameState): GameState {
    if (!game.generationNotice) return game;
    const updated = { ...game };
    delete updated.generationNotice;
    return updated;
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
