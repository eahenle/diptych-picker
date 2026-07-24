import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  drawFallback,
  drawFallbackBatch,
  popReady,
  backfillGeneratedPool,
  recordGenerationTurnaround,
  refillJobMatchesGenerationPreferences,
  type BufferedCandidate,
  type ChallengerState,
  type PendingComparisonReceipt,
  type PendingSelectionBaseline,
  type RefillJobRecord,
} from "@/domain/challenger-state";
import {
  beginChampionRetirement,
  beginBothLose,
  beginBufferedSelection,
  beginTie,
  applyWinnerPreferenceRevision,
  candidateAt,
  composePreferenceSeed,
  completeChampionRetirement,
  completeBothLose,
  completeSelection,
  completeTie,
  failSelection,
  oppositeSide,
  recentConcepts,
  recordRejectedPreferenceEvidence,
  preferenceProfileFromSeed,
  willRetireChampion,
  type Candidate,
  type GameRules,
  type GameState,
  type PreferenceProfile,
  type PreferencePreset,
  type PreferenceProfileSnapshot,
  type Side,
} from "@/domain/game";
import {
  createPromptCardBlendRequest,
  createPromptCard as createPromptCardRecord,
  emptyPromptDeck,
  recordPromptCardDecision,
  type CreatePromptCardInput,
} from "@/domain/prompt-deck";
import type {
  GenerationJob,
  GenerationMailbox,
  GenerationResult,
  PromptCardBlenderMailbox,
  PromptCardEditorMailbox,
} from "./agent-mailbox";
import type { ChallengerRepository } from "./challenger-repository";
import { challengerConfig } from "./challenger-config";
import {
  comparisonReceipt,
  createCandidateRating,
  recordBothLose,
  recordComparison,
  recordTie,
  tieReferenceSide,
} from "./game-comparison";
import {
  planRefillCapacity,
  refillContext,
  validRefillWork,
  withoutRefillRecord,
  type RefillCapacityResult,
  type RefillContext,
} from "./game-refill";
import { effectiveGameRules, validGameRules } from "./game-rules";
import { LeaderboardProfileReconciler } from "./leaderboard-profile-reconciler";
import type { LeaderboardProfileCoordinator } from "./leaderboard-profile-service";
import { PromptCardReconciler } from "./prompt-card-reconciler";
import type { PromptCardWriterCoordinator } from "./prompt-card-writer-service";
import type { AssetStore } from "./providers";
import type { GameRepository } from "./repository";

export class SelectionConflictError extends Error {}
export class MissingGameError extends Error {}
export class PreferencePresetLimitError extends Error {}
export class PromptDeckError extends Error {}
export class GameRulesError extends Error {}

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

interface RefillObservation {
  record: RefillJobRecord;
  work: GenerationJob | null;
  result: GenerationResult | null;
  recordIndex: number;
}

