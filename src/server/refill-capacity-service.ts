import type {
  ChallengerState,
  LeaderboardVisualProfile,
} from "@/domain/challenger-state";
import type { GameRules, GameState } from "@/domain/game";
import type { ImportSupplySnapshot } from "@/domain/import-session";
import type { ImportSession } from "@/domain/import-session";
import { summarizeImportSupply } from "./candidate-dequeue-service";
import type { ChallengerRepository } from "./challenger-repository";
import {
  planRefillCapacity,
  refillContext,
  type RefillCapacityResult,
  type RefillContext,
} from "./game-refill";
import type { GenerationJobPublisher } from "./generation-job-publisher";
import type { GameRepository } from "./repository";
import type { ImportSessionRepository } from "./import-session-repository";
import type { StateLockCoordinator } from "./state-lock-coordinator";

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
  importSessionRepository?: ImportSessionRepository;
  stateLockCoordinator?: StateLockCoordinator;
}

export class RefillCapacityService {
  constructor(private readonly options: RefillCapacityServiceOptions) {}

  plan(
    state: ChallengerState,
    context: RefillContext,
    importSupply: ImportSupplySnapshot = noImportSupply,
  ): RefillCapacityResult {
    if (!importSupply.terminal) return { state, jobs: [] };
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

  async ensure(importSupply?: ImportSupplySnapshot): Promise<void> {
    if (
      !importSupply &&
      this.options.importSessionRepository &&
      this.options.stateLockCoordinator
    ) {
      const jobs = await this.options.stateLockCoordinator.withStateLocks(
        ["activation-intent", "import-session", "game", "challenger"],
        async () => {
          const [game, challengers, importSession] = await Promise.all([
            this.options.gameRepository.load(),
            this.options.challengerRepository.load(),
            this.options.importSessionRepository!.load(),
          ]);
          if (!game || !challengers) return [];
          const context = refillContext(game, challengers);
          if (!context) return [];
          const supply = summarizeImportSupply(
            activatedImportSessionId(importSession) ? importSession : null,
          );
          const capacity = this.plan(challengers, context, supply);
          if (capacity.jobs.length > 0) {
            await this.options.challengerRepository.save(capacity.state);
          }
          return capacity.jobs;
        },
      );
      await this.options.publisher.ensureAll(jobs);
      return;
    }
    await this.withStateLocks(async () => {
      const [game, challengers] = await Promise.all([
        this.options.gameRepository.load(),
        this.options.challengerRepository.load(),
      ]);
      if (!game || !challengers) return;

      const context = refillContext(game, challengers);
      if (!context) return;
      const capacity = this.plan(
        challengers,
        context,
        importSupply ?? noImportSupply,
      );
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

function activatedImportSessionId(
  session: ImportSession | null,
): string | null {
  return session?.activatedAt &&
    (session.status === "active" || session.status === "completed")
    ? session.id
    : null;
}

const noImportSupply: ImportSupplySnapshot = {
  importSessionId: null,
  annotating: 0,
  failed: 0,
  readyUnserved: 0,
  servedImportedItemCount: 0,
  activationDisplayReceiptCount: 0,
  dequeueReceiptCount: 0,
  initialFillPending: 0,
  initialFillFailed: 0,
  terminal: true,
};
