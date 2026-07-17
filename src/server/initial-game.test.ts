import { describe, expect, it, vi } from "vitest";
import type { ChallengerState } from "@/domain/challenger-state";
import type { Candidate, GameState } from "@/domain/game";
import type {
  GenerationJob,
  GenerationMailbox,
  GenerationResult,
} from "./agent-mailbox";
import {
  InitialGameService,
  type InitialGameServiceOptions,
} from "./initial-game";
import { MemoryChallengerRepository } from "./challenger-repository";
import { MemoryInitialBootstrapRepository } from "./initial-bootstrap";
import type { AssetStore } from "./providers";
import { MemoryGameRepository } from "./repository";

const NOW = "2026-07-16T12:00:00.000Z";

function candidate(id: string, concept: string): Candidate {
  return {
    id,
    imageUrl: `/context/${id}.png`,
    prompt: `${concept} prompt`,
    concept,
    style: ["context"],
    createdAt: NOW,
    winCount: 0,
  };
}

function seededGame(): GameState {
  return {
    round: {
      leftCandidate: candidate("seed-left", "seed left"),
      rightCandidate: candidate("seed-right", "seed right"),
      status: "idle",
      replacingSide: null,
      roundNumber: 1,
      retainedCandidateId: null,
      winStreak: 0,
    },
    history: [],
    preferenceSeed: "prefer carefully made unfamiliar scenes",
  };
}

