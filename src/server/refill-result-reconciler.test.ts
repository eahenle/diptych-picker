import { describe, expect, it, vi } from "vitest";
import type {
  ChallengerState,
  RefillJobRecord,
} from "@/domain/challenger-state";
import type { Candidate, GameState } from "@/domain/game";
import type {
  GenerationJob,
  GenerationMailbox,
  GenerationResult,
} from "./agent-mailbox";
import { MemoryChallengerRepository } from "./challenger-repository";
import {
  candidateFromGenerationResult,
  RefillResultReconciler,
} from "./refill-result-reconciler";
import { MemoryGameRepository } from "./repository";

const NOW = "2026-07-25T18:00:00.000Z";

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

function game(): GameState {
  return {
    round: {
      leftCandidate: candidate("left"),
      rightCandidate: candidate("right"),
      status: "idle",
      replacingSide: null,
      roundNumber: 4,
      retainedCandidateId: "left",
      winStreak: 1,
    },
    history: [],
    preferenceSeed: "Architectural portraits with dramatic natural light.",
  };
}

function expectedJob(id: string): Extract<GenerationJob, { kind: "refill" }> {
  return {
    id,
    kind: "refill",
    createdAt: NOW,
    roundNumber: 4,
    winnerSide: "left",
    retainedWinner: candidate("left"),
    rejectedCandidate: candidate("right"),
    selectionHistory: [],
    recentConcepts: [],
    preferenceSeed: game().preferenceSeed,
    sessionId: "session-1",
    pinnedWinnerId: "left",
  };
}

function record(id: string): RefillJobRecord {
  return {
    jobId: id,
    pinnedWinnerId: "left",
    enqueuedAt: NOW,
    expectedJob: expectedJob(id),
  };
}

function state(refillJobs: RefillJobRecord[]): ChallengerState {
  return {
    version: 1,
    sessionId: "session-1",
    ready: [],
    importQueue: [],
    refillJobs,
    pendingComparison: null,
    ratings: [],
    generationTurnaroundEmaMs: 100_000,
    consecutiveFallbackDraws: 0,
    nextFallbackAt: null,
  };
}

function completed(
  jobId: string,
  completedAt = "2026-07-25T18:01:00.000Z",
): Extract<GenerationResult, { status: "completed" }> {
  return {
    jobId,
    status: "completed",
    completedAt,
    proposal: {
      concept: `${jobId} concept`,
      visualPrompt: `${jobId} standalone square image`,
      styleTags: ["editorial"],
      reasoningSummary: `${jobId} reasoning`,
    },
    asset: {
      candidateId: `challenger-${jobId}`,
      filename: `challenger-${jobId}.png`,
      imageUrl: `/api/assets/challenger-${jobId}.png`,
      contentType: "image/png",
      width: 1024,
      height: 1024,
      byteLength: 2048,
    },
  };
}

function fixture(refillJobs: RefillJobRecord[]) {
  const initialGame = game();
  const initialState = state(refillJobs);
  const work = new Map<string, GenerationJob>();
  const results = new Map<string, GenerationResult>();
  const archive = vi.fn<GenerationMailbox["archive"]>(async (jobId) => {
    work.delete(jobId);
    results.delete(jobId);
  });
  const mailbox: GenerationMailbox = {
    enqueue: async (job) => {
      work.set(job.id, job);
    },
    readPending: async (jobId) => work.get(jobId) ?? null,
    readWork: async (jobId) => work.get(jobId) ?? null,
    readResult: async (jobId) => results.get(jobId) ?? null,
    archive,
  };
  const gameRepository = new MemoryGameRepository(initialGame);
  const challengerRepository = new MemoryChallengerRepository(initialState);
  const ensureEnqueued = vi.fn(async (job: GenerationJob) => {
    work.set(job.id, job);
  });
  const completePreparedSelection = vi.fn(
    async (currentGame: GameState, currentState: ChallengerState) => ({
      game: currentGame,
      challengers: currentState,
    }),
  );
  const removeDisplayedCandidatesFromReady = vi.fn(
    async (_currentGame: GameState, currentState: ChallengerState) =>
      currentState,
  );
  const verify = vi.fn(async () => {});
  const reconciler = new RefillResultReconciler({
    gameRepository,
    challengerRepository,
    mailbox,
    assetVerifier: { verify },
    initialRating: 1000,
    turnaroundEmaAlpha: 0.25,
    ensureEnqueued,
    completePreparedSelection,
    removeDisplayedCandidatesFromReady,
  });
  return {
    initialGame,
    initialState,
    work,
    results,
    archive,
    gameRepository,
    challengerRepository,
    ensureEnqueued,
    completePreparedSelection,
    verify,
    reconciler,
  };
}

