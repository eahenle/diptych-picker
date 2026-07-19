import { describe, expect, it, vi } from "vitest";
import type {
  CandidateRating,
  ChallengerState,
} from "@/domain/challenger-state";
import type { Candidate, GameState } from "@/domain/game";
import type {
  GenerationJob,
  GenerationMailbox,
  GenerationResult,
} from "./agent-mailbox";
import {
  MemoryChallengerRepository,
  type ChallengerRepository,
} from "./challenger-repository";
import { challengerConfig } from "./challenger-config";
import { GameService, SelectionConflictError } from "./game-service";
import type { AssetStore } from "./providers";
import { MemoryGameRepository, type GameRepository } from "./repository";

const NOW = "2026-07-16T01:00:00.000Z";

const candidate = (id: string): Candidate => ({
  id,
  imageUrl: `/api/assets/${id}.png`,
  prompt: `${id} prompt`,
  concept: `${id} concept`,
  style: ["cinematic", id],
  reasoningSummary: `${id} reasoning`,
  createdAt: "2026-07-16T00:00:00.000Z",
  winCount: 0,
});

const rating = (
  item: Candidate,
  overrides: Partial<CandidateRating> = {},
): CandidateRating => ({
  candidate: item,
  rating: 1000,
  wins: 0,
  losses: 0,
  source: "curated",
  poolMember: true,
  lastServedAt: null,
  ...overrides,
});

const gameState = (overrides: Partial<GameState> = {}): GameState => ({
  round: {
    leftCandidate: candidate("left"),
    rightCandidate: candidate("right"),
    status: "idle",
    replacingSide: null,
    roundNumber: 3,
    retainedCandidateId: null,
    winStreak: 0,
  },
  history: [
    {
      winnerId: "recent-winner",
      loserId: "recent-loser",
      winnerPrompt: "recent winner prompt",
      loserPrompt: "recent loser prompt",
      winnerConcept: "recent winner concept",
      loserConcept: "recent loser concept",
      selectedAt: "2026-07-15T00:00:00.000Z",
    },
  ],
  preferenceSeed: "industrial, gothic, natural, and surprising",
  ...overrides,
});

function challengerState(
  game: GameState,
  overrides: Partial<ChallengerState> = {},
): ChallengerState {
  const ready = Array.from({ length: 5 }, (_, index) => ({
    candidate: candidate(`buffer-${index + 1}`),
    source: "seed" as const,
    pinnedWinnerId: null,
    enqueuedAt: "2026-07-16T00:00:00.000Z",
  }));
  return {
    version: 1,
    sessionId: "session-1",
    ready,
    refillJobs: [],
    pendingComparison: null,
    ratings: [
      rating(game.round.leftCandidate),
      rating(game.round.rightCandidate),
      ...ready.map(({ candidate: item }) => rating(item)),
    ],
    generationTurnaroundEmaMs: 100_000,
    consecutiveFallbackDraws: 0,
    nextFallbackAt: null,
    ...overrides,
  };
}

function mailbox() {
  const work = new Map<string, GenerationJob>();
  const results = new Map<string, GenerationResult>();
  const enqueue = vi.fn<(job: GenerationJob) => Promise<void>>(async (job) => {
    work.set(job.id, job);
  });
  const readWork = vi.fn<(jobId: string) => Promise<GenerationJob | null>>(
    async (jobId) => work.get(jobId) ?? null,
  );
  const readResult = vi.fn<(jobId: string) => Promise<GenerationResult | null>>(
    async (jobId) => results.get(jobId) ?? null,
  );
  const archive = vi.fn<(jobId: string) => Promise<void>>(async (jobId) => {
    work.delete(jobId);
    results.delete(jobId);
  });
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
    setWork(job: GenerationJob) {
      work.set(job.id, job);
    },
    deleteWork(jobId: string) {
      work.delete(jobId);
    },
    setResult(result: GenerationResult) {
      results.set(result.jobId, result);
    },
  };
}

