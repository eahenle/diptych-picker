import { backfillGeneratedPool } from "@/domain/challenger-state";
import type { GameRules, GameState } from "@/domain/game";
import type { ImportSession } from "@/domain/import-session";
import { summarizeImportSupply } from "./candidate-dequeue-service";
import type { ChallengerRepository } from "./challenger-repository";
import { refillContext } from "./game-refill";
import type { GenerationJobPublisher } from "./generation-job-publisher";
import type { GenerationSelectionReconciler } from "./generation-selection-reconciler";
import type { LeaderboardProfileReconciler } from "./leaderboard-profile-reconciler";
import type { PreparedSelectionReconciler } from "./prepared-selection-reconciler";
import type { PromptCardReconciler } from "./prompt-card-reconciler";
import type { RefillCapacityService } from "./refill-capacity-service";
import type { RefillResultReconciler } from "./refill-result-reconciler";
import type { GameRepository } from "./repository";
import type { ImportSessionRepository } from "./import-session-repository";
import type {
  LockedStateContext,
  StateLockCoordinator,
} from "./state-lock-coordinator";

interface GameReconcilerOptions {
  gameRepository: GameRepository;
  challengerRepository: ChallengerRepository;
  importSessionRepository: ImportSessionRepository;
  stateLockCoordinator: StateLockCoordinator;
  generationSelectionReconciler: Pick<
    GenerationSelectionReconciler,
    "cleanup" | "reconcile"
  >;
  promptCardReconciler: Pick<PromptCardReconciler, "reconcile">;
  leaderboardProfileReconciler: Pick<LeaderboardProfileReconciler, "reconcile">;
  preparedSelectionReconciler: Pick<
    PreparedSelectionReconciler,
    "prepare" | "complete" | "removeDisplayedCandidatesFromReady"
  >;
  refillResultReconciler: Pick<RefillResultReconciler, "reconcile">;
  refillCapacityService: Pick<RefillCapacityService, "plan">;
  generationJobPublisher: Pick<GenerationJobPublisher, "ensureAll">;
  rulesFor: (game: GameState) => GameRules;
}

export class GameReconciler {
  private reconciliation: Promise<GameState | null> | null = null;

  constructor(private readonly options: GameReconcilerOptions) {}

  async reconcile(): Promise<GameState | null> {
    if (this.reconciliation) return this.reconciliation;

    const reconciliation = this.withStateLocks((context) =>
      this.reconcileLocked(context),
    );
    this.reconciliation = reconciliation;
    try {
      return await reconciliation;
    } finally {
      if (this.reconciliation === reconciliation) this.reconciliation = null;
    }
  }

  private async reconcileLocked(
    lockContext: LockedStateContext,
  ): Promise<GameState | null> {
    let game = await this.options.gameRepository.load();
    if (!game) return null;
    const importSession = await this.options.importSessionRepository.load();
    let importSupply = summarizeImportSupply(
      activatedImportSessionId(importSession) ? importSession : null,
    );

    game = await this.options.generationSelectionReconciler.cleanup(game);
    game = await this.options.promptCardReconciler.reconcile(game);

    if (
      game.round.status === "generating" &&
      game.pendingSelection?.kind === "generation"
    ) {
      return this.options.generationSelectionReconciler.reconcile(game);
    }

    let challengers = await this.options.challengerRepository.load();
    if (!challengers) return game;

    const backfilled = backfillGeneratedPool(
      challengers,
      this.options.rulesFor(game).poolMaximum,
    );
    if (backfilled !== challengers) {
      challengers = backfilled;
      await this.options.challengerRepository.save(challengers);
    }

    challengers = await this.options.leaderboardProfileReconciler.reconcile(
      game,
      challengers,
    );
    challengers = await this.options.preparedSelectionReconciler.prepare(
      game,
      challengers,
    );

    const prepared = await this.options.preparedSelectionReconciler.complete(
      game,
      challengers,
      lockContext,
    );
    game = prepared.game;
    importSupply = prepared.importSupply ?? importSupply;
    challengers =
      await this.options.preparedSelectionReconciler.removeDisplayedCandidatesFromReady(
        prepared.game,
        prepared.challengers,
      );

    const refills = await this.options.refillResultReconciler.reconcile(
      game,
      challengers,
      lockContext,
    );
    game = refills.game;
    challengers = refills.challengers;

    const afterRefills =
      await this.options.preparedSelectionReconciler.complete(
        game,
        challengers,
        lockContext,
      );
    game = afterRefills.game;
    challengers = afterRefills.challengers;
    importSupply = afterRefills.importSupply ?? importSupply;

    const context = refillContext(game, challengers);
    if (context) {
      const capacity = this.options.refillCapacityService.plan(
        challengers,
        context,
        importSupply,
      );
      challengers = capacity.state;
      if (capacity.jobs.length > 0) {
        await this.options.challengerRepository.save(challengers);
        await this.options.generationJobPublisher.ensureAll(capacity.jobs);
      }
    }

    return game;
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
