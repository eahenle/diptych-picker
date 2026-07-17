import { describe, expect, it, vi } from "vitest";
import type { Candidate, GameState } from "@/domain/game";
import type {
  GenerationJob,
  GenerationMailbox,
  GenerationResult,
} from "./agent-mailbox";
import { generationJobSchema } from "./agent-mailbox";
import { GameService, SelectionConflictError } from "./game-service";
import type { AssetStore } from "./providers";
import { MemoryGameRepository, type GameRepository } from "./repository";

const makeCandidate = (id: string, concept: string): Candidate => ({
  id,
  imageUrl: `/api/assets/${id}.png`,
  prompt: `${concept} prompt`,
  concept,
  style: ["cinematic"],
  createdAt: "2026-07-16T00:00:00.000Z",
  winCount: 0,
});

const makeState = (): GameState => ({
  round: {
    leftCandidate: makeCandidate("left", "forest observatory"),
    rightCandidate: makeCandidate("right", "crystal synthesizer"),
    status: "idle",
    replacingSide: null,
    roundNumber: 3,
    retainedCandidateId: null,
    winStreak: 0,
  },
  history: [
    {
      winnerId: "old-a",
      loserId: "old-b",
      winnerPrompt: "forge prompt",
      loserPrompt: "tidepool prompt",
      winnerConcept: "copper forge",
      loserConcept: "alien tidepool",
      selectedAt: "2026-07-15T00:00:00.000Z",
    },
  ],
  preferenceSeed: "industrial, gothic, natural, and surprising",
});

const completedResult = (jobId = "job-1"): GenerationResult => ({
  jobId,
  status: "completed",
  completedAt: "2026-07-16T01:01:00.000Z",
  proposal: {
    concept: "paper automaton ballet",
    visualPrompt: "one square photograph of mechanical paper dancers",
    styleTags: ["paper craft", "warm daylight"],
    reasoningSummary: "Introduces warmth and craft.",
  },
  asset: {
    candidateId: "challenger-job-1",
    filename: "challenger-job-1.png",
    imageUrl: "/api/assets/challenger-job-1.png",
    contentType: "image/png",
    width: 1024,
    height: 1024,
    byteLength: 2048,
  },
});

function mailbox(
  result: GenerationResult | null = null,
  retainPendingJob = true,
) {
  let pendingJob: GenerationJob | null = null;
  let terminalResult = result;
  const enqueue = vi.fn<(job: GenerationJob) => Promise<void>>(async (job) => {
    if (retainPendingJob) pendingJob = job;
  });
  const readWork = vi.fn<(jobId: string) => Promise<GenerationJob | null>>(
    async (jobId) => (pendingJob?.id === jobId ? pendingJob : null),
  );
  const readResult = vi.fn<(jobId: string) => Promise<GenerationResult | null>>(
    async () => terminalResult,
  );
  const archive = vi.fn<(jobId: string) => Promise<void>>(async () => {});
  const generationMailbox: GenerationMailbox = {
    enqueue,
    readPending: readWork,
    readWork,
    readResult,
    archive,
  };
  return {
    generationMailbox,
    enqueue,
    readWork,
    readResult,
    archive,
    setWork(job: GenerationJob | null) {
      pendingJob = job;
    },
    setResult(next: GenerationResult | null) {
      terminalResult = next;
    },
  };
}

function verifier() {
  const verify = vi.fn<AssetStore["verify"]>(async () => {});
  return { assetVerifier: { verify }, verify };
}

function serviceFor(
  repository: GameRepository,
  generationMailbox: GenerationMailbox,
  assetVerifier: Pick<AssetStore, "verify"> = verifier().assetVerifier,
  jobId = "job-1",
) {
  return new GameService(
    repository,
    generationMailbox,
    assetVerifier,
    () => "2026-07-16T01:00:00.000Z",
    () => jobId,
  );
}

