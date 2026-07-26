import {
  backfillGeneratedPool,
  type ChallengerState,
} from "@/domain/challenger-state";
import type {
  GameRules,
  GameState,
  PreferenceProfile,
  PreferencePreset,
} from "@/domain/game";
import type { GenerationJob } from "./agent-mailbox";
import type { ChallengerRepository } from "./challenger-repository";
import {
  GameRulesError,
  MissingGameError,
  PreferencePresetLimitError,
} from "./game-service-errors";
import {
  refillContext,
  type RefillCapacityResult,
  type RefillContext,
} from "./game-refill";
import { validGameRules } from "./game-rules";
import type { GameRepository } from "./repository";

interface GameSettingsServiceOptions {
  gameRepository: GameRepository;
  challengerRepository: ChallengerRepository;
  addRefillCapacity: (
    state: ChallengerState,
    context: RefillContext,
  ) => RefillCapacityResult;
  ensureJobsEnqueued: (jobs: readonly GenerationJob[]) => Promise<void>;
  now: () => string;
  createId: () => string;
}

export class GameSettingsService {
  constructor(private readonly options: GameSettingsServiceOptions) {}

  async dismissGenerationNotice(): Promise<GameState> {
    return this.options.gameRepository.withLock(async () => {
      const current = await this.options.gameRepository.load();
      if (!current) {
        throw new MissingGameError("Start a game before dismissing a notice");
      }
      if (!current.generationNotice) return current;
      const updated = { ...current };
      delete updated.generationNotice;
      await this.options.gameRepository.save(updated);
      return updated;
    });
  }

  async savePreferencePreset(
    name: string,
    profile: PreferenceProfile,
  ): Promise<GameState> {
    return this.options.gameRepository.withLock(async () => {
      const current = await this.options.gameRepository.load();
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
      const updatedAt = this.options.now();
      const reusableProfile: PreferenceProfile = {
        ...profile,
        adaptationLastDecision: 0,
        adaptationSourceWinnerIds: [],
        adaptationSourceRejectedIds: [],
      };
      const preset: PreferencePreset = {
        id: existing?.id ?? this.options.createId(),
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
      await this.options.gameRepository.save(updated);
      return updated;
    });
  }

  async deletePreferencePreset(presetId: string): Promise<GameState> {
    return this.options.gameRepository.withLock(async () => {
      const current = await this.options.gameRepository.load();
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
      await this.options.gameRepository.save(updated);
      return updated;
    });
  }

  async updateGameRules(rules: GameRules): Promise<GameState> {
    if (!validGameRules(rules)) {
      throw new GameRulesError("One or more game rules are out of range.");
    }
    return this.withStateLocks(async () => {
      const [current, challengers] = await Promise.all([
        this.options.gameRepository.load(),
        this.options.challengerRepository.load(),
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
        ? this.options.addRefillCapacity(nextChallengers, context)
        : { state: nextChallengers, jobs: [] };
      nextChallengers = capacity.state;
      await this.options.gameRepository.save(updated);
      if (nextChallengers !== challengers) {
        await this.options.challengerRepository.save(nextChallengers);
      }
      await this.options.ensureJobsEnqueued(capacity.jobs);
      return updated;
    });
  }

  private withStateLocks<T>(operation: () => Promise<T>): Promise<T> {
    return this.options.gameRepository.withLock(() =>
      this.options.challengerRepository.withLock(operation),
    );
  }
}
