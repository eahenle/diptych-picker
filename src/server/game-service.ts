import { drawFallback, type ChallengerState } from "@/domain/challenger-state";
import {
  preferenceProfileFromSeed,
  type GameRules,
  type GameState,
  type PreferenceProfile,
  type Side,
} from "@/domain/game";
import type { CreatePromptCardInput } from "@/domain/prompt-deck";
import type {
  GenerationMailbox,
  PromptCardBlenderMailbox,
  PromptCardEditorMailbox,
} from "./agent-mailbox";
import type { ChallengerRepository } from "./challenger-repository";
import { challengerConfig } from "./challenger-config";
import { SelectionConflictError } from "./game-service-errors";
import { GameReconciler } from "./game-reconciler";
import { GameSelectionService } from "./game-selection-service";
import { GameSettingsService } from "./game-settings-service";
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
  private readonly gameReconciler: GameReconciler;
  private readonly gameSelectionService: GameSelectionService;

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
    this.gameReconciler = new GameReconciler({
      gameRepository: this.gameRepository,
      challengerRepository: this.challengerRepository,
      generationSelectionReconciler: this.generationSelectionReconciler,
      promptCardReconciler: this.promptCardReconciler,
      leaderboardProfileReconciler: this.leaderboardProfileReconciler,
      preparedSelectionReconciler: this.preparedSelectionReconciler,
      refillResultReconciler: this.refillResultReconciler,
      refillCapacityService: this.refillCapacityService,
      generationJobPublisher: this.generationJobPublisher,
      rulesFor: (game) => this.rulesFor(game),
      drawFallback: (state, game) => this.drawFallback(state, game),
    });
    this.gameSelectionService = new GameSelectionService({
      gameRepository: this.gameRepository,
      challengerRepository: this.challengerRepository,
      promptCardReconciler: this.promptCardReconciler,
      preparedSelectionReconciler: this.preparedSelectionReconciler,
      refillCapacityService: this.refillCapacityService,
      generationJobPublisher: this.generationJobPublisher,
      config: this.config,
      rulesFor: (game) => this.rulesFor(game),
      drawFallback: (state, game) => this.drawFallback(state, game),
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
    return this.gameSelectionService.select(winnerSide, expectedRoundNumber);
  }

  async tie(expectedRoundNumber: number): Promise<GameState> {
    return this.gameSelectionService.tie(expectedRoundNumber);
  }

  async bothLose(expectedRoundNumber: number): Promise<GameState> {
    return this.gameSelectionService.bothLose(expectedRoundNumber);
  }

  async ensureRefillCapacity(): Promise<void> {
    await this.refillCapacityService.ensure();
  }

  async reconcile(): Promise<GameState | null> {
    return this.gameReconciler.reconcile();
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
}
