import { isDeepStrictEqual } from "node:util";
import {
  beginSelection,
  candidateAt,
  completeSelection,
  failSelection,
  oppositeSide,
  recentConcepts,
  type Candidate,
  type GameState,
  type Side,
} from "@/domain/game";
import type {
  GenerationJob,
  GenerationMailbox,
  GenerationResult,
} from "./agent-mailbox";
import type { AssetStore } from "./providers";
import type { GameRepository } from "./repository";

export class SelectionConflictError extends Error {}
export class MissingGameError extends Error {}

export class GameService {
  private reconciliation: Promise<GameState | null> | null = null;

  constructor(
    private readonly repository: GameRepository,
    private readonly mailbox: GenerationMailbox,
    private readonly assetVerifier: Pick<AssetStore, "verify">,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  async assertIdle(): Promise<void> {
    await this.repository.withLock(async () => {
      if ((await this.repository.load())?.round.status === "generating") {
        throw new SelectionConflictError(
          "A challenger is already being generated",
        );
      }
    });
  }

  async updatePreferenceSeed(preferenceSeed: string): Promise<GameState> {
    return this.repository.withLock(async () => {
      const current = await this.repository.load();
      if (!current) {
        throw new MissingGameError("Start a game before editing preferences");
      }
      if (current.round.status === "generating") {
        throw new SelectionConflictError(
          "A challenger is already being generated",
        );
      }

      const updated = { ...current, preferenceSeed };
      await this.repository.save(updated);
      return updated;
    });
  }

  async select(
    winnerSide: Side,
    expectedRoundNumber: number,
  ): Promise<GameState> {
    return this.repository.withLock(async () => {
      const current = await this.repository.load();
      if (!current) {
        throw new MissingGameError("Start a game before choosing an image");
      }
      if (current.round.roundNumber !== expectedRoundNumber) {
        throw new SelectionConflictError(
          "The round changed before this selection arrived",
        );
      }

      const selectedAt = this.now();
      const generationJobId = this.createId();
      const inFlight = beginSelection(
        current,
        winnerSide,
        selectedAt,
        generationJobId,
      );
      if (!inFlight) {
        throw new SelectionConflictError(
          "A challenger is already being generated",
        );
      }

      const job = this.generationJob(inFlight);
      await this.repository.save(inFlight);
      await this.ensureEnqueued(job);
      return inFlight;
    });
  }

  async reconcile(): Promise<GameState | null> {
    if (this.reconciliation) return this.reconciliation;

    const reconciliation = this.repository.withLock(() =>
      this.reconcileLocked(),
    );
    this.reconciliation = reconciliation;
    try {
      return await reconciliation;
    } finally {
      if (this.reconciliation === reconciliation) this.reconciliation = null;
    }
  }

  private async reconcileLocked(): Promise<GameState | null> {
    const current = await this.repository.load();
    if (!current) return null;

    if (current.mailboxCleanupJobId) {
      await this.mailbox.archive(current.mailboxCleanupJobId);
      const cleaned = this.withoutCleanupMarker(current);
      await this.repository.save(cleaned);
      return cleaned;
    }

    const pending = current.pendingSelection;
    if (current.round.status !== "generating" || !pending) return current;

    const expectedJob = this.generationJob(current);
    const result = await this.mailbox.readResult(pending.generationJobId);
    if (!result) {
      await this.ensureEnqueued(expectedJob);
      return current;
    }
    if (result.jobId !== pending.generationJobId) return current;

    const actualWork = await this.mailbox.readWork(pending.generationJobId);
    let terminal: GameState;
    if (!actualWork || !this.sameJob(actualWork, expectedJob)) {
      terminal = this.failedState(
        current,
        "Generation failed: Work metadata does not match the persisted selection",
      );
    } else {
      terminal = await this.applyResult(current, result);
    }

    const awaitingCleanup = {
      ...terminal,
      mailboxCleanupJobId: pending.generationJobId,
    };
    await this.repository.save(awaitingCleanup);
    await this.mailbox.archive(pending.generationJobId);
    const cleaned = this.withoutCleanupMarker(awaitingCleanup);
    await this.repository.save(cleaned);
    return cleaned;
  }

  private async applyResult(
    current: GameState,
    result: GenerationResult,
  ): Promise<GameState> {
    if (result.status === "failed") {
      return this.failedState(current, `Generation failed: ${result.message}`);
    }

    const expectedCandidateId = `challenger-${result.jobId}`;
    if (result.asset.candidateId !== expectedCandidateId) {
      return this.failedState(
        current,
        `Generation failed: Challenger candidate ID must equal ${expectedCandidateId}`,
      );
    }

    const candidateIds = new Set([
      current.round.leftCandidate.id,
      current.round.rightCandidate.id,
    ]);
    if (candidateIds.has(result.asset.candidateId)) {
      return this.failedState(
        current,
        `Generation failed: Candidate ID ${result.asset.candidateId} already exists in the current round`,
      );
    }

    try {
      await this.assetVerifier.verify(result.asset);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Asset verification failed";
      return this.failedState(
        current,
        `Generation failed: Asset verification failed: ${message}`,
      );
    }

    const challenger: Candidate = {
      id: result.asset.candidateId,
      imageUrl: result.asset.imageUrl,
      prompt: result.proposal.visualPrompt,
      concept: result.proposal.concept,
      style: result.proposal.styleTags,
      reasoningSummary: result.proposal.reasoningSummary,
      createdAt: result.completedAt,
      winCount: 0,
    };
    return completeSelection(current, challenger);
  }

  private failedState(current: GameState, message: string): GameState {
    return failSelection(current, message);
  }

  private generationJob(state: GameState): GenerationJob {
    const pending = state.pendingSelection;
    if (!pending) throw new Error("No pending selection can be enqueued");
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

  private withoutCleanupMarker(state: GameState): GameState {
    const cleaned = { ...state };
    delete cleaned.mailboxCleanupJobId;
    return cleaned;
  }
}