function completed(jobId: string, concept: string): GenerationResult {
  return {
    jobId,
    status: "completed",
    completedAt: "2026-07-16T12:01:00.000Z",
    proposal: {
      concept,
      visualPrompt: `${concept} standalone square image`,
      styleTags: ["generated"],
      reasoningSummary: `${concept} broadens the initial comparison`,
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

function queue() {
  const work = new Map<string, GenerationJob>();
  const results = new Map<string, GenerationResult>();
  const enqueue = vi.fn(async (job: GenerationJob) => {
    if (work.has(job.id)) throw new Error(`duplicate ${job.id}`);
    work.set(job.id, job);
  });
  const archive = vi.fn(async (jobId: string) => {
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
  return { mailbox, enqueue, archive, work, results };
}

function challengerState(
  overrides: Partial<ChallengerState> = {},
): ChallengerState {
  return {
    version: 1,
    sessionId: "old-session",
    ready: [],
    refillJobs: [],
    ratings: [],
    generationTurnaroundEmaMs: 42_000,
    consecutiveFallbackDraws: 0,
    nextFallbackAt: null,
    ...overrides,
  };
}

function curatedCandidates(): Candidate[] {
  return Array.from({ length: 7 }, (_, index) =>
    candidate(`curated-${index + 1}`, `curated concept ${index + 1}`),
  );
}

interface HarnessOptions {
  seedState?: GameState | null;
  curatedCandidates?: Candidate[];
  challengerState?: ChallengerState | null;
  random?: () => number;
}

function harness({
  seedState = null,
  curatedCandidates = [],
  challengerState: initialChallengerState = null,
  random = () => 0.5,
}: HarnessOptions = {}) {
  const gameRepository = new MemoryGameRepository();
  const challengerRepository = new MemoryChallengerRepository(
    initialChallengerState,
  );
  const bootstrapRepository = new MemoryInitialBootstrapRepository();
  const generation = queue();
  const verify = vi.fn<AssetStore["verify"]>(async () => {});
  const ids = [
    "batch-1",
    "initial-left-1",
    "initial-right-1",
    "batch-2",
    "initial-left-2",
    "initial-right-2",
  ];
  const options: InitialGameServiceOptions = {
    gameRepository,
    challengerRepository,
    bootstrapRepository,
    mailbox: generation.mailbox,
    assetVerifier: { verify },
    seedState: vi.fn(async () => seedState),
    curatedCandidates: vi.fn(async () => curatedCandidates),
    initialContext: () => [
      candidate("context-left", "coastal observatory"),
      candidate("context-right", "crystal synthesizer"),
    ],
    preferenceSeed: "prefer carefully made unfamiliar scenes",
    now: () => NOW,
    createId: () => ids.shift()!,
    random,
  };
  return {
    service: new InitialGameService(options),
    gameRepository,
    challengerRepository,
    bootstrapRepository,
    generation,
    verify,
    seedState: options.seedState,
  };
}

describe("InitialGameService", () => {
  it("keeps the immediate seeded GameState path unchanged", async () => {
    const seeded = seededGame();
    const { service, bootstrapRepository, generation } = harness({
      seedState: seeded,
    });

    await expect(service.getOrCreate()).resolves.toEqual({
      status: "ready",
      game: seeded,
    });
    await expect(bootstrapRepository.load()).resolves.toBeNull();
    expect(generation.enqueue).not.toHaveBeenCalled();
  });

  it("starts from seven distinct curated candidates and restores the FIFO on refresh", async () => {
    const curated = curatedCandidates();
    const { service, challengerRepository } = harness({
      curatedCandidates: curated,
      random: () => 0.25,
    });

    const start = await service.getOrCreate();
    expect(start.status).toBe("ready");
    if (start.status !== "ready") throw new Error("Expected a ready game");

    const persisted = await challengerRepository.load();
    expect(start.game.round.leftCandidate.id).not.toBe(
      start.game.round.rightCandidate.id,
    );
    expect(persisted?.ready).toHaveLength(5);
    const allSevenIds = [
      start.game.round.leftCandidate.id,
      start.game.round.rightCandidate.id,
      ...(persisted?.ready.map(({ candidate }) => candidate.id) ?? []),
    ];
    expect(new Set(allSevenIds).size).toBe(7);
    expect(persisted?.ratings).toEqual(
      expect.arrayContaining(
        curated.map((item) =>
          expect.objectContaining({
            candidate: item,
            rating: 1000,
            wins: 0,
            losses: 0,
            source: "curated",
            poolMember: true,
          }),
        ),
      ),
    );

    const refreshed = await service.getOrCreate();
    expect(refreshed).toEqual(start);
    await expect(challengerRepository.load()).resolves.toEqual(persisted);
  });

  it("resets the session while preserving ratings and archiving old refill jobs", async () => {
    const learned = {
      candidate: candidate("learned-generated", "learned concept"),
      rating: 1184,
      wins: 7,
      losses: 2,
      source: "generated" as const,
      poolMember: true,
      lastServedAt: "2026-07-15T12:00:00.000Z",
    };
    const previous = challengerState({
      refillJobs: [
        {
          jobId: "old-refill",
          pinnedWinnerId: "old-winner",
          enqueuedAt: "2026-07-15T12:00:00.000Z",
        },
      ],
      ratings: [learned],
      consecutiveFallbackDraws: 2,
      nextFallbackAt: "2026-07-16T12:05:00.000Z",
    });
    const { service, gameRepository, challengerRepository, generation } =
      harness({
        curatedCandidates: curatedCandidates(),
        challengerState: previous,
      });
    await gameRepository.save(seededGame());
    const resetOrder: string[] = [];
    vi.spyOn(gameRepository, "clear").mockImplementation(async () => {
      resetOrder.push("clear-game");
    });
    generation.archive.mockImplementation(async () => {
      resetOrder.push("archive-refill");
    });

    const reset = await service.reset();
    expect(reset.status).toBe("ready");
    const persisted = await challengerRepository.load();
    expect(generation.archive).toHaveBeenCalledWith("old-refill");
    expect(resetOrder).toEqual(["archive-refill", "clear-game"]);
    expect(persisted?.sessionId).not.toBe(previous.sessionId);
    expect(persisted?.refillJobs).toEqual([]);
    expect(persisted?.ratings).toContainEqual(learned);
    expect(persisted?.consecutiveFallbackDraws).toBe(0);
    expect(persisted?.nextFallbackAt).toBeNull();

    generation.results.set(
      "old-refill",
      completed("old-refill", "late old-session result"),
    );
    const afterLateResult = await service.getOrCreate();
    expect(afterLateResult).toEqual(reset);
    await expect(challengerRepository.load()).resolves.toEqual(persisted);
  });

  it("persists one bootstrap and enqueues two same-batch initial jobs when seeds are absent", async () => {
    const { service, bootstrapRepository, generation } = harness();

    await expect(service.getOrCreate()).resolves.toEqual({
      status: "initializing",
      batchId: "batch-1",
      preferenceSeed: "prefer carefully made unfamiliar scenes",
    });

    const bootstrap = await bootstrapRepository.load();
    expect(bootstrap).toEqual({
      batchId: "batch-1",
      createdAt: NOW,
      preferenceSeed: "prefer carefully made unfamiliar scenes",
      jobs: [
        { id: "initial-left-1", side: "left" },
        { id: "initial-right-1", side: "right" },
      ],
    });
    expect(generation.enqueue).toHaveBeenCalledTimes(2);
    expect([...generation.work.values()]).toEqual([
      expect.objectContaining({
        id: "initial-left-1",
        kind: "initial",
        batchId: "batch-1",
        initialSide: "left",
        preferenceSeed: bootstrap!.preferenceSeed,
        recentConcepts: ["coastal observatory", "crystal synthesizer"],
      }),
      expect.objectContaining({
        id: "initial-right-1",
        kind: "initial",
        batchId: "batch-1",
        initialSide: "right",
        preferenceSeed: bootstrap!.preferenceSeed,
        recentConcepts: ["coastal observatory", "crystal synthesizer"],
      }),
    ]);
  });

  it("restores the same bootstrap on refresh without duplicate enqueues", async () => {
    const { service, bootstrapRepository, generation } = harness();
    const first = await service.getOrCreate();
    const persisted = await bootstrapRepository.load();

    const refreshed = await service.getOrCreate();

    expect(refreshed).toEqual(first);
    await expect(bootstrapRepository.load()).resolves.toEqual(persisted);
    expect(generation.enqueue).toHaveBeenCalledTimes(2);
  });

  it("reconciles only after both immutable PNG results complete", async () => {
    const { service, gameRepository, bootstrapRepository, generation, verify } =
      harness();
    await service.getOrCreate();
    generation.results.set(
      "initial-left-1",
      completed("initial-left-1", "left generated concept"),
    );

    await expect(service.getOrCreate()).resolves.toMatchObject({
      status: "initializing",
    });
    await expect(gameRepository.load()).resolves.toBeNull();

    generation.results.set(
      "initial-right-1",
      completed("initial-right-1", "right generated concept"),
    );
    const ready = await service.getOrCreate();

    expect(ready).toMatchObject({
      status: "ready",
      game: {
        round: {
          leftCandidate: { id: "challenger-initial-left-1" },
          rightCandidate: { id: "challenger-initial-right-1" },
          status: "idle",
          roundNumber: 1,
        },
        history: [],
      },
    });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(generation.archive).toHaveBeenCalledWith("initial-left-1");
    expect(generation.archive).toHaveBeenCalledWith("initial-right-1");
    await expect(bootstrapRepository.load()).resolves.toBeNull();
    await expect(gameRepository.load()).resolves.toEqual(
      ready.status === "ready" ? ready.game : null,
    );
  });

  it("preserves a successful result on partner failure and retry creates a fresh pair", async () => {
    const { service, bootstrapRepository, generation } = harness();
    await service.getOrCreate();
    const successful = completed(
      "initial-left-1",
      "preserved generated concept",
    );
    generation.results.set("initial-left-1", successful);
    generation.results.set("initial-right-1", {
      jobId: "initial-right-1",
      status: "failed",
      completedAt: "2026-07-16T12:01:00.000Z",
      message: "deterministic initial failure",
      retryable: true,
    });

    await expect(service.getOrCreate()).resolves.toEqual({
      status: "initialization-error",
      batchId: "batch-1",
      preferenceSeed: "prefer carefully made unfamiliar scenes",
      errorMessage: "Initial generation failed: deterministic initial failure",
    });
    expect(generation.results.get("initial-left-1")).toEqual(successful);
    expect(generation.archive).not.toHaveBeenCalled();

    await expect(service.retry()).resolves.toEqual({
      status: "initializing",
      batchId: "batch-2",
      preferenceSeed: "prefer carefully made unfamiliar scenes",
    });
    expect(generation.archive).toHaveBeenCalledWith("initial-left-1");
    expect(generation.archive).toHaveBeenCalledWith("initial-right-1");
    await expect(bootstrapRepository.load()).resolves.toMatchObject({
      batchId: "batch-2",
      jobs: [
        { id: "initial-left-2", side: "left" },
        { id: "initial-right-2", side: "right" },
      ],
    });
    expect(generation.enqueue).toHaveBeenCalledTimes(4);
  });
});