describe("GameService asynchronous generation", () => {
  it.each(["left", "right"] as const)(
    "preserves both candidates while selecting %s and enqueues one complete job",
    async (winnerSide) => {
      const initial = makeState();
      const left = initial.round.leftCandidate;
      const right = initial.round.rightCandidate;
      const repository = new MemoryGameRepository(initial);
      const queue = mailbox();

      const selected = await serviceFor(
        repository,
        queue.generationMailbox,
      ).select(winnerSide, 3);

      expect(selected.round.leftCandidate).toBe(left);
      expect(selected.round.rightCandidate).toBe(right);
      expect(selected.round.status).toBe("generating");
      expect(selected.pendingSelection?.generationJobId).toBe("job-1");
      expect(queue.enqueue).toHaveBeenCalledTimes(1);
      expect(queue.enqueue).toHaveBeenCalledWith({
        id: "job-1",
        kind: "challenger",
        createdAt: "2026-07-16T01:00:00.000Z",
        roundNumber: 3,
        winnerSide,
        retainedWinner: winnerSide === "left" ? left : right,
        rejectedCandidate: winnerSide === "left" ? right : left,
        selectionHistory: initial.history,
        recentConcepts: ["alien tidepool", "copper forge"],
        preferenceSeed: initial.preferenceSeed,
      });
    },
  );

  it("enqueues only once when the same round is selected twice", async () => {
    const repository = new MemoryGameRepository(makeState());
    const queue = mailbox();
    const service = serviceFor(repository, queue.generationMailbox);

    await service.select("left", 3);
    await expect(service.select("left", 3)).rejects.toBeInstanceOf(
      SelectionConflictError,
    );

    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("allows only one of two service instances to select the same round", async () => {
    let releaseFirstSave!: () => void;
    let firstSaveStarted!: () => void;
    const firstSaveEntered = new Promise<void>((resolve) => {
      firstSaveStarted = resolve;
    });
    const heldFirstSave = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    const backing = new MemoryGameRepository(makeState());
    let saveCount = 0;
    const repository: GameRepository = {
      load: () => backing.load(),
      clear: () => backing.clear(),
      save: async (state) => {
        saveCount += 1;
        if (saveCount === 1) {
          firstSaveStarted();
          await heldFirstSave;
        }
        await backing.save(state);
      },
      withLock: (operation) => backing.withLock(operation),
    };
    const queue = mailbox();
    const first = serviceFor(
      repository,
      queue.generationMailbox,
      verifier().assetVerifier,
      "job-1",
    );
    const second = serviceFor(
      repository,
      queue.generationMailbox,
      verifier().assetVerifier,
      "job-2",
    );

    const firstSelection = first.select("left", 3);
    await firstSaveEntered;
    const secondSelection = second.select("right", 3);
    releaseFirstSave();

    await expect(firstSelection).resolves.toMatchObject({
      round: { status: "generating" },
    });
    await expect(secondSelection).rejects.toBeInstanceOf(
      SelectionConflictError,
    );
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("reconciles a completed result without invoking a provider", async () => {
    const initial = makeState();
    const winner = initial.round.leftCandidate;
    const winnerMetadata = structuredClone(winner);
    const repository = new MemoryGameRepository(initial);
    const queue = mailbox(completedResult());
    const assets = verifier();
    const service = serviceFor(
      repository,
      queue.generationMailbox,
      assets.assetVerifier,
    );
    await service.select("left", 3);

    const completed = await service.reconcile();

    expect(completed?.round.leftCandidate).toBe(winner);
    expect(completed?.round.leftCandidate).toEqual(winnerMetadata);
    expect(completed?.round.retainedCandidateId).toBe(winner.id);
    expect(completed?.round.winStreak).toBe(1);
    expect(completed?.round.rightCandidate).toEqual({
      id: "challenger-job-1",
      imageUrl: "/api/assets/challenger-job-1.png",
      prompt: "one square photograph of mechanical paper dancers",
      concept: "paper automaton ballet",
      style: ["paper craft", "warm daylight"],
      reasoningSummary: "Introduces warmth and craft.",
      createdAt: "2026-07-16T01:01:00.000Z",
      winCount: 0,
    });
    expect(completed?.round.status).toBe("idle");
    const expectedResult = completedResult();
    if (expectedResult.status !== "completed") throw new Error("unreachable");
    expect(assets.verify).toHaveBeenCalledWith(expectedResult.asset);
    expect(queue.archive).toHaveBeenCalledWith("job-1");
    await expect(repository.load()).resolves.toBe(completed);
  });

  it("preserves both candidates when a failed result is reconciled", async () => {
    const initial = makeState();
    const left = initial.round.leftCandidate;
    const right = initial.round.rightCandidate;
    const repository = new MemoryGameRepository(initial);
    const queue = mailbox({
      jobId: "job-1",
      status: "failed",
      completedAt: "2026-07-16T01:01:00.000Z",
      message: "Image generation was interrupted",
      retryable: true,
    });
    const service = serviceFor(repository, queue.generationMailbox);
    await service.select("right", 3);

    const failed = await service.reconcile();

    expect(failed?.round.leftCandidate).toEqual(left);
    expect(failed?.round.rightCandidate).toEqual(right);
    expect(failed?.round.status).toBe("error");
    expect(failed?.errorMessage).toContain("Image generation was interrupted");
    expect(queue.archive).toHaveBeenCalledWith("job-1");
  });

  it("idempotently republishes a missing mailbox job from persisted state", async () => {
    const repository = new MemoryGameRepository(makeState());
    const queue = mailbox();
    const service = serviceFor(repository, queue.generationMailbox);
    const selected = await service.select("left", 3);
    const originalJob = queue.enqueue.mock.calls[0][0];
    queue.setWork(null);
    queue.enqueue.mockClear();

    const refreshed = await service.reconcile();

    expect(refreshed).toBe(selected);
    expect(queue.enqueue).toHaveBeenCalledWith(originalJob);
    expect(queue.archive).not.toHaveBeenCalled();
  });

  it("accepts schema-canonical work whose object keys have a different order", async () => {
    const state = makeState();
    const reorderCandidate = (candidate: Candidate): Candidate => {
      const { createdAt, winCount, ...rest } = candidate;
      return { ...rest, winCount, createdAt };
    };
    state.round.leftCandidate = reorderCandidate(state.round.leftCandidate);
    state.round.rightCandidate = reorderCandidate(state.round.rightCandidate);
    const repository = new MemoryGameRepository(state);
    const queue = mailbox();
    const service = serviceFor(repository, queue.generationMailbox);
    const selected = await service.select("left", 3);
    const canonicalWork = generationJobSchema.parse(
      queue.enqueue.mock.calls[0][0],
    );
    queue.setWork(canonicalWork);
    queue.enqueue.mockRejectedValueOnce(new Error("duplicate job"));

    await expect(service.reconcile()).resolves.toBe(selected);
  });

  it("keeps generating when enqueue reports an error after publication", async () => {
    const repository = new MemoryGameRepository(makeState());
    const queue = mailbox(null, false);
    queue.enqueue.mockImplementationOnce(async (job) => {
      queue.setWork(job);
      throw new Error("lost acknowledgement");
    });
    const service = serviceFor(repository, queue.generationMailbox);

    const selected = await service.select("left", 3);

    expect(selected.round.status).toBe("generating");
    expect(await queue.readWork("job-1")).toEqual(
      queue.enqueue.mock.calls[0][0],
    );
  });

  it("ignores and does not archive a result for another job", async () => {
    const repository = new MemoryGameRepository(makeState());
    const queue = mailbox(completedResult("job-other"));
    const service = serviceFor(repository, queue.generationMailbox);
    const selected = await service.select("left", 3);

    const unchanged = await service.reconcile();

    expect(unchanged).toBe(selected);
    expect(unchanged?.round.status).toBe("generating");
    expect(queue.archive).not.toHaveBeenCalled();
  });

  it("rejects a completed result whose candidate ID collides with the current round", async () => {
    const initial = makeState();
    initial.round.leftCandidate.id = "challenger-job-1";
    const left = initial.round.leftCandidate;
    const right = initial.round.rightCandidate;
    const collision = completedResult();
    const repository = new MemoryGameRepository(initial);
    const queue = mailbox(collision);
    const service = serviceFor(repository, queue.generationMailbox);
    await service.select("left", 3);

    const failed = await service.reconcile();

    expect(failed?.round.leftCandidate).toEqual(left);
    expect(failed?.round.rightCandidate).toEqual(right);
    expect(failed?.round.status).toBe("error");
    expect(failed?.errorMessage).toMatch(/candidate id.*already exists/i);
    expect(queue.archive).toHaveBeenCalledWith("job-1");
  });

  it("rejects a completed result whose work metadata does not match persisted selection", async () => {
    const initial = makeState();
    const repository = new MemoryGameRepository(initial);
    const queue = mailbox(completedResult());
    const service = serviceFor(repository, queue.generationMailbox);
    await service.select("left", 3);
    const actualWork = await queue.readWork("job-1");
    queue.setWork({ ...actualWork!, preferenceSeed: "tampered seed" });

    const failed = await service.reconcile();

    expect(failed?.round.status).toBe("error");
    expect(failed?.round.leftCandidate.winCount).toBe(0);
    expect(failed?.errorMessage).toMatch(/work metadata/i);
  });

  it("requires the deterministic challenger ID for a completed result", async () => {
    const result = completedResult();
    if (result.status !== "completed") throw new Error("unreachable");
    result.asset = {
      ...result.asset,
      candidateId: "unexpected-challenger",
      filename: "unexpected-challenger.png",
      imageUrl: "/api/assets/unexpected-challenger.png",
    };
    const repository = new MemoryGameRepository(makeState());
    const queue = mailbox(result);
    const service = serviceFor(repository, queue.generationMailbox);
    await service.select("left", 3);

    const failed = await service.reconcile();

    expect(failed?.round.status).toBe("error");
    expect(failed?.round.leftCandidate.winCount).toBe(0);
    expect(failed?.errorMessage).toMatch(/challenger-job-1/i);
  });

  it("fails safely when immutable asset verification rejects metadata", async () => {
    const initial = makeState();
    const left = initial.round.leftCandidate;
    const right = initial.round.rightCandidate;
    const repository = new MemoryGameRepository(initial);
    const queue = mailbox(completedResult());
    const assets = verifier();
    assets.verify.mockRejectedValueOnce(new Error("asset bytes are corrupt"));
    const service = serviceFor(
      repository,
      queue.generationMailbox,
      assets.assetVerifier,
    );
    await service.select("left", 3);

    const failed = await service.reconcile();

    expect(failed?.round.status).toBe("error");
    expect(failed?.round.leftCandidate).toBe(left);
    expect(failed?.round.rightCandidate).toBe(right);
    expect(failed?.errorMessage).toContain("asset bytes are corrupt");
  });

  it("retries a failed terminal save without incrementing the streak twice", async () => {
    const backing = new MemoryGameRepository(makeState());
    let saveCount = 0;
    const repository: GameRepository = {
      load: () => backing.load(),
      clear: () => backing.clear(),
      save: async (state) => {
        saveCount += 1;
        if (saveCount === 2) throw new Error("disk full");
        await backing.save(state);
      },
      withLock: (operation) => backing.withLock(operation),
    };
    const queue = mailbox(completedResult());
    const service = serviceFor(repository, queue.generationMailbox);
    await service.select("left", 3);

    await expect(service.reconcile()).rejects.toThrow("disk full");

    expect(queue.archive).not.toHaveBeenCalled();
    expect((await backing.load())?.round.status).toBe("generating");
    expect((await backing.load())?.round.winStreak).toBe(0);

    const completed = await service.reconcile();

    expect(completed?.round.leftCandidate.winCount).toBe(0);
    expect(completed?.round.winStreak).toBe(1);
    expect(completed?.history).toHaveLength(2);
  });

  it("persists cleanup intent and retries archive failure without reapplying completion", async () => {
    const repository = new MemoryGameRepository(makeState());
    const queue = mailbox(completedResult());
    queue.archive.mockRejectedValueOnce(new Error("archive unavailable"));
    const service = serviceFor(repository, queue.generationMailbox);
    await service.select("left", 3);

    await expect(service.reconcile()).rejects.toThrow("archive unavailable");
    const awaitingCleanup = await repository.load();
    expect(awaitingCleanup?.round.status).toBe("idle");
    expect(awaitingCleanup?.round.leftCandidate.winCount).toBe(0);
    expect(awaitingCleanup?.round.winStreak).toBe(1);
    expect(awaitingCleanup?.mailboxCleanupJobId).toBe("job-1");

    const cleaned = await service.reconcile();

    expect(cleaned?.round.leftCandidate.winCount).toBe(0);
    expect(cleaned?.round.winStreak).toBe(1);
    expect(cleaned?.history).toHaveLength(2);
    expect(cleaned?.mailboxCleanupJobId).toBeUndefined();
    expect(queue.archive).toHaveBeenCalledTimes(2);
  });

  it("serializes preference updates with selection so neither state change is overwritten", async () => {
    const backing = new MemoryGameRepository(makeState());
    let releasePreferenceSave!: () => void;
    const preferenceSaveHeld = new Promise<void>((resolve) => {
      releasePreferenceSave = resolve;
    });
    let signalPreferenceSave!: () => void;
    const preferenceSaveEntered = new Promise<void>((resolve) => {
      signalPreferenceSave = resolve;
    });
    const repository: GameRepository = {
      load: () => backing.load(),
      clear: () => backing.clear(),
      save: async (state) => {
        if (state.preferenceSeed === "new preference seed") {
          signalPreferenceSave();
          await preferenceSaveHeld;
        }
        await backing.save(state);
      },
      withLock: (operation) => backing.withLock(operation),
    };
    const queue = mailbox();
    const preferences = serviceFor(repository, queue.generationMailbox);
    const selection = serviceFor(
      repository,
      queue.generationMailbox,
      verifier().assetVerifier,
      "job-2",
    );

    const updating = preferences.updatePreferenceSeed("new preference seed");
    await preferenceSaveEntered;
    const selecting = selection.select("left", 3);
    releasePreferenceSave();

    await expect(updating).resolves.toMatchObject({
      preferenceSeed: "new preference seed",
      round: { status: "idle" },
    });
    await expect(selecting).resolves.toMatchObject({
      preferenceSeed: "new preference seed",
      round: { status: "generating" },
      pendingSelection: { generationJobId: "job-2" },
    });
    await expect(backing.load()).resolves.toMatchObject({
      preferenceSeed: "new preference seed",
      round: { status: "generating" },
      pendingSelection: { generationJobId: "job-2" },
    });
  });
});
