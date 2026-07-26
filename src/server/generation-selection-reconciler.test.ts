import { describe, expect, it, vi } from "vitest";
import type { Candidate, GameState } from "@/domain/game";
import type {
  GenerationJob,
  GenerationMailbox,
  GenerationResult,
} from "./agent-mailbox";
import { GenerationSelectionReconciler } from "./generation-selection-reconciler";
import type { AssetStore } from "./providers";
import { MemoryGameRepository } from "./repository";

const NOW = "2026-07-25T21:00:00.000Z";

function candidate(id: string): Candidate {
  return {
    id,
    imageUrl: `/api/assets/${id}.png`,
    prompt: `${id} prompt`,
    concept: `${id} concept`,
    style: ["editorial"],
    createdAt: NOW,
    winCount: 0,
  };
}

function pendingGame(): GameState {
  return {
    round: {
      leftCandidate: candidate("left"),
      rightCandidate: candidate("right"),
      status: "generating",
      replacingSide: "right",
      roundNumber: 4,
      retainedCandidateId: "left",
      winStreak: 1,
    },
    history: [],
    preferenceSeed: "Architectural portraits with dramatic natural light.",
    pendingSelection: {
      kind: "generation",
      winnerSide: "left",
      selectedAt: NOW,
      generationJobId: "legacy-job",
    },
  };
}

function expectedJob(game: GameState): GenerationJob {
  return {
    id: "legacy-job",
    kind: "challenger",
    createdAt: NOW,
    roundNumber: 4,
    winnerSide: "left",
    retainedWinner: game.round.leftCandidate,
    rejectedCandidate: game.round.rightCandidate,
    selectionHistory: [],
    recentConcepts: [],
    preferenceSeed: game.preferenceSeed,
  };
}

function completed(candidateId = "challenger-legacy-job"): GenerationResult {
  return {
    jobId: "legacy-job",
    status: "completed",
    completedAt: "2026-07-25T21:01:00.000Z",
    proposal: {
      concept: "generated concept",
      visualPrompt: "a standalone square architectural portrait",
      styleTags: ["editorial"],
      reasoningSummary: "follows the architectural portrait brief",
    },
    asset: {
      candidateId,
      filename: `${candidateId}.png`,
      imageUrl: `/api/assets/${candidateId}.png`,
      contentType: "image/png",
      width: 1024,
      height: 1024,
      byteLength: 2048,
    },
  };
}

function fixture(game = pendingGame()) {
  const work = new Map<string, GenerationJob>();
  const results = new Map<string, GenerationResult>();
  const enqueue = vi.fn<GenerationMailbox["enqueue"]>(async (job) => {
    work.set(job.id, job);
  });
  const archive = vi.fn<GenerationMailbox["archive"]>(async (jobId) => {
    work.delete(jobId);
    results.delete(jobId);
  });
  const mailbox: GenerationMailbox = {
    enqueue,
    readPending: async (jobId) => work.get(jobId) ?? null,
    readWork: async (jobId) => work.get(jobId) ?? null,
    readResult: async (jobId) => results.get(jobId) ?? null,
    archive,
  };
  const repository = new MemoryGameRepository(game);
  const verify = vi.fn<AssetStore["verify"]>(async () => {});
  const reconciler = new GenerationSelectionReconciler({
    repository,
    mailbox,
    assetVerifier: { verify },
    ensureEnqueued: enqueue,
  });
  return {
    work,
    results,
    enqueue,
    archive,
    repository,
    verify,
    reconciler,
  };
}

describe("GenerationSelectionReconciler", () => {
  it("re-enqueues the exact persisted legacy generation intent", async () => {
    const game = pendingGame();
    const context = fixture(game);

    const waiting = await context.reconciler.reconcile(game);

    expect(waiting).toBe(game);
    expect(context.enqueue).toHaveBeenCalledWith(expectedJob(game));
  });

  it("validates and completes a matching generated challenger", async () => {
    const game = pendingGame();
    const context = fixture(game);
    context.work.set("legacy-job", expectedJob(game));
    context.results.set("legacy-job", completed());

    const finished = await context.reconciler.reconcile(game);

    expect(context.verify).toHaveBeenCalledOnce();
    expect(finished.round).toMatchObject({
      status: "idle",
      leftCandidate: { id: "left" },
      rightCandidate: { id: "challenger-legacy-job" },
      roundNumber: 5,
    });
    expect(finished.mailboxCleanupJobId).toBeUndefined();
    expect(context.archive).toHaveBeenCalledWith("legacy-job");
    await expect(context.repository.load()).resolves.toMatchObject({
      round: finished.round,
      history: finished.history,
    });
  });

  it("fails a completed result when durable work metadata differs", async () => {
    const game = pendingGame();
    const context = fixture(game);
    context.work.set("legacy-job", {
      ...expectedJob(game),
      preferenceSeed: "tampered",
    });
    context.results.set("legacy-job", completed());

    const failed = await context.reconciler.reconcile(game);

    expect(failed.round.status).toBe("error");
    expect(failed.errorMessage).toContain("Work metadata does not match");
    expect(context.verify).not.toHaveBeenCalled();
    expect(context.archive).toHaveBeenCalledWith("legacy-job");
  });

  it("fails a generated candidate that collides with the displayed round", async () => {
    const game = pendingGame();
    const context = fixture(game);
    context.work.set("legacy-job", expectedJob(game));
    context.results.set("legacy-job", completed("right"));

    const failed = await context.reconciler.reconcile(game);

    expect(failed.round.status).toBe("error");
    expect(failed.errorMessage).toContain("collides with the current round");
    expect(context.verify).not.toHaveBeenCalled();
  });

  it("turns asset verification errors into a retryable round error", async () => {
    const game = pendingGame();
    const context = fixture(game);
    context.work.set("legacy-job", expectedJob(game));
    context.results.set("legacy-job", completed());
    context.verify.mockRejectedValueOnce(new Error("digest mismatch"));

    const failed = await context.reconciler.reconcile(game);

    expect(failed.round.status).toBe("error");
    expect(failed.errorMessage).toContain(
      "Asset verification failed: digest mismatch",
    );
  });

  it("retries archival from the durable cleanup marker", async () => {
    const game = pendingGame();
    const context = fixture(game);
    context.work.set("legacy-job", expectedJob(game));
    context.results.set("legacy-job", completed());
    context.archive.mockRejectedValueOnce(new Error("archive unavailable"));

    await expect(context.reconciler.reconcile(game)).rejects.toThrow(
      "archive unavailable",
    );
    const awaitingCleanup = await context.repository.load();
    expect(awaitingCleanup?.mailboxCleanupJobId).toBe("legacy-job");

    const cleaned = await context.reconciler.cleanup(awaitingCleanup!);

    expect(cleaned.mailboxCleanupJobId).toBeUndefined();
    expect(context.archive).toHaveBeenCalledTimes(2);
    await expect(context.repository.load()).resolves.toEqual(cleaned);
  });
});