function completedResult(
  jobId: string,
  completedAt = "2026-07-16T01:01:40.000Z",
): GenerationResult {
  return {
    jobId,
    status: "completed",
    completedAt,
    proposal: {
      concept: `${jobId} generated concept`,
      visualPrompt: `${jobId} standalone square image`,
      styleTags: ["paper craft", "warm daylight"],
      reasoningSummary: `${jobId} generated reasoning`,
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

function verifier() {
  const verify = vi.fn<AssetStore["verify"]>(async () => {});
  return { assetVerifier: { verify }, verify };
}

function ids(...values: string[]) {
  let index = 0;
  return () => values[index++] ?? `job-${index}`;
}

function serviceFor(options: {
  game?: GameState;
  challengers?: ChallengerState;
  gameRepository?: GameRepository;
  challengerRepository?: ChallengerRepository;
  queue?: ReturnType<typeof mailbox>;
  assets?: ReturnType<typeof verifier>;
  now?: () => string;
  createId?: () => string;
  random?: () => number;
  bufferTarget?: number;
}) {
  const game = options.game ?? gameState();
  const gameRepository =
    options.gameRepository ?? new MemoryGameRepository(game);
  const challengerRepository =
    options.challengerRepository ??
    new MemoryChallengerRepository(
      options.challengers ?? challengerState(game),
    );
  const queue = options.queue ?? mailbox();
  const assets = options.assets ?? verifier();
  const config = {
    ...challengerConfig,
    bufferTarget: options.bufferTarget ?? challengerConfig.bufferTarget,
  };
  const service = new GameService(
    gameRepository,
    challengerRepository,
    queue.generationMailbox,
    assets.assetVerifier,
    config,
    options.now ?? (() => NOW),
    options.createId ??
      ids("refill-1", "refill-2", "refill-3", "refill-4", "refill-5"),
    options.random ?? (() => 0),
  );
  return {
    service,
    gameRepository,
    challengerRepository,
    queue,
    assets,
  };
}

describe("GameService challenger buffer", () => {
  it("replaces buffered capacity when preferences change", async () => {
    const game = gameState({
      round: {
        ...gameState().round,
        retainedCandidateId: "left",
        winStreak: 1,
      },
    });
    const staleJob: GenerationJob = {
      id: "old-refill",
      kind: "refill",
      createdAt: NOW,
      roundNumber: game.round.roundNumber,
      winnerSide: "left",
      retainedWinner: game.round.leftCandidate,
      rejectedCandidate: game.round.rightCandidate,
      selectionHistory: game.history,
      recentConcepts: [],
      preferenceSeed: game.preferenceSeed,
      sessionId: "session-1",
      pinnedWinnerId: "left",
    };
    const challengers = challengerState(game, {
      ready: challengerState(game).ready.slice(0, 2),
      refillJobs: [
        {
          jobId: staleJob.id,
          pinnedWinnerId: "left",
          enqueuedAt: NOW,
          expectedJob: staleJob,
        },
      ],
    });
    const queue = mailbox();
    queue.setWork(staleJob);
    const context = serviceFor({
      game,
      challengers,
      queue,
      bufferTarget: 3,
      createId: ids("new-refill-1", "new-refill-2", "new-refill-3"),
    });

    await context.service.updatePreferenceSeed(
      "photographic portraits of clearly adult alternative women",
    );

    const persisted = await context.challengerRepository.load();
    expect(persisted?.ready).toEqual([]);
    expect(persisted?.refillJobs.map(({ jobId }) => jobId)).toEqual([
      "old-refill",
      "new-refill-1",
      "new-refill-2",
      "new-refill-3",
    ]);
    expect(queue.enqueue).toHaveBeenCalledTimes(3);
    expect(queue.enqueue.mock.calls.map(([job]) => job.preferenceSeed)).toEqual(
      Array(3).fill(
        "photographic portraits of clearly adult alternative women",
      ),
    );
  });

  it("discards a completed refill from an earlier preference seed", async () => {
    const game = gameState({
      preferenceSeed:
        "photographic portraits of clearly adult alternative women",
      round: {
        ...gameState().round,
        retainedCandidateId: "left",
        winStreak: 1,
      },
    });
    const staleJob: GenerationJob = {
      id: "old-refill",
      kind: "refill",
      createdAt: NOW,
      roundNumber: game.round.roundNumber,
      winnerSide: "left",
      retainedWinner: game.round.leftCandidate,
      rejectedCandidate: game.round.rightCandidate,
      selectionHistory: game.history,
      recentConcepts: [],
      preferenceSeed: "the old preference seed",
      sessionId: "session-1",
      pinnedWinnerId: "left",
    };
    const challengers = challengerState(game, {
      ready: [],
      refillJobs: [
        {
          jobId: staleJob.id,
          pinnedWinnerId: "left",
          enqueuedAt: NOW,
          expectedJob: staleJob,
        },
      ],
    });
    const queue = mailbox();
    queue.setWork(staleJob);
    queue.setResult(completedResult(staleJob.id));
    const context = serviceFor({
      game,
      challengers,
      queue,
      bufferTarget: 1,
      createId: ids("replacement-refill"),
    });

    await context.service.reconcile();

    expect(context.assets.verify).not.toHaveBeenCalled();
    expect(queue.archive).toHaveBeenCalledWith("old-refill");
    expect(
      (await context.challengerRepository.load())?.refillJobs,
    ).toMatchObject([
      {
        jobId: "replacement-refill",
        expectedJob: {
          preferenceSeed: game.preferenceSeed,
        },
      },
    ]);
  });

  it("backfills existing zero-win generated candidates during reconciliation", async () => {
    const game = gameState();
    const overlooked = candidate("overlooked");
    const challengers = challengerState(game, {
      ratings: [
        ...challengerState(game).ratings,
        rating(overlooked, {
          source: "generated",
          poolMember: false,
          losses: 2,
        }),
      ],
    });
    const context = serviceFor({ game, challengers });

    await context.service.reconcile();

    expect(
      (await context.challengerRepository.load())?.ratings.find(
        ({ candidate: item }) => item.id === overlooked.id,
      ),
    ).toMatchObject({ wins: 0, losses: 2, poolMember: true });
  });

  it.each(["left", "right"] as const)(
    "preserves the exact %s winner and immediately consumes one FIFO head",
    async (winnerSide) => {
      const game = gameState();
      const originalWinner =
        winnerSide === "left"
          ? game.round.leftCandidate
          : game.round.rightCandidate;
      const originalWinnerSnapshot = structuredClone(originalWinner);
      const challengers = challengerState(game);
      const head = challengers.ready[0].candidate;
      const context = serviceFor({ game, challengers });

      const selected = await context.service.select(winnerSide, 3);

      expect(
        winnerSide === "left"
          ? selected.round.leftCandidate
          : selected.round.rightCandidate,
      ).toBe(originalWinner);
      expect(originalWinner).toEqual(originalWinnerSnapshot);
      expect(
        winnerSide === "left"
          ? selected.round.rightCandidate
          : selected.round.leftCandidate,
      ).toEqual(head);
      expect(selected.round.status).toBe("idle");
      expect(selected.round.roundNumber).toBe(4);
      expect(selected.pendingSelection).toBeUndefined();

      const persisted = await context.challengerRepository.load();
      expect(persisted?.ready.map(({ candidate: item }) => item.id)).toEqual([
        "buffer-2",
        "buffer-3",
        "buffer-4",
        "buffer-5",
      ]);
      expect(persisted?.refillJobs).toEqual([
        {
          jobId: "refill-1",
          pinnedWinnerId: originalWinner.id,
          enqueuedAt: NOW,
          expectedJob: context.queue.enqueue.mock.calls[0][0],
        },
      ]);
      expect(context.queue.enqueue).toHaveBeenCalledTimes(1);
      expect(context.queue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "refill-1",
          kind: "refill",
          sessionId: "session-1",
          pinnedWinnerId: originalWinner.id,
          retainedWinner: originalWinnerSnapshot,
          preferenceSeed: game.preferenceSeed,
        }),
      );
      expect(
        context.queue.enqueue.mock.calls.some(
          ([job]) => job.kind === "challenger",
        ),
      ).toBe(false);

      const winnerRating = persisted?.ratings.find(
        ({ candidate: item }) => item.id === originalWinner.id,
      );
      const loserRating = persisted?.ratings.find(
        ({ candidate: item }) =>
          item.id !== originalWinner.id && ["left", "right"].includes(item.id),
      );
      expect(winnerRating).toMatchObject({ rating: 1016, wins: 1 });
      expect(loserRating).toMatchObject({ rating: 984, losses: 1 });
    },
  );

  it("keeps stale ready and in-flight work while new deficit jobs pin to the new winner", async () => {
    const game = gameState();
    const staleReady = [
      {
        candidate: candidate("stale-head"),
        source: "generated" as const,
        pinnedWinnerId: "old-winner",
        enqueuedAt: "2026-07-15T23:00:00.000Z",
      },
      {
        candidate: candidate("stale-tail"),
        source: "generated" as const,
        pinnedWinnerId: "old-winner",
        enqueuedAt: "2026-07-15T23:01:00.000Z",
      },
    ];
    const staleJob = {
      id: "old-refill",
      kind: "refill" as const,
      createdAt: "2026-07-15T23:02:00.000Z",
      roundNumber: 2,
      winnerSide: "left" as const,
      retainedWinner: candidate("old-winner"),
      rejectedCandidate: candidate("old-loser"),
      selectionHistory: [],
      recentConcepts: [],
      preferenceSeed: game.preferenceSeed,
      sessionId: "session-1",
      pinnedWinnerId: "old-winner",
    };
    const challengers = challengerState(game, {
      ready: staleReady,
      refillJobs: [
        {
          jobId: "old-refill",
          pinnedWinnerId: "old-winner",
          enqueuedAt: "2026-07-15T23:02:00.000Z",
          expectedJob: staleJob,
        },
      ],
      ratings: [
        rating(game.round.leftCandidate),
        rating(game.round.rightCandidate, {
          source: "generated",
          poolMember: false,
        }),
        ...staleReady.map(({ candidate: item }) =>
          rating(item, { source: "generated", poolMember: false }),
        ),
      ],
    });
    const queue = mailbox();
    queue.setWork(staleJob);
    const context = serviceFor({
      game,
      challengers,
      queue,
      bufferTarget: 4,
      createId: ids("new-refill-1", "new-refill-2"),
    });

    await context.service.select("right", 3);

    const persisted = await context.challengerRepository.load();
    const enqueuedJobs = context.queue.enqueue.mock.calls.map(([job]) => job);
    expect(persisted?.ready).toEqual([staleReady[1]]);
    expect(persisted?.refillJobs).toEqual([
      challengers.refillJobs[0],
      {
        jobId: "new-refill-1",
        pinnedWinnerId: "right",
        enqueuedAt: NOW,
        expectedJob: enqueuedJobs[0],
      },
      {
        jobId: "new-refill-2",
        pinnedWinnerId: "right",
        enqueuedAt: NOW,
        expectedJob: enqueuedJobs[1],
      },
    ]);
    expect(await queue.readWork("old-refill")).toEqual(staleJob);
    expect(queue.enqueue).toHaveBeenCalledTimes(2);
    expect(
      queue.enqueue.mock.calls.map(([job]) =>
        job.kind === "refill" ? job.pinnedWinnerId : null,
      ),
    ).toEqual(["right", "right"]);
    expect(
      persisted?.ratings.find(({ candidate: item }) => item.id === "right"),
    ).toMatchObject({ wins: 1, poolMember: true });
  });

  it("admits an unrated generated loser into a non-full reusable pool", async () => {
    const game = gameState();
    game.round.leftCandidate = {
      ...game.round.leftCandidate,
      imageUrl: "/seed-assets/left.png",
    };
    const ready = challengerState(game).ready;
    const challengers = challengerState(game, {
      ready,
      ratings: [
        rating(game.round.leftCandidate),
        ...ready.map(({ candidate: item }) => rating(item)),
      ],
    });
    const context = serviceFor({ game, challengers });

    await context.service.select("left", 3);

    expect(
      (await context.challengerRepository.load())?.ratings.find(
        ({ candidate: item }) => item.id === "right",
      ),
    ).toMatchObject({ source: "generated", poolMember: true, losses: 1 });
  });

  it("serializes concurrent selections so only one consumes the FIFO head", async () => {
    const game = gameState();
    const challengers = challengerState(game, {
      ready: [challengerState(game).ready[0]],
    });
    const gameRepository = new MemoryGameRepository(game);
    const challengerRepository = new MemoryChallengerRepository(challengers);
    const queue = mailbox();
    const first = serviceFor({
      gameRepository,
      challengerRepository,
      queue,
      bufferTarget: 1,
      createId: ids("first-refill"),
    }).service;
    const second = serviceFor({
      gameRepository,
      challengerRepository,
      queue,
      bufferTarget: 1,
      createId: ids("second-refill"),
    }).service;

    const outcomes = await Promise.allSettled([
      first.select("left", 3),
      second.select("right", 3),
    ]);

    expect(
      outcomes.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = outcomes.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.any(SelectionConflictError),
    });
    expect((await challengerRepository.load())?.ready).toEqual([]);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("replays the prepared FIFO head when the completed game save fails", async () => {
    const game = gameState();
    const backingGame = new MemoryGameRepository(game);
    let failCompletedSave = true;
    const gameRepository: GameRepository = {
      load: () => backingGame.load(),
      clear: () => backingGame.clear(),
      withLock: (operation) => backingGame.withLock(operation),
      save: async (state) => {
        if (failCompletedSave && state.round.status === "idle") {
          failCompletedSave = false;
          throw new Error("game disk unavailable");
        }
        await backingGame.save(state);
      },
    };
    const context = serviceFor({ game, gameRepository });

    await expect(context.service.select("left", 3)).rejects.toThrow(
      "game disk unavailable",
    );
    await expect(backingGame.load()).resolves.toMatchObject({
      round: { status: "generating", roundNumber: 3 },
      pendingSelection: { kind: "buffer", winnerSide: "left" },
    });
    const prepared = await context.challengerRepository.load();
    expect(prepared?.ready[0].candidate.id).toBe("buffer-1");
    expect(prepared?.refillJobs).toMatchObject([{ jobId: "refill-1" }]);

    const recovered = await context.service.reconcile();

    expect(recovered?.round).toMatchObject({
      status: "idle",
      roundNumber: 4,
      rightCandidate: { id: "buffer-1" },
    });
    const persisted = await context.challengerRepository.load();
    expect(persisted?.ready.map(({ candidate: item }) => item.id)).toEqual([
      "buffer-2",
      "buffer-3",
      "buffer-4",
      "buffer-5",
    ]);
    expect(
      persisted?.ratings.find(({ candidate: item }) => item.id === "left"),
    ).toMatchObject({ wins: 1, rating: 1016 });
  });

  it("replays an unsaved comparison exactly once after service restart", async () => {
    const game = gameState();
    const generatedWinner = game.round.rightCandidate;
    const initialChallengers = challengerState(game, {
      ratings: [
        rating(game.round.leftCandidate),
        rating(generatedWinner, {
          source: "generated",
          poolMember: false,
        }),
        ...challengerState(game).ready.map(({ candidate: item }) =>
          rating(item),
        ),
      ],
    });
    const gameRepository = new MemoryGameRepository(game);
    const backingChallengers = new MemoryChallengerRepository(
      initialChallengers,
    );
    let failComparisonSave = true;
    const challengerRepository: ChallengerRepository = {
      load: () => backingChallengers.load(),
      clearSession: (sessionId) => backingChallengers.clearSession(sessionId),
      withLock: (operation) => backingChallengers.withLock(operation),
      save: async (state) => {
        if (failComparisonSave) {
          failComparisonSave = false;
          throw new Error("challenger disk unavailable");
        }
        await backingChallengers.save(state);
      },
    };
    const queue = mailbox();
    const first = serviceFor({
      game,
      gameRepository,
      challengerRepository,
      queue,
      createId: ids("failed-attempt", "restart-refill"),
    });

    await expect(first.service.select("right", 3)).rejects.toThrow(
      "challenger disk unavailable",
    );
    await expect(gameRepository.load()).resolves.toMatchObject({
      round: { status: "generating", roundNumber: 3 },
      pendingSelection: { kind: "buffer", winnerSide: "right" },
    });

    const restarted = serviceFor({
      gameRepository,
      challengerRepository,
      queue,
      createId: ids("restart-refill"),
    });
    const recovered = await restarted.service.reconcile();
    await restarted.service.reconcile();

    expect(recovered?.round).toMatchObject({
      status: "idle",
      roundNumber: 4,
      leftCandidate: { id: "buffer-1" },
      rightCandidate: { id: generatedWinner.id },
    });
    const persisted = await backingChallengers.load();
    expect(
      persisted?.ratings.find(
        ({ candidate: item }) => item.id === generatedWinner.id,
      ),
    ).toMatchObject({
      rating: 1016,
      wins: 1,
      losses: 0,
      poolMember: true,
    });
    expect(
      persisted?.ratings.find(
        ({ candidate: item }) => item.id === game.round.leftCandidate.id,
      ),
    ).toMatchObject({ rating: 984, wins: 0, losses: 1 });
    expect(recovered?.history).toHaveLength(game.history.length + 1);
  });

  it("waits three seconds before drawing a random eligible fallback", async () => {
    let currentNow = NOW;
    const now = () => currentNow;
    const game = gameState();
    const eligibleA = candidate("eligible-a");
    const eligibleB = candidate("eligible-b");
    const recentWinner = candidate("recent-winner");
    const recentLoser = candidate("recent-loser");
    const challengers = challengerState(game, {
      ready: [],
      ratings: [
        rating(game.round.leftCandidate),
        rating(game.round.rightCandidate),
        rating(recentWinner),
        rating(recentLoser),
        rating(eligibleA),
        rating(eligibleB),
      ],
      generationTurnaroundEmaMs: 100_000,
    });
    const context = serviceFor({
      game,
      challengers,
      now,
      random: () => 0.75,
      bufferTarget: 1,
    });

    const selected = await context.service.select("left", 3);

    expect(selected.round.status).toBe("generating");
    await expect(context.challengerRepository.load()).resolves.toMatchObject({
      consecutiveFallbackDraws: 0,
      nextFallbackAt: "2026-07-16T01:00:03.000Z",
    });

    currentNow = "2026-07-16T01:00:02.999Z";
    expect((await context.service.reconcile())?.round.status).toBe(
      "generating",
    );

    currentNow = "2026-07-16T01:00:03.000Z";
    const completed = await context.service.reconcile();
    expect(completed?.round.rightCandidate.id).toBe("eligible-b");
    expect(completed?.round.status).toBe("idle");
    await expect(context.challengerRepository.load()).resolves.toMatchObject({
      consecutiveFallbackDraws: 1,
      nextFallbackAt: null,
    });
  });

  it("allows a tenth fallback and hard-stops an eleventh", async () => {
    let currentNow = NOW;
    const now = () => currentNow;
    const game = gameState();
    const challengers = challengerState(game, {
      ready: [],
      ratings: [
        rating(game.round.leftCandidate),
        rating(game.round.rightCandidate),
        rating(candidate("fallback-10")),
        rating(candidate("fallback-11")),
      ],
      consecutiveFallbackDraws: 9,
      nextFallbackAt: null,
    });
    const context = serviceFor({
      game,
      challengers,
      now,
      random: () => 0,
      bufferTarget: 1,
    });
    const waiting = await context.service.select("left", 3);
    expect(waiting.round.status).toBe("generating");
    currentNow = "2026-07-16T01:00:03.000Z";
    const tenth = await context.service.reconcile();
    expect(tenth?.round.rightCandidate.id).toBe("fallback-10");
    expect(tenth?.round.status).toBe("idle");
    await expect(context.challengerRepository.load()).resolves.toMatchObject({
      consecutiveFallbackDraws: 10,
    });

    currentNow = "2026-07-16T01:00:10.000Z";
    const eleventh = await context.service.select("left", 4);
    expect(eleventh.round.status).toBe("generating");
    const stillWaiting = await context.service.reconcile();
    expect(stillWaiting?.round.status).toBe("generating");
    expect(stillWaiting?.round.rightCandidate.id).toBe("fallback-10");
  });

  it("validates a completed refill, updates EMA, and immediately serves a waiting selection", async () => {
    const game = gameState();
    const challengers = challengerState(game, {
      ready: [],
      ratings: [
        rating(game.round.leftCandidate),
        rating(game.round.rightCandidate),
      ],
      consecutiveFallbackDraws: 2,
      nextFallbackAt: "2026-07-16T01:10:00.000Z",
    });
    const context = serviceFor({ game, challengers, bufferTarget: 1 });
    const waiting = await context.service.select("left", 3);
    expect(waiting.round.status).toBe("generating");
    const refill = context.queue.enqueue.mock.calls[0][0];
    context.queue.setResult(
      completedResult(refill.id, "2026-07-16T01:03:20.000Z"),
    );

    const completed = await context.service.reconcile();

    expect(completed?.round.status).toBe("idle");
    expect(completed?.round.leftCandidate).toBe(game.round.leftCandidate);
    expect(completed?.round.rightCandidate).toMatchObject({
      id: `challenger-${refill.id}`,
      imageUrl: `/api/assets/challenger-${refill.id}.png`,
      winCount: 0,
    });
    expect(context.assets.verify).toHaveBeenCalledWith(
      expect.objectContaining({ candidateId: `challenger-${refill.id}` }),
    );
    expect(context.queue.archive).toHaveBeenCalledWith(refill.id);
    const persisted = await context.challengerRepository.load();
    expect(persisted?.generationTurnaroundEmaMs).toBe(125_000);
    expect(persisted).toMatchObject({
      consecutiveFallbackDraws: 0,
      nextFallbackAt: null,
    });
    expect(
      persisted?.ratings.find(
        ({ candidate: item }) => item.id === `challenger-${refill.id}`,
      ),
    ).toMatchObject({
      source: "generated",
      rating: challengerConfig.initialRating,
      poolMember: false,
    });
  });

  it("appends concurrently completed refills in terminal completion order", async () => {
    const game = gameState({
      round: {
        ...gameState().round,
        retainedCandidateId: "left",
        winStreak: 1,
      },
    });
    const jobs: Extract<GenerationJob, { kind: "refill" }>[] = [
      "slow-refill",
      "fast-refill",
    ].map((id) => ({
      id,
      kind: "refill",
      createdAt: NOW,
      roundNumber: 3,
      winnerSide: "left",
      retainedWinner: game.round.leftCandidate,
      rejectedCandidate: game.round.rightCandidate,
      selectionHistory: game.history,
      recentConcepts: [],
      preferenceSeed: game.preferenceSeed,
      sessionId: "session-1",
      pinnedWinnerId: "left",
    }));
    const records = jobs.map((expectedJob) => ({
      jobId: expectedJob.id,
      pinnedWinnerId: expectedJob.pinnedWinnerId,
      enqueuedAt: expectedJob.createdAt,
      expectedJob,
    }));
    const challengers = challengerState(game, {
      ready: [],
      refillJobs: records,
      ratings: [
        rating(game.round.leftCandidate),
        rating(game.round.rightCandidate),
      ],
    });
    const queue = mailbox();
    for (const job of jobs) queue.setWork(job);
    queue.setResult(completedResult("slow-refill", "2026-07-16T01:04:00.000Z"));
    queue.setResult(completedResult("fast-refill", "2026-07-16T01:02:00.000Z"));
    const context = serviceFor({
      game,
      challengers,
      queue,
      bufferTarget: 2,
    });

    await context.service.reconcile();

    expect(
      (await context.challengerRepository.load())?.ready.map(
        ({ candidate: item }) => item.id,
      ),
    ).toEqual(["challenger-fast-refill", "challenger-slow-refill"]);
  });

  it("removes and replaces a failed refill without changing EMA or the waiting round", async () => {
    const game = gameState();
    const challengers = challengerState(game, {
      ready: [],
      ratings: [
        rating(game.round.leftCandidate),
        rating(game.round.rightCandidate),
      ],
    });
    const context = serviceFor({
      game,
      challengers,
      bufferTarget: 1,
      createId: ids("failed-refill", "replacement-refill"),
    });
    const waiting = await context.service.select("right", 3);
    context.queue.setResult({
      jobId: "failed-refill",
      status: "failed",
      completedAt: "2026-07-16T01:01:40.000Z",
      message: "generation interrupted",
      retryable: true,
    });

    const unchanged = await context.service.reconcile();

    expect(unchanged?.round).toEqual(waiting.round);
    expect(unchanged?.history).toEqual(waiting.history);
    await expect(context.challengerRepository.load()).resolves.toMatchObject({
      generationTurnaroundEmaMs: 100_000,
      refillJobs: [
        {
          jobId: "replacement-refill",
          pinnedWinnerId: "right",
        },
      ],
    });
    expect(context.queue.archive).toHaveBeenCalledWith("failed-refill");
    expect(context.queue.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "replacement-refill", kind: "refill" }),
    );
  });

  it("rejects mismatched refill work metadata and restores capacity", async () => {
    const game = gameState();
    const challengers = challengerState(game, {
      ready: [],
      ratings: [
        rating(game.round.leftCandidate),
        rating(game.round.rightCandidate),
      ],
    });
    const context = serviceFor({
      game,
      challengers,
      bufferTarget: 1,
      createId: ids("tampered-refill", "replacement-refill"),
    });
    await context.service.select("left", 3);
    const original = context.queue.enqueue.mock.calls[0][0];
    context.queue.setWork({ ...original, preferenceSeed: "tampered seed" });
    context.queue.setResult(completedResult("tampered-refill"));

    const waiting = await context.service.reconcile();

    expect(waiting?.round.status).toBe("generating");
    expect(context.assets.verify).not.toHaveBeenCalled();
    expect(context.queue.archive).toHaveBeenCalledWith("tampered-refill");
    await expect(context.challengerRepository.load()).resolves.toMatchObject({
      refillJobs: [{ jobId: "replacement-refill" }],
    });
  });

  it.each([
    ["round number", (job: GenerationJob) => ({ ...job, roundNumber: 99 })],
    [
      "winner side",
      (job: GenerationJob) => ({ ...job, winnerSide: "right" as const }),
    ],
    [
      "rejected candidate",
      (job: GenerationJob) => ({
        ...job,
        rejectedCandidate: candidate("tampered-rejected"),
      }),
    ],
    [
      "selection history",
      (job: GenerationJob) => ({ ...job, selectionHistory: [] }),
    ],
    [
      "recent concepts",
      (job: GenerationJob) => ({ ...job, recentConcepts: ["tampered"] }),
    ],
    [
      "preference seed",
      (job: GenerationJob) => ({ ...job, preferenceSeed: "tampered seed" }),
    ],
  ])("rejects tampered %s after service restart", async (_label, tamper) => {
    const game = gameState();
    const gameRepository = new MemoryGameRepository(game);
    const challengerRepository = new MemoryChallengerRepository(
      challengerState(game),
    );
    const queue = mailbox();
    const first = serviceFor({
      gameRepository,
      challengerRepository,
      queue,
      createId: ids("restart-tamper", "replacement-refill"),
    });
    await first.service.select("left", 3);
    const expected = queue.enqueue.mock.calls[0][0];
    queue.setWork(tamper(expected) as GenerationJob);
    queue.setResult(completedResult("restart-tamper"));
    const restartedAssets = verifier();
    const restarted = serviceFor({
      gameRepository,
      challengerRepository,
      queue,
      assets: restartedAssets,
      createId: ids("replacement-refill"),
    });

    await restarted.service.reconcile();

    expect(restartedAssets.verify).not.toHaveBeenCalled();
    expect(queue.archive).toHaveBeenCalledWith("restart-tamper");
    expect(
      (await challengerRepository.load())?.ratings.some(
        ({ candidate: item }) => item.id === "challenger-restart-tamper",
      ),
    ).toBe(false);
  });

  it("re-enqueues the exact persisted refill after restart when publication never happened", async () => {
    const game = gameState();
    const gameRepository = new MemoryGameRepository(game);
    const challengerRepository = new MemoryChallengerRepository(
      challengerState(game),
    );
    const queue = mailbox();
    queue.enqueue.mockRejectedValueOnce(new Error("mailbox unavailable"));
    const first = serviceFor({
      gameRepository,
      challengerRepository,
      queue,
      createId: ids("durable-refill"),
    });

    await expect(first.service.select("left", 3)).rejects.toThrow(
      "mailbox unavailable",
    );
    const expected = structuredClone(queue.enqueue.mock.calls[0][0]);
    queue.enqueue.mockClear();
    const restarted = serviceFor({
      gameRepository,
      challengerRepository,
      queue,
      createId: ids("must-not-replace"),
    });

    await restarted.service.reconcile();

    expect(queue.archive).not.toHaveBeenCalledWith("durable-refill");
    expect(queue.enqueue).toHaveBeenCalledWith(expected);
    expect(await queue.readWork("durable-refill")).toEqual(expected);
    expect((await challengerRepository.load())?.refillJobs).toMatchObject([
      { jobId: "durable-refill" },
    ]);
  });

  it("recovers a lost enqueue acknowledgement from durable refill intent", async () => {
    const game = gameState();
    const context = serviceFor({ game, challengers: challengerState(game) });
    context.queue.enqueue.mockImplementationOnce(async (job) => {
      context.queue.setWork(job);
      throw new Error("lost acknowledgement");
    });

    const selected = await context.service.select("left", 3);

    expect(selected.round.status).toBe("idle");
    expect(await context.queue.readWork("refill-1")).toEqual(
      context.queue.enqueue.mock.calls[0][0],
    );
    await expect(context.challengerRepository.load()).resolves.toMatchObject({
      refillJobs: [{ jobId: "refill-1" }],
    });
  });

  it("retries cleanup without appending or applying a completed refill twice", async () => {
    const game = gameState();
    const challengers = challengerState(game, {
      ready: [],
      ratings: [
        rating(game.round.leftCandidate),
        rating(game.round.rightCandidate),
      ],
    });
    const context = serviceFor({ game, challengers, bufferTarget: 1 });
    await context.service.select("left", 3);
    context.queue.setResult(completedResult("refill-1"));
    context.queue.archive.mockRejectedValueOnce(
      new Error("archive unavailable"),
    );

    await expect(context.service.reconcile()).rejects.toThrow(
      "archive unavailable",
    );
    const afterFailure = await context.challengerRepository.load();
    expect(
      afterFailure?.ratings.filter(
        ({ candidate: item }) => item.id === "challenger-refill-1",
      ),
    ).toHaveLength(1);
    const historyLength = (await context.gameRepository.load())?.history.length;
    expect(historyLength).toBeDefined();

    await expect(context.service.reconcile()).resolves.toMatchObject({
      round: { status: "idle" },
    });
    const afterRetry = await context.challengerRepository.load();
    expect(
      afterRetry?.ratings.filter(
        ({ candidate: item }) => item.id === "challenger-refill-1",
      ),
    ).toHaveLength(1);
    expect((await context.gameRepository.load())?.history).toHaveLength(
      historyLength!,
    );
  });

  it("replays a generated buffer candidate when saving the waiting round fails", async () => {
    const game = gameState();
    const backingGame = new MemoryGameRepository(game);
    let failCompletedSave = false;
    const gameRepository: GameRepository = {
      load: () => backingGame.load(),
      clear: () => backingGame.clear(),
      withLock: (operation) => backingGame.withLock(operation),
      save: async (state) => {
        if (failCompletedSave && state.round.status === "idle") {
          failCompletedSave = false;
          throw new Error("game disk unavailable");
        }
        await backingGame.save(state);
      },
    };
    const challengers = challengerState(game, {
      ready: [],
      ratings: [
        rating(game.round.leftCandidate),
        rating(game.round.rightCandidate),
      ],
      consecutiveFallbackDraws: 2,
    });
    const context = serviceFor({
      game,
      gameRepository,
      challengers,
      bufferTarget: 1,
    });
    await context.service.select("left", 3);
    failCompletedSave = true;
    context.queue.setResult(completedResult("refill-1"));

    await expect(context.service.reconcile()).rejects.toThrow(
      "game disk unavailable",
    );
    await expect(backingGame.load()).resolves.toMatchObject({
      round: { status: "generating" },
      pendingSelection: { kind: "buffer" },
    });
    await expect(context.challengerRepository.load()).resolves.toMatchObject({
      ready: [{ candidate: { id: "challenger-refill-1" } }],
      refillJobs: [{ jobId: "refill-1" }],
    });

    const recovered = await context.service.reconcile();

    expect(recovered?.round).toMatchObject({
      status: "idle",
      rightCandidate: { id: "challenger-refill-1" },
    });
    expect(recovered?.history).toHaveLength(game.history.length + 1);
    expect(context.queue.archive).toHaveBeenCalledWith("refill-1");
  });
});
