import type {
  ChallengerState,
  LeaderboardVisualProfile,
} from "@/domain/challenger-state";
import type { GameRules, GameState } from "@/domain/game";
import type { ChallengerRepository } from "./challenger-repository";
import {
  planRefillCapacity,
  refillContext,
  type RefillCapacityResult,
  type RefillContext,
} from "./game-refill";
import type { GenerationJobPublisher } from "./generation-job-publisher";
import type { GameRepository } from "./repository";

interface RefillCapacityServiceOptions {
  gameRepository: GameRepository;
  challengerRepository: ChallengerRepository;
  publisher: Pick<GenerationJobPublisher, "ensureAll">;
  rulesFor: (game: GameState) => GameRules;
  leaderboardVisualProfile: (
    state: ChallengerState,
    game: GameState,
  ) => LeaderboardVisualProfile | undefined;
  createId: () => string;
  now: () => string;
  random: () => number;
}

export class RefillCapacityService {
  constructor(private readonly options: RefillCapacityServiceOptions) {}

  plan(state: ChallengerState, context: RefillContext): RefillCapacityResult {
    return planRefillCapacity(state, context, {
      bufferTarget: this.options.rulesFor(context.game).bufferTarget,
      leaderboardVisualProfile: this.options.leaderboardVisualProfile(
        state,
        context.game,
      ),
      createId: this.options.createId,
      now: this.options.now,
      random: this.options.random,
    });
  }

  async ensure(): Promise<void> {
    await this.withStateLocks(async () => {
      const [game, challengers] = await Promise.all([
        this.options.gameRepository.load(),
        this.options.challengerRepository.load(),
      ]);
      if (!game || !challengers) return;

      const context = refillContext(game, challengers);
      if (!context) return;
      const capacity = this.plan(challengers, context);
      if (capacity.jobs.length === 0) return;
      await this.options.challengerRepository.save(capacity.state);
      await this.options.publisher.ensureAll(capacity.jobs);
    });
  }

  private withStateLocks<T>(operation: () => Promise<T>): Promise<T> {
    return this.options.gameRepository.withLock(() =>
      this.options.challengerRepository.withLock(operation),
    );
  }
}