export class GameService {
  private reconciliation: Promise<GameState | null> | null = null;
  private readonly leaderboardProfileReconciler: LeaderboardProfileReconciler;
  private readonly promptCardReconciler: PromptCardReconciler;

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
    return this.gameRepository.withLock(async () => {
      const current = await this.gameRepository.load();
      if (!current) {
        throw new MissingGameError("Start a game before creating prompt cards");
      }
      const promptDeck = current.promptDeck ?? emptyPromptDeck();
      if (promptDeck.cards.length >= 50) {
        throw new PromptDeckError(
          "Archive or reuse a prompt card before adding another (maximum 50).",
        );
      }
      if (
        input.parents?.some(
          (parentId) => !promptDeck.cards.some((card) => card.id === parentId),
        )
      ) {
        throw new PromptDeckError(
          "Every prompt-card parent must exist in the current deck.",
        );
      }
      const updated: GameState = {
        ...current,
        promptDeck: {
          ...promptDeck,
          cards: [
            ...promptDeck.cards,
            createPromptCardRecord(input, this.createId(), this.now()),
          ],
        },
      };
      await this.gameRepository.save(updated);
      return updated;
    });
  }

  async requestPromptCardBlend(
    cardIds: [string, string],
    ratio: number,
  ): Promise<GameState> {
    return this.gameRepository.withLock(async () => {
      const current = await this.gameRepository.load();
      if (!current) {
        throw new MissingGameError("Start a game before blending prompt cards");
      }
      if (!this.promptCardBlender) {
        throw new PromptDeckError("Prompt-card blending is unavailable.");
      }
      const promptDeck = current.promptDeck ?? emptyPromptDeck();
      if (promptDeck.blendJob) {
        throw new PromptDeckError(
          "Wait for the current prompt-card blend before starting another.",
        );
      }
      if (new Set(cardIds).size !== 2) {
        throw new PromptDeckError("Choose two distinct prompt cards to blend.");
      }
      if (!Number.isFinite(ratio) || ratio < 0.1 || ratio > 0.9) {
        throw new PromptDeckError("Blend ratio must be between 10% and 90%.");
      }
      const cards = cardIds.map((cardId) =>
        promptDeck.cards.find((card) => card.id === cardId),
      );
      if (!cards[0] || !cards[1]) {
        throw new PromptDeckError(
          "Both prompt cards must exist in the current deck.",
        );
      }
      const jobId = this.createId();
      const createdAt = this.now();
      const job = createPromptCardBlendRequest(
        [cards[0], cards[1]],
        ratio,
        jobId,
        createdAt,
      );
      const updated: GameState = {
        ...current,
        promptDeck: {
          ...promptDeck,
          blendJob: {
            jobId,
            cardIds,
            enqueuedAt: createdAt,
            expectedJob: job,
          },
        },
      };
      await this.gameRepository.save(updated);
      await this.promptCardReconciler.ensureBlenderEnqueued(job);
      return updated;
    });
  }

  async requestPromptCardWriter(candidateIds: string[]): Promise<GameState> {
    return this.withStateLocks(async () => {
      const [current, challengers] = await Promise.all([
        this.gameRepository.load(),
        this.challengerRepository.load(),
      ]);
      if (!current || !challengers) {
        throw new MissingGameError(
          "Start a game before writing prompt cards from images",
        );
      }
      if (!this.promptCardWriter) {
        throw new PromptDeckError("Prompt-card writing is unavailable.");
      }
      if (
        candidateIds.length < 3 ||
        candidateIds.length > 5 ||
        new Set(candidateIds).size !== candidateIds.length
      ) {
        throw new PromptDeckError(
          "Choose three to five distinct generated favorites.",
        );
      }
      const promptDeck = current.promptDeck ?? emptyPromptDeck();
      if (promptDeck.writerJob) {
        throw new PromptDeckError(
          "Wait for the current image-set draft before starting another.",
        );
      }
      const candidates = candidateIds.map((candidateId) =>
        challengers.ratings.find(
          (rating) => rating.candidate.id === candidateId,
        ),
      );
      if (
        candidates.some(
          (candidate) =>
            !candidate ||
            candidate.source !== "generated" ||
            !candidate.favorite,
        )
      ) {
        throw new PromptDeckError(
          "Prompt-card sources must be current generated favorites.",
        );
      }
      const jobId = this.createId();
      const createdAt = this.now();
      const job = await this.promptCardWriter.prepare(
        jobId,
        createdAt,
        candidates as NonNullable<(typeof candidates)[number]>[],
      );
      const updated: GameState = {
        ...current,
        promptDeck: {
          ...promptDeck,
          writerJob: {
            jobId,
            sourceCandidateIds: [...candidateIds],
            enqueuedAt: createdAt,
            expectedJob: job,
          },
        },
      };
      await this.gameRepository.save(updated);
      await this.promptCardReconciler.ensureWriterEnqueued(job);
      return updated;
    });
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
    return this.gameRepository.withLock(async () => {
      const current = await this.gameRepository.load();
      if (!current) {
        throw new MissingGameError(
          "Start a game before editing the prompt deck",
        );
      }
      const promptDeck = current.promptDeck ?? emptyPromptDeck();
      if (update.kind === "suggestion") {
        const suggestion = (promptDeck.suggestions ?? []).find(
          (item) => item.id === update.suggestionId,
        );
        if (!suggestion) {
          throw new PromptDeckError("That prompt-card suggestion is gone.");
        }
        if (update.action === "accept" && promptDeck.cards.length >= 50) {
          throw new PromptDeckError(
            "Archive or reuse a prompt card before accepting another (maximum 50).",
          );
        }
        const updated: GameState = {
          ...current,
          promptDeck: {
            ...promptDeck,
            cards:
              update.action === "accept"
                ? [
                    ...promptDeck.cards,
                    createPromptCardRecord(
                      {
                        title: suggestion.title,
                        prompt: suggestion.prompt,
                        negativePrompt: suggestion.negativePrompt,
                        weight: 1,
                        tags: suggestion.tags,
                        parents: suggestion.parentCardIds ?? [
                          ...(suggestion.parentCardId
                            ? [suggestion.parentCardId]
                            : []),
                        ],
                        sourceCandidateIds: suggestion.sourceCandidateIds,
                      },
                      this.createId(),
                      this.now(),
                    ),
                  ]
                : promptDeck.cards,
            suggestions: (promptDeck.suggestions ?? []).filter(
              (item) => item.id !== suggestion.id,
            ),
          },
        };
        await this.gameRepository.save(updated);
        return updated;
      }
      if (update.kind === "deck") {
        if (
          update.enabled &&
          !promptDeck.cards.some((card) => card.active && card.weight > 0)
        ) {
          throw new PromptDeckError(
            "Activate at least one prompt card before enabling weighted draws.",
          );
        }
        const updated = {
          ...current,
          promptDeck: { ...promptDeck, enabled: update.enabled },
        };
        await this.gameRepository.save(updated);
        return updated;
      }

      let found = false;
      const cards = promptDeck.cards.map((card) => {
        if (card.id !== update.cardId) return card;
        found = true;
        return {
          ...card,
          ...(update.active !== undefined ? { active: update.active } : {}),
          ...(update.weight !== undefined ? { weight: update.weight } : {}),
        };
      });
      if (!found)
        throw new PromptDeckError("That prompt card no longer exists.");
      const hasActive = cards.some((card) => card.active && card.weight > 0);
      const updated: GameState = {
        ...current,
        promptDeck: {
          ...promptDeck,
          enabled: promptDeck.enabled && hasActive,
          cards,
        },
      };
      await this.gameRepository.save(updated);
      return updated;
    });
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
          ? this.appendPreferenceRevision(
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
            this.pendingSelectionBaseline(challengerState),
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
      const adapted = this.applyAdaptivePreferences(nextGame, nextChallengers);
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
          this.pendingSelectionBaseline(challengerState),
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
      const replacements = this.drawPairReplacements(nextChallengers, current);
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
        const adapted = this.applyAdaptivePreferences(
          nextGame,
          nextChallengers,
        );
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

    if (game.mailboxCleanupJobId) {
      await this.mailbox.archive(game.mailboxCleanupJobId);
      game = this.withoutCleanupMarker(game);
      await this.gameRepository.save(game);
    }

    game = await this.promptCardReconciler.reconcile(game);

    if (
      game.round.status === "generating" &&
      game.pendingSelection?.kind === "generation"
    ) {
      return this.reconcileLegacySelection(game);
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

    challengers = await this.prepareComparison(game, challengers);

    const prepared = await this.completePreparedSelection(game, challengers);
    game = prepared.game;
    challengers = await this.removeDisplayedCandidatesFromReady(
      prepared.game,
      prepared.challengers,
    );

    const observations = await Promise.all(
      challengers.refillJobs.map(async (record, recordIndex) => {
        const [work, result] = await Promise.all([
          this.mailbox.readWork(record.jobId),
          this.mailbox.readResult(record.jobId),
        ]);
        return { record, work, result, recordIndex };
      }),
    );
    observations.sort((left, right) => {
      const leftCompletedAt = left.result
        ? Date.parse(left.result.completedAt)
        : Number.POSITIVE_INFINITY;
      const rightCompletedAt = right.result
        ? Date.parse(right.result.completedAt)
        : Number.POSITIVE_INFINITY;
      return (
        leftCompletedAt - rightCompletedAt ||
        left.recordIndex - right.recordIndex
      );
    });

    for (const observation of observations) {
      const outcome = await this.reconcileRefillRecord(
        game,
        challengers,
        observation,
      );
      game = outcome.game;
      challengers = outcome.challengers;
    }

    if (
      game.round.status === "generating" &&
      game.pendingSelection?.kind === "buffer"
    ) {
      let draw = popReady(challengers);
      if (!draw.candidate) draw = this.drawFallback(challengers, game);
      challengers = draw.state;
      if (draw.candidate) {
        const adapted = this.applyAdaptivePreferences(
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

  private async reconcileRefillRecord(
    game: GameState,
    challengers: ChallengerState,
    observation: RefillObservation,
  ): Promise<{ game: GameState; challengers: ChallengerState }> {
    const { record, work, result } = observation;
    const expected = record.expectedJob;

    if (!refillJobMatchesGenerationPreferences(expected, game)) {
      // Do not interrupt a worker that already owns the old request. Once it
      // terminates, archive the result without admitting it to the ready FIFO.
      if (work && !result) return { game, challengers };
      return {
        game,
        challengers: await this.archiveInvalidRefill(challengers, record),
      };
    }

    if (!result) {
      if (!work) {
        await this.ensureEnqueued(expected);
        return { game, challengers };
      }
      if (
        !validRefillWork(work, record, challengers.sessionId) ||
        !this.sameJob(work, expected)
      ) {
        return {
          game,
          challengers: await this.archiveInvalidRefill(challengers, record),
        };
      }
      return { game, challengers };
    }

    if (
      result.jobId !== record.jobId ||
      !work ||
      !validRefillWork(work, record, challengers.sessionId) ||
      !this.sameJob(work, expected)
    ) {
      return {
        game,
        challengers: await this.archiveInvalidRefill(challengers, record),
      };
    }

    if (result.status === "failed") {
      let notifiedGame = game;
      if (this.isModerationFailure(result)) {
        notifiedGame = {
          ...game,
          generationNotice: {
            kind: "moderation-block",
            jobId: result.jobId,
            occurredAt: result.completedAt,
            occurrenceCount: (game.generationNotice?.occurrenceCount ?? 0) + 1,
          },
        };
        await this.gameRepository.save(notifiedGame);
      }
      return {
        game: notifiedGame,
        challengers: await this.archiveInvalidRefill(challengers, record),
      };
    }

    const generated = this.candidateFromResult(result, expected);
    if (!generated) {
      return {
        game,
        challengers: await this.archiveInvalidRefill(challengers, record),
      };
    }

    const existingRating = challengers.ratings.find(
      ({ candidate }) => candidate.id === generated.id,
    );
    if (existingRating) {
      if (!isDeepStrictEqual(existingRating.candidate, generated)) {
        return {
          game,
          challengers: await this.archiveInvalidRefill(challengers, record),
        };
      }
      const candidateIsReady = challengers.ready.some(
        ({ candidate }) => candidate.id === generated.id,
      );
      const candidateIsDisplayed =
        game.round.leftCandidate.id === generated.id ||
        game.round.rightCandidate.id === generated.id;
      if (!candidateIsReady && !candidateIsDisplayed) {
        return {
          game,
          challengers: await this.archiveInvalidRefill(challengers, record),
        };
      }

      const replayed = await this.completePreparedSelection(game, challengers);
      game = replayed.game;
      challengers = await this.removeDisplayedCandidatesFromReady(
        replayed.game,
        replayed.challengers,
      );
      await this.mailbox.archive(record.jobId);
      const cleaned = withoutRefillRecord(challengers, record.jobId);
      await this.challengerRepository.save(cleaned);
      return { game, challengers: cleaned };
    }

    if (this.candidateIdExists(challengers, game, generated.id)) {
      return {
        game,
        challengers: await this.archiveInvalidRefill(challengers, record),
      };
    }

    try {
      await this.assetVerifier.verify(result.asset);
    } catch {
      return {
        game,
        challengers: await this.archiveInvalidRefill(challengers, record),
      };
    }

    let applied = recordGenerationTurnaround(
      {
        ...challengers,
        ready: [
          ...challengers.ready,
          {
            candidate: generated,
            source: "generated",
            pinnedWinnerId: record.pinnedWinnerId,
            enqueuedAt: result.completedAt,
          },
        ],
        ratings: [
          ...challengers.ratings,
          createCandidateRating(
            generated,
            "generated",
            false,
            this.config.initialRating,
          ),
        ],
      },
      record.enqueuedAt,
      result.completedAt,
      this.config.turnaroundEmaAlpha,
    );

    // Keep the refill record until cleanup succeeds. If archive fails, the
    // rating entry proves this result was already applied on the next pass.
    await this.challengerRepository.save(applied);
    const replayed = await this.completePreparedSelection(game, applied);
    game = replayed.game;
    applied = replayed.challengers;
    await this.mailbox.archive(record.jobId);
    const cleaned = withoutRefillRecord(applied, record.jobId);
    await this.challengerRepository.save(cleaned);
    return { game, challengers: cleaned };
  }

  private async archiveInvalidRefill(
    state: ChallengerState,
    record: RefillJobRecord,
  ): Promise<ChallengerState> {
    await this.mailbox.archive(record.jobId);
    const cleaned = withoutRefillRecord(state, record.jobId);
    await this.challengerRepository.save(cleaned);
    return cleaned;
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

  private async prepareComparison(
    game: GameState,
    challengers: ChallengerState,
  ): Promise<ChallengerState> {
    const pending = game.pendingSelection;
    if (
      game.round.status !== "generating" ||
      !pending ||
      (pending.kind !== "buffer" &&
        pending.kind !== "retirement" &&
        pending.kind !== "tie" &&
        pending.kind !== "both-lose")
    ) {
      if (
        challengers.pendingComparison === null &&
        !challengers.pendingSelectionBaseline
      ) {
        return challengers;
      }
      const cleaned = {
        ...challengers,
        pendingComparison: null,
        pendingSelectionBaseline: null,
      };
      await this.challengerRepository.save(cleaned);
      return cleaned;
    }

    const receipt: PendingComparisonReceipt =
      pending.kind === "tie" || pending.kind === "both-lose"
        ? {
            kind: pending.kind,
            selectedAt: pending.selectedAt,
            roundNumber: game.round.roundNumber,
            leftId: game.round.leftCandidate.id,
            rightId: game.round.rightCandidate.id,
          }
        : comparisonReceipt(game, pending.winnerSide, pending.selectedAt);
    if (isDeepStrictEqual(challengers.pendingComparison, receipt)) {
      return challengers;
    }
    if (challengers.pendingComparison !== null) {
      throw new Error(
        "Persisted comparison receipt does not match the pending selection",
      );
    }

    const baseline = challengers.pendingSelectionBaseline
      ? challengers
      : {
          ...challengers,
          pendingSelectionBaseline: this.pendingSelectionBaseline(challengers),
        };
    const compared =
      pending.kind === "tie"
        ? recordTie(
            baseline,
            game.round.leftCandidate,
            game.round.rightCandidate,
            receipt,
            {
              ...this.config,
              poolMaximum: this.rulesFor(game).poolMaximum,
            },
          )
        : pending.kind === "both-lose"
          ? recordBothLose(
              baseline,
              game.round.leftCandidate,
              game.round.rightCandidate,
              receipt,
              this.config.initialRating,
            )
          : recordComparison(
              baseline,
              candidateAt(game.round, pending.winnerSide),
              candidateAt(game.round, oppositeSide(pending.winnerSide)),
              receipt,
              {
                ...this.config,
                poolMaximum: this.rulesFor(game).poolMaximum,
              },
            );
    await this.challengerRepository.save(compared);
    return compared;
  }

  private async completePreparedSelection(
    game: GameState,
    challengers: ChallengerState,
  ): Promise<{ game: GameState; challengers: ChallengerState }> {
    if (game.round.status !== "generating" || !game.pendingSelection) {
      return { game, challengers };
    }

    if (game.pendingSelection.kind === "retirement") {
      if (challengers.ready.length < 2) return { game, challengers };
      const leftDraw = popReady(challengers);
      const rightDraw = popReady(leftDraw.state);
      const adapted = this.applyAdaptivePreferences(
        completeChampionRetirement(
          game,
          leftDraw.candidate!,
          rightDraw.candidate!,
        ),
        rightDraw.state,
      );
      await this.gameRepository.save(adapted.game);
      const finalized = {
        ...adapted.challengers,
        pendingComparison: null,
        pendingSelectionBaseline: null,
      };
      await this.challengerRepository.save(finalized);
      return { game: adapted.game, challengers: finalized };
    }

    if (
      game.pendingSelection.kind === "tie" ||
      game.pendingSelection.kind === "both-lose"
    ) {
      const outcome = game.pendingSelection.kind;
      const replacements = this.drawPairReplacements(challengers, game);
      if (!replacements.candidates) {
        if (replacements.state !== challengers) {
          await this.challengerRepository.save(replacements.state);
        }
        return { game, challengers: replacements.state };
      }
      const completed =
        outcome === "tie"
          ? completeTie(game, ...replacements.candidates)
          : completeBothLose(game, ...replacements.candidates);
      const adapted =
        outcome === "both-lose"
          ? this.applyAdaptivePreferences(completed, replacements.state)
          : { game: completed, challengers: replacements.state };
      await this.gameRepository.save(adapted.game);
      const finalized = {
        ...adapted.challengers,
        pendingComparison: null,
        pendingSelectionBaseline: null,
      };
      await this.challengerRepository.save(finalized);
      return { game: adapted.game, challengers: finalized };
    }

    if (game.pendingSelection.kind !== "buffer") {
      return { game, challengers };
    }

    let draw = popReady(challengers);
    if (!draw.candidate) {
      const currentIds = new Set([
        game.round.leftCandidate.id,
        game.round.rightCandidate.id,
      ]);
      const preparedFallback = challengers.ratings.find(
        ({ candidate, lastServedAt }) =>
          lastServedAt === game.pendingSelection?.selectedAt &&
          !currentIds.has(candidate.id),
      )?.candidate;
      if (preparedFallback) {
        draw = { candidate: preparedFallback, state: challengers };
      }
    }
    if (!draw.candidate) return { game, challengers };

    const adapted = this.applyAdaptivePreferences(
      completeSelection(game, draw.candidate),
      draw.state,
    );
    await this.gameRepository.save(adapted.game);
    const finalized = {
      ...adapted.challengers,
      pendingComparison: null,
      pendingSelectionBaseline: null,
    };
    if (
      adapted.challengers !== challengers ||
      challengers.pendingComparison !== null
    ) {
      await this.challengerRepository.save(finalized);
    }
    return { game: adapted.game, challengers: finalized };
  }

  private applyAdaptivePreferences(
    game: GameState,
    challengers: ChallengerState,
  ): { game: GameState; challengers: ChallengerState } {
    const selection = game.history.at(-1);
    const profile = game.preferenceProfile;
    if (
      !selection ||
      selection.outcome === "tie" ||
      !profile ||
      profile.adaptationMode !== "adaptive"
    ) {
      return { game, challengers };
    }
    let nextProfile = profile;
    if (selection.outcome === "both-lose") {
      for (const rejectedId of [selection.leftId, selection.rightId]) {
        const rejected = challengers.ratings.find(
          ({ candidate }) => candidate.id === rejectedId,
        );
        if (rejected?.source === "generated") {
          nextProfile = recordRejectedPreferenceEvidence(
            nextProfile,
            rejected.candidate.id,
          );
        }
      }
    } else {
      const winner = challengers.ratings.find(
        ({ candidate }) => candidate.id === selection.winnerId,
      );
      const rejected = challengers.ratings.find(
        ({ candidate }) => candidate.id === selection.loserId,
      );
      nextProfile = winner
        ? applyWinnerPreferenceRevision(
            profile,
            winner.candidate,
            game.history.length,
          )
        : profile;
      if (rejected?.source === "generated") {
        nextProfile = recordRejectedPreferenceEvidence(
          nextProfile,
          rejected.candidate.id,
        );
      }
    }
    if (nextProfile === profile) return { game, challengers };
    const composedProfile = composePreferenceSeed(profile);
    const composedNextProfile = composePreferenceSeed(nextProfile);
    const preferenceSeed =
      composedNextProfile === composedProfile
        ? game.preferenceSeed
        : composedNextProfile;
    const preferenceRevisions =
      preferenceSeed === game.preferenceSeed
        ? game.preferenceRevisions
        : this.appendPreferenceRevision(
            game,
            nextProfile,
            "adaptive",
            selection.selectedAt,
            game.variationSource,
          );
    return {
      game: {
        ...game,
        preferenceProfile: nextProfile,
        preferenceSeed,
        ...(preferenceRevisions ? { preferenceRevisions } : {}),
      },
      challengers:
        preferenceSeed === game.preferenceSeed
          ? challengers
          : { ...challengers, ready: [] },
    };
  }

  private async removeDisplayedCandidatesFromReady(
    game: GameState,
    challengers: ChallengerState,
  ): Promise<ChallengerState> {
    if (game.round.status !== "idle") return challengers;
    const displayedIds = new Set([
      game.round.leftCandidate.id,
      game.round.rightCandidate.id,
    ]);
    const ready = challengers.ready.filter(
      ({ candidate }) => !displayedIds.has(candidate.id),
    );
    if (ready.length === challengers.ready.length) return challengers;
    const cleaned = { ...challengers, ready };
    await this.challengerRepository.save(cleaned);
    return cleaned;
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

  private drawPairReplacements(
    state: ChallengerState,
    game: GameState,
  ): {
    candidates: [Candidate, Candidate] | null;
    readyHeads: BufferedCandidate[];
    state: ChallengerState;
  } {
    const readyHeads = state.ready.slice(0, 2);
    const fallbackCount = 2 - readyHeads.length;
    if (fallbackCount === 0) {
      const leftDraw = popReady(state);
      const rightDraw = popReady(leftDraw.state);
      return {
        candidates: [leftDraw.candidate!, rightDraw.candidate!],
        readyHeads,
        state: rightDraw.state,
      };
    }

    const recentCandidateIds = game.history
      .slice(-10)
      .flatMap((decision) =>
        decision.outcome === "tie" || decision.outcome === "both-lose"
          ? [decision.leftId, decision.rightId]
          : [decision.winnerId, decision.loserId],
      );
    const fallback = drawFallbackBatch(
      state,
      {
        now: this.now(),
        currentCandidateIds: [
          game.round.leftCandidate.id,
          game.round.rightCandidate.id,
          ...readyHeads.map(({ candidate }) => candidate.id),
        ],
        recentCandidateIds,
        random: this.random,
        delayMs: this.config.fallbackDelayMs,
        maximumConsecutiveDraws: this.rulesFor(game).fallbackMaximumConsecutive,
      },
      fallbackCount,
    );
    if (fallback.candidates.length < fallbackCount) {
      return { candidates: null, readyHeads: [], state: fallback.state };
    }

    return {
      candidates: [
        ...readyHeads.map(({ candidate }) => candidate),
        ...fallback.candidates,
      ] as [Candidate, Candidate],
      readyHeads,
      state: {
        ...fallback.state,
        ready: fallback.state.ready.slice(readyHeads.length),
      },
    };
  }

  private pendingSelectionBaseline(
    state: ChallengerState,
  ): PendingSelectionBaseline {
    return {
      ready: state.ready,
      ratings: state.ratings,
      generationTurnaroundEmaMs: state.generationTurnaroundEmaMs,
      consecutiveFallbackDraws: state.consecutiveFallbackDraws,
      nextFallbackAt: state.nextFallbackAt,
    };
  }

  private candidateFromResult(
    result: Extract<GenerationResult, { status: "completed" }>,
    expectedJob?: Pick<
      GenerationJob,
      "preferenceSeed" | "promptCard" | "variationSource"
    >,
  ): Candidate | null {
    const expectedCandidateId = `challenger-${result.jobId}`;
    if (result.asset.candidateId !== expectedCandidateId) return null;
    return {
      id: result.asset.candidateId,
      imageUrl: result.asset.imageUrl,
      prompt: result.proposal.visualPrompt,
      concept: result.proposal.concept,
      style: result.proposal.styleTags,
      reasoningSummary: result.proposal.reasoningSummary,
      preferenceRevision: result.proposal.preferenceRevision,
      ...(expectedJob?.promptCard
        ? { promptCardId: expectedJob.promptCard.id }
        : {}),
      ...(expectedJob?.variationSource
        ? {
            lineage: {
              kind: "variation" as const,
              parentCandidateId: expectedJob.variationSource.candidateId,
              parentConcept: expectedJob.variationSource.concept,
              preferenceFingerprint: createHash("sha256")
                .update(expectedJob.preferenceSeed)
                .digest("hex"),
            },
          }
        : {}),
      createdAt: result.completedAt,
      winCount: 0,
    };
  }

  private candidateIdExists(
    state: ChallengerState,
    game: GameState,
    candidateId: string,
  ): boolean {
    return (
      game.round.leftCandidate.id === candidateId ||
      game.round.rightCandidate.id === candidateId ||
      state.ready.some(({ candidate }) => candidate.id === candidateId) ||
      state.ratings.some(({ candidate }) => candidate.id === candidateId)
    );
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

  private appendPreferenceRevision(
    game: GameState,
    profile: PreferenceProfile,
    source: PreferenceProfileSnapshot["source"],
    createdAt: string,
    variationSource = game.variationSource,
  ): PreferenceProfileSnapshot[] {
    const previous = game.preferenceRevisions ?? [];
    const baseline: PreferenceProfileSnapshot[] =
      previous.length > 0
        ? previous
        : [
            {
              createdAt,
              source: "initial",
              profile:
                game.preferenceProfile ??
                preferenceProfileFromSeed(game.preferenceSeed),
              ...(game.variationSource
                ? { variationSource: game.variationSource }
                : {}),
            },
          ];
    return [
      ...baseline,
      {
        createdAt,
        source,
        profile,
        ...(variationSource ? { variationSource } : {}),
      },
    ].slice(-25);
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

  private isModerationFailure(
    result: Extract<GenerationResult, { status: "failed" }>,
  ): boolean {
    return (
      result.category === "moderation" ||
      /moderation|content policy|safety (?:policy|filter)|blocked by (?:a )?(?:policy|safety)/i.test(
        result.message,
      )
    );
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

  private async reconcileLegacySelection(
    current: GameState,
  ): Promise<GameState> {
    const pending = current.pendingSelection;
    if (pending?.kind !== "generation") return current;

    const expectedJob = this.legacyGenerationJob(current);
    const result = await this.mailbox.readResult(pending.generationJobId);
    if (!result) {
      await this.ensureEnqueued(expectedJob);
      return current;
    }
    if (result.jobId !== pending.generationJobId) return current;

    const actualWork = await this.mailbox.readWork(pending.generationJobId);
    let terminal: GameState;
    if (!actualWork || !this.sameJob(actualWork, expectedJob)) {
      terminal = failSelection(
        current,
        "Generation failed: Work metadata does not match the persisted selection",
      );
    } else if (result.status === "failed") {
      terminal = failSelection(current, `Generation failed: ${result.message}`);
    } else {
      const generated = this.candidateFromResult(result);
      if (!generated || this.candidateIdExistsInRound(current, generated.id)) {
        terminal = failSelection(
          current,
          "Generation failed: Challenger result is invalid or collides with the current round",
        );
      } else {
        try {
          await this.assetVerifier.verify(result.asset);
          terminal = completeSelection(current, generated);
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Asset verification failed";
          terminal = failSelection(
            current,
            `Generation failed: Asset verification failed: ${message}`,
          );
        }
      }
    }

    const awaitingCleanup = {
      ...terminal,
      mailboxCleanupJobId: pending.generationJobId,
    };
    await this.gameRepository.save(awaitingCleanup);
    await this.mailbox.archive(pending.generationJobId);
    const cleaned = this.withoutCleanupMarker(awaitingCleanup);
    await this.gameRepository.save(cleaned);
    return cleaned;
  }

  private legacyGenerationJob(state: GameState): GenerationJob {
    const pending = state.pendingSelection;
    if (pending?.kind !== "generation") {
      throw new Error("No pending generation can be enqueued");
    }
    return {
      id: pending.generationJobId,
      kind: "challenger",
      createdAt: pending.selectedAt,
      roundNumber: state.round.roundNumber,
      winnerSide: pending.winnerSide,
      retainedWinner: candidateAt(state.round, pending.winnerSide),
      rejectedCandidate: candidateAt(
        state.round,
        oppositeSide(pending.winnerSide),
      ),
      selectionHistory: state.history.slice(-12),
      recentConcepts: recentConcepts(state, 10),
      preferenceSeed: state.preferenceSeed,
    };
  }

  private candidateIdExistsInRound(state: GameState, candidateId: string) {
    return (
      state.round.leftCandidate.id === candidateId ||
      state.round.rightCandidate.id === candidateId
    );
  }

  private withoutCleanupMarker(state: GameState): GameState {
    const cleaned = { ...state };
    delete cleaned.mailboxCleanupJobId;
    return cleaned;
  }
}
