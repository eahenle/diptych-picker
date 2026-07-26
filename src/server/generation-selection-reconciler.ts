import { isDeepStrictEqual } from "node:util";
import {
  candidateAt,
  completeSelection,
  failSelection,
  oppositeSide,
  recentConcepts,
  type GameState,
} from "@/domain/game";
import type { GenerationJob, GenerationMailbox } from "./agent-mailbox";
import type { AssetStore } from "./providers";
import { candidateFromGenerationResult } from "./refill-result-reconciler";
import type { GameRepository } from "./repository";

interface GenerationSelectionReconcilerOptions {
  repository: GameRepository;
  mailbox: GenerationMailbox;
  assetVerifier: Pick<AssetStore, "verify">;
  ensureEnqueued: (job: GenerationJob) => Promise<void>;
}

export class GenerationSelectionReconciler {
  constructor(private readonly options: GenerationSelectionReconcilerOptions) {}

  async cleanup(game: GameState): Promise<GameState> {
    if (!game.mailboxCleanupJobId) return game;
    await this.options.mailbox.archive(game.mailboxCleanupJobId);
    const cleaned = this.withoutCleanupMarker(game);
    await this.options.repository.save(cleaned);
    return cleaned;
  }

  async reconcile(current: GameState): Promise<GameState> {
    const pending = current.pendingSelection;
    if (pending?.kind !== "generation") return current;

    const expectedJob = this.expectedJob(current);
    const result = await this.options.mailbox.readResult(
      pending.generationJobId,
    );
    if (!result) {
      await this.options.ensureEnqueued(expectedJob);
      return current;
    }
    if (result.jobId !== pending.generationJobId) return current;

    const actualWork = await this.options.mailbox.readWork(
      pending.generationJobId,
    );
    let terminal: GameState;
    if (!actualWork || !isDeepStrictEqual(actualWork, expectedJob)) {
      terminal = failSelection(
        current,
        "Generation failed: Work metadata does not match the persisted selection",
      );
    } else if (result.status === "failed") {
      terminal = failSelection(current, `Generation failed: ${result.message}`);
    } else {
      terminal = await this.completeResult(current, result);
    }

    const awaitingCleanup = {
      ...terminal,
      mailboxCleanupJobId: pending.generationJobId,
    };
    await this.options.repository.save(awaitingCleanup);
    return this.cleanup(awaitingCleanup);
  }

  private async completeResult(
    current: GameState,
    result: Extract<
      Awaited<ReturnType<GenerationMailbox["readResult"]>>,
      { status: "completed" }
    >,
  ): Promise<GameState> {
    const generated = candidateFromGenerationResult(result);
    if (!generated || this.candidateIdExistsInRound(current, generated.id)) {
      return failSelection(
        current,
        "Generation failed: Challenger result is invalid or collides with the current round",
      );
    }

    try {
      await this.options.assetVerifier.verify(result.asset);
      return completeSelection(current, generated);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Asset verification failed";
      return failSelection(
        current,
        `Generation failed: Asset verification failed: ${message}`,
      );
    }
  }

  private expectedJob(state: GameState): GenerationJob {
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