describe("RefillResultReconciler", () => {
  it("re-enqueues exact durable intent when work publication is missing", async () => {
    const refill = record("missing-work");
    const context = fixture([refill]);

    const outcome = await context.reconciler.reconcile(
      context.initialGame,
      context.initialState,
    );

    expect(context.ensureEnqueued).toHaveBeenCalledWith(refill.expectedJob);
    expect(outcome.challengers.refillJobs).toEqual([refill]);
    expect(context.archive).not.toHaveBeenCalled();
  });

  it("admits completed results in completion order and archives each intent", async () => {
    const late = record("late");
    const early = record("early");
    const context = fixture([late, early]);
    context.work.set(late.jobId, late.expectedJob);
    context.work.set(early.jobId, early.expectedJob);
    context.results.set(
      late.jobId,
      completed(late.jobId, "2026-07-25T18:02:00.000Z"),
    );
    context.results.set(
      early.jobId,
      completed(early.jobId, "2026-07-25T18:01:00.000Z"),
    );

    const outcome = await context.reconciler.reconcile(
      context.initialGame,
      context.initialState,
    );

    expect(
      outcome.challengers.ready.map(({ candidate }) => candidate.id),
    ).toEqual(["challenger-early", "challenger-late"]);
    expect(outcome.challengers.refillJobs).toEqual([]);
    expect(context.verify).toHaveBeenCalledTimes(2);
    expect(context.archive.mock.calls.map(([jobId]) => jobId)).toEqual([
      "early",
      "late",
    ]);
  });

  it("records a moderation notice and removes the failed refill", async () => {
    const refill = record("blocked");
    const context = fixture([refill]);
    context.work.set(refill.jobId, refill.expectedJob);
    context.results.set(refill.jobId, {
      jobId: refill.jobId,
      status: "failed",
      completedAt: "2026-07-25T18:01:00.000Z",
      message: "Blocked by safety policy",
      retryable: true,
      category: "moderation",
    });

    const outcome = await context.reconciler.reconcile(
      context.initialGame,
      context.initialState,
    );

    expect(outcome.game.generationNotice).toEqual({
      kind: "moderation-block",
      jobId: "blocked",
      occurredAt: "2026-07-25T18:01:00.000Z",
      occurrenceCount: 1,
    });
    expect(outcome.challengers.refillJobs).toEqual([]);
    expect(context.verify).not.toHaveBeenCalled();
    await expect(context.gameRepository.load()).resolves.toMatchObject({
      generationNotice: { jobId: "blocked" },
    });
  });

  it("preserves prompt-card and variation lineage in generated candidates", () => {
    const job = {
      ...expectedJob("lineage"),
      promptCard: {
        id: "card-1",
        title: "Card",
        prompt: "High contrast editorial geometry",
        negativePrompt: "",
        tags: ["editorial"],
      },
      variationSource: {
        candidateId: "parent-1",
        concept: "parent concept",
      },
    };

    expect(
      candidateFromGenerationResult(completed("lineage"), job),
    ).toMatchObject({
      id: "challenger-lineage",
      promptCardId: "card-1",
      lineage: {
        kind: "variation",
        parentCandidateId: "parent-1",
        parentConcept: "parent concept",
        preferenceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });
});
