import {
  backfillGeneratedPool,
  popReady,
  type CandidateDraw,
  type ChallengerState,
} from "@/domain/challenger-state";
import {
  completeSelection,
  type GameRules,
  type GameState,
} from "@/domain/game";
import type { ChallengerRepository } from "./challenger-repository";
import { applyAdaptivePreferences } from "./game-adaptation";
import { refillContext } from "./game-refill";
import type { GenerationJobPublisher } from "./generation-job-publisher";
import type { GenerationSelectionReconciler } from "./generation-selection-reconciler";
import type { LeaderboardProfileReconciler } from "./leaderboard-profile-reconciler";
import type { PreparedSelectionReconciler } from "./prepared-selection-reconciler";
import type { PromptCardReconciler } from "./prompt-card-reconciler";
import type { RefillCapacityService } from "./refill-capacity-service";
import type { RefillResultReconciler } from "./refill-result-reconciler";
import type { GameRepository } from "./repository";

interface GameReconcilerOptions {
  gameRepository: GameRepository;
  challengerRepository: ChallengerRepository;
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
  drawFallback: (state: ChallengerState, game: GameState) => CandidateDraw;
}

export class GameReconciler {
  private reconciliation: Promise<GameState | null> | null = null;

  constructor(private readonly options: GameReconcilerOptions) {}

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
    let game = await this.options.gameRepository.load();
    if (!game) return null;

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
    );
    game = prepared.game;
    challengers =
      await this.options.preparedSelectionReconciler.removeDisplayedCandidatesFromReady(
        prepared.game,
        prepared.challengers,
      );

    const refills = await this.options.refillResultReconciler.reconcile(
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
      if (!draw.candidate) {
        draw = this.options.drawFallback(challengers, game);
      }
      challengers = draw.state;
      if (draw.candidate) {
        const adapted = applyAdaptivePreferences(
          completeSelection(game, draw.candidate),
          challengers,
        );
        game = adapted.game;
        challengers = adapted.challengers;
        await this.options.gameRepository.save(game);
        challengers = {
          ...challengers,
          pendingComparison: null,
          pendingSelectionBaseline: null,
        };
        await this.options.challengerRepository.save(challengers);
      }
    }

    const context = refillContext(game, challengers);
    if (context) {
      const capacity = this.options.refillCapacityService.plan(
        challengers,
        context,
      );
      challengers = capacity.state;
      if (capacity.jobs.length > 0) {
        await this.options.challengerRepository.save(challengers);
        await this.options.generationJobPublisher.ensureAll(capacity.jobs);
      }
    }

    return game;
  }

  private withStateLocks<T>(operation: () => Promise<T>): Promise<T> {
    return this.options.gameRepository.withLock(() =>
      this.options.challengerRepository.withLock(operation),
    );
  }
}
