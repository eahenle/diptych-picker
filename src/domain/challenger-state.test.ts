import { describe, expect, it } from "vitest";
import type { Candidate, GameState, SelectionHistory } from "./game";
import {
  admitGeneratedCandidate,
  backfillGeneratedPool,
  drawFallback,
  drawFallbackBatch,
  popReady,
  recordGenerationTurnaround,
  refillJobMatchesGenerationPreferences,
  refillDeficit,
  summarizeBufferHealth,
  summarizeComparisonHistory,
  summarizeDisplayedEloRatings,
  summarizeDisplayedScores,
  summarizeFavoriteGallery,
  summarizeLeaderboardPreferenceEvidence,
  summarizePoolLeaderboard,
  updateElo,
  type BufferedCandidate,
  type CandidateRating,
  type ChallengerState,
  type RefillJobRecord,
} from "./challenger-state";

const candidate = (id: string): Candidate => ({
  id,
  imageUrl: `/api/assets/${id}.png`,
  prompt: `${id} prompt`,
  concept: `${id} concept`,
  style: [id],
  createdAt: "2026-07-16T00:00:00.000Z",
  winCount: 0,
});

const buffered = (id: string): BufferedCandidate => ({
  candidate: candidate(id),
  source: "generated",
  importItemId: null,
  pinnedWinnerId: "winner",
  enqueuedAt: "2026-07-16T00:00:00.000Z",
});

const rating = (
  id: string,
  value: number,
  overrides: Partial<CandidateRating> = {},
): CandidateRating => ({
  candidate: candidate(id),
  rating: value,
  wins: 0,
  losses: 0,
  source: "generated",
  importItemId: null,
  poolMember: true,
  lastServedAt: null,
  ...overrides,
});

const state = (overrides: Partial<ChallengerState> = {}): ChallengerState => ({
  version: 1,
  sessionId: "session-1",
  ready: [],
  importQueue: [],
  refillJobs: [],
  pendingComparison: null,
  ratings: [],
  generationTurnaroundEmaMs: 300_000,
  consecutiveFallbackDraws: 0,
  nextFallbackAt: null,
  ...overrides,
});

const game = (history: SelectionHistory[] = []): GameState => ({
  round: {
    leftCandidate: candidate("left"),
    rightCandidate: candidate("right"),
    status: "idle",
    replacingSide: null,
    roundNumber: history.length + 1,
    retainedCandidateId: null,
    winStreak: 0,
  },
  history,
  preferenceSeed: "novel test preferences",
});

const priorComparison = (): SelectionHistory => ({
  winnerId: "left",
  loserId: "right",
  winnerPrompt: "left prompt",
  loserPrompt: "right prompt",
  winnerConcept: "left concept",
  loserConcept: "right concept",
  selectedAt: "2026-07-16T00:00:00.000Z",
});

const refillJob = (id: string): RefillJobRecord => ({
  jobId: id,
  pinnedWinnerId: "winner",
  enqueuedAt: "2026-07-16T00:00:00.000Z",
  expectedJob: {
    id,
    kind: "refill",
    createdAt: "2026-07-16T00:00:00.000Z",
    roundNumber: 1,
    winnerSide: "left",
    retainedWinner: candidate("winner"),
    rejectedCandidate: candidate("loser"),
    selectionHistory: [],
    recentConcepts: [],
    preferenceSeed: "novel test preferences",
    sessionId: "session-1",
    pinnedWinnerId: "winner",
  },
});

describe("challenger state", () => {
  it("updates equal Elo ratings after a decisive comparison", () => {
    expect(updateElo(1000, 1000, 32)).toEqual({
      winner: 1016,
      loser: 984,
    });
  });

  it("pops exactly one candidate from the FIFO", () => {
    const first = buffered("first");
    const second = buffered("second");

    const result = popReady(
      state({
        ready: [first, second],
        consecutiveFallbackDraws: 2,
        nextFallbackAt: "2026-07-16T00:10:00.000Z",
      }),
    );

    expect(result.candidate).toBe(first.candidate);
    expect(result.state.ready).toEqual([second]);
    expect(result.state.consecutiveFallbackDraws).toBe(0);
    expect(result.state.nextFallbackAt).toBeNull();
  });

  it("returns no candidate without changing an empty FIFO", () => {
    const initial = state();

    expect(popReady(initial)).toEqual({ candidate: null, state: initial });
  });

  it("summarizes only queue, refill, and reusable-pool counts", () => {
    expect(
      summarizeBufferHealth(
        state({
          ready: [buffered("ready-1"), buffered("ready-2")],
          refillJobs: [refillJob("job-1")],
          ratings: [
            rating("retained", 1016),
            rating("excluded", 984, { poolMember: false }),
          ],
        }),
        5,
        50,
      ),
    ).toEqual({
      ready: 2,
      inFlight: 1,
      active: 1,
      pending: 0,
      draining: 0,
      target: 5,
      pool: 1,
      poolMaximum: 50,
    });
  });

  it("identifies refill work from an earlier preference configuration", () => {
    const record = refillJob("job-1");
    const current = game();

    expect(
      refillJobMatchesGenerationPreferences(record.expectedJob, current),
    ).toBe(true);
    expect(
      refillJobMatchesGenerationPreferences(record.expectedJob, {
        ...current,
        preferenceSeed: "a newly composed preference seed",
      }),
    ).toBe(false);
  });

  it("rounds displayed Elo ratings and falls back for an unrated candidate", () => {
    expect(
      summarizeDisplayedEloRatings(
        state({ ratings: [rating("left", 1016.49)] }),
        "left",
        "right",
        1000,
      ),
    ).toEqual({ left: 1016, right: 1000 });
  });

  it("replaces Elo with a first-appearance cue before either candidate has history", () => {
    expect(
      summarizeDisplayedScores(
        state({ ratings: [rating("left", 1000), rating("right", 1000)] }),
        game(),
      ),
    ).toEqual({ left: "new", right: "new" });
  });

  it("marks a prior candidate whose next loss will evict it from a full pool", () => {
    expect(
      summarizeDisplayedScores(
        state({
          ratings: [
            rating("left", 900),
            rating("right", 950, { poolMember: false }),
            rating("incumbent", 1000),
          ],
        }),
        game([priorComparison()]),
        1000,
        32,
        2,
      ),
    ).toEqual({ left: "pool-exit", right: 950 });
  });

  it("keeps numeric Elo when a loss cannot evict the candidate", () => {
    expect(
      summarizeDisplayedScores(
        state({
          ratings: [
            rating("left", 900),
            rating("right", 950, { poolMember: false }),
            rating("incumbent", 1000),
          ],
        }),
        game([priorComparison()]),
        1000,
        32,
        3,
      ),
    ).toEqual({ left: 900, right: 950 });
  });

  it("promotes a generated winner into a non-full pool without duplicating its ID", () => {
    const winner = rating("winner", 1016, { poolMember: false, wins: 1 });
    const initial = state({ ratings: [rating("incumbent", 1000), winner] });

    const next = admitGeneratedCandidate(initial, "winner");

    expect(
      next.ratings.filter((item) => item.candidate.id === "winner"),
    ).toHaveLength(1);
    expect(
      next.ratings.find((item) => item.candidate.id === "winner")?.poolMember,
    ).toBe(true);
  });

  it("admits a zero-win generated candidate while the pool has room", () => {
    const loser = rating("loser", 984, {
      poolMember: false,
      losses: 1,
    });

    const next = admitGeneratedCandidate(
      state({ ratings: [rating("incumbent", 1000), loser] }),
      "loser",
    );

    expect(
      next.ratings.find((item) => item.candidate.id === "loser"),
    ).toMatchObject({ wins: 0, losses: 1, poolMember: true });
  });

  it("eventually evicts a weak zero-win member for a better candidate", () => {
    const weak = rating("weak", 984, { losses: 1 });
    const established = Array.from({ length: 49 }, (_, index) =>
      rating(`established-${index}`, 1000 + index),
    );
    const better = rating("better", 1100, {
      poolMember: false,
      wins: 1,
    });

    const next = admitGeneratedCandidate(
      state({ ratings: [weak, ...established, better] }),
      "better",
    );

    expect(next.ratings.filter((item) => item.poolMember)).toHaveLength(50);
    expect(
      next.ratings.find((item) => item.candidate.id === "weak")?.poolMember,
    ).toBe(false);
    expect(
      next.ratings.find((item) => item.candidate.id === "better")?.poolMember,
    ).toBe(true);
  });

  it("backfills a small pool with the strongest generated candidates regardless of wins", () => {
    const initial = state({
      ratings: [
        rating("incumbent", 1000),
        rating("weak", 900, {
          poolMember: false,
          losses: 2,
        }),
        rating("middle", 950, {
          poolMember: false,
          losses: 1,
        }),
        rating("strong", 1050, {
          poolMember: false,
          wins: 1,
        }),
      ],
    });

    const next = backfillGeneratedPool(initial, 3);
    const poolIds = next.ratings
      .filter((item) => item.poolMember)
      .map((item) => item.candidate.id);

    expect(poolIds).toEqual(["incumbent", "middle", "strong"]);
    expect(
      next.ratings.find((item) => item.candidate.id === "middle"),
    ).toMatchObject({ wins: 0, losses: 1, poolMember: true });
    expect(
      next.ratings.find((item) => item.candidate.id === "weak")?.poolMember,
    ).toBe(false);
  });

  it("trims the weakest members when the pool maximum is lowered", () => {
    const initial = state({
      ratings: [
        rating("weak", 900),
        rating("middle", 1000),
        rating("strong", 1100),
      ],
    });

    const next = backfillGeneratedPool(initial, 2);

    expect(
      next.ratings
        .filter((item) => item.poolMember)
        .map((item) => item.candidate.id),
    ).toEqual(["middle", "strong"]);
    expect(
      next.ratings.find((item) => item.candidate.id === "weak"),
    ).toMatchObject({ poolMember: false });
  });

  it("never backfills a candidate permanently rejected from the pool", () => {
    const initial = state({
      ratings: [
        rating("incumbent", 1000),
        rating("dual-rejected", 1200, {
          source: "generated",
          poolMember: false,
          poolEligible: false,
          losses: 1,
        }),
        rating("eligible", 900, {
          source: "generated",
          poolMember: false,
        }),
      ],
    });

    const next = backfillGeneratedPool(initial, 2);

    expect(
      next.ratings.find((item) => item.candidate.id === "dual-rejected"),
    ).toMatchObject({ poolMember: false, poolEligible: false });
    expect(
      next.ratings.find((item) => item.candidate.id === "eligible"),
    ).toMatchObject({ poolMember: true });
  });

  it("displaces only the lowest-rated member when a full pool has a strict-higher winner", () => {
    const members = Array.from({ length: 50 }, (_, index) =>
      rating(`member-${index}`, 900 + index),
    );
    const initial = state({
      ratings: [
        ...members,
        rating("winner", 901, { poolMember: false, wins: 1 }),
      ],
    });

    const next = admitGeneratedCandidate(initial, "winner");
    const pool = next.ratings.filter((item) => item.poolMember);

    expect(pool).toHaveLength(50);
    expect(pool.some((item) => item.candidate.id === "winner")).toBe(true);
    expect(pool.some((item) => item.candidate.id === "member-0")).toBe(false);
  });

  it("does not displace an equally rated member from a full pool", () => {
    const members = Array.from({ length: 50 }, (_, index) =>
      rating(`member-${index}`, 900 + index),
    );
    const initial = state({
      ratings: [
        ...members,
        rating("winner", 900, { poolMember: false, wins: 1 }),
      ],
    });

    const next = admitGeneratedCandidate(initial, "winner");

    expect(next.ratings.filter((item) => item.poolMember)).toHaveLength(50);
    expect(
      next.ratings.find((item) => item.candidate.id === "winner")?.poolMember,
    ).toBe(false);
    expect(
      next.ratings.find((item) => item.candidate.id === "member-0")?.poolMember,
    ).toBe(true);
  });

  it("never expands effective pool membership beyond fifty candidates", () => {
    const members = Array.from({ length: 50 }, (_, index) =>
      rating(`member-${index}`, 1000 + index),
    );
    const initial = state({
      ratings: [
        ...members,
        rating("winner", 999, { poolMember: false, wins: 1 }),
      ],
    });

    expect(
      admitGeneratedCandidate(initial, "winner").ratings.filter(
        (item) => item.poolMember,
      ),
    ).toHaveLength(50);
  });

  it("clamps an attempted pool maximum above fifty", () => {
    const members = Array.from({ length: 50 }, (_, index) =>
      rating(`member-${index}`, 1000 + index),
    );
    const initial = state({
      ratings: [
        ...members,
        rating("winner", 1100, { poolMember: false, wins: 1 }),
      ],
    });

    const next = admitGeneratedCandidate(initial, "winner", 51);
    const pool = next.ratings.filter((item) => item.poolMember);

    expect(pool).toHaveLength(50);
    expect(pool.some((item) => item.candidate.id === "winner")).toBe(true);
    expect(pool.some((item) => item.candidate.id === "member-0")).toBe(false);
  });

  it("repairs oversized membership by demoting lowest-rated ties in stable order", () => {
    const oversized = Array.from({ length: 52 }, (_, index) =>
      rating(`member-${index}`, 900 + Math.floor(index / 2)),
    );

    const next = admitGeneratedCandidate(
      state({
        ratings: [
          ...oversized,
          rating("winner", 800, { poolMember: false, wins: 1 }),
        ],
      }),
      "winner",
    );
    const poolIds = next.ratings
      .filter((item) => item.poolMember)
      .map((item) => item.candidate.id);

    expect(poolIds).toHaveLength(50);
    expect(poolIds).not.toContain("member-0");
    expect(poolIds).not.toContain("member-1");
    expect(poolIds).toContain("member-2");
    expect(poolIds).not.toContain("winner");
  });

  it("waits three seconds, then draws uniformly from eligible pool members", () => {
    const initial = state({
      ratings: [
        rating("current", 1000),
        rating("recent", 1000),
        rating("eligible-a", 1000),
        rating("eligible-b", 1000),
        rating("excluded", 1000, { poolMember: false }),
      ],
      generationTurnaroundEmaMs: 100_000,
    });

    const armed = drawFallback(initial, {
      now: "2026-07-16T00:00:00.000Z",
      currentCandidateIds: ["current"],
      recentCandidateIds: ["recent"],
      random: () => 0.75,
    });
    expect(armed.candidate).toBeNull();
    expect(armed.state.nextFallbackAt).toBe("2026-07-16T00:00:03.000Z");

    const result = drawFallback(armed.state, {
      now: "2026-07-16T00:00:03.000Z",
      currentCandidateIds: ["current"],
      recentCandidateIds: ["recent"],
      random: () => 0.75,
    });

    expect(result.candidate?.id).toBe("eligible-b");
    expect(result.state.consecutiveFallbackDraws).toBe(1);
    expect(result.state.nextFallbackAt).toBeNull();
    expect(
      result.state.ratings.find((item) => item.candidate.id === "eligible-b")
        ?.lastServedAt,
    ).toBe("2026-07-16T00:00:03.000Z");
  });

  it("does not draw during the delay, after ten fallbacks, or without an eligible member", () => {
    const eligible = rating("eligible", 1000);
    const duringCooldown = state({
      ratings: [eligible],
      consecutiveFallbackDraws: 1,
      nextFallbackAt: "2026-07-16T00:01:00.000Z",
    });
    const exhausted = state({
      ratings: [eligible],
      consecutiveFallbackDraws: 10,
    });
    const excluded = state({ ratings: [eligible] });

    expect(
      drawFallback(duringCooldown, {
        now: "2026-07-16T00:00:59.999Z",
        currentCandidateIds: [],
        recentCandidateIds: [],
        random: () => 0,
      }).candidate,
    ).toBeNull();
    expect(
      drawFallback(exhausted, {
        now: "2026-07-16T00:02:00.000Z",
        currentCandidateIds: [],
        recentCandidateIds: [],
        random: () => 0,
      }).candidate,
    ).toBeNull();
    expect(
      drawFallback(excluded, {
        now: "2026-07-16T00:02:00.000Z",
        currentCandidateIds: ["eligible"],
        recentCandidateIds: [],
        random: () => 0,
      }).candidate,
    ).toBeNull();
  });

  it("accepts a service-provided delay and draw cap without changing defaults", () => {
    const initial = state({
      ratings: [rating("eligible", 1000)],
      generationTurnaroundEmaMs: 400,
    });

    const armed = drawFallback(initial, {
      now: "2026-07-16T00:00:00.000Z",
      currentCandidateIds: [],
      recentCandidateIds: [],
      random: () => 0,
      delayMs: 200,
      maximumConsecutiveDraws: 1,
    });

    expect(armed.candidate).toBeNull();
    expect(armed.state.nextFallbackAt).toBe("2026-07-16T00:00:00.200Z");
    const result = drawFallback(armed.state, {
      now: "2026-07-16T00:00:00.200Z",
      currentCandidateIds: [],
      recentCandidateIds: [],
      random: () => 0,
      delayMs: 200,
      maximumConsecutiveDraws: 1,
    });
    expect(result.candidate?.id).toBe("eligible");
    expect(
      drawFallback(result.state, {
        now: "2026-07-16T00:00:01.000Z",
        currentCandidateIds: [],
        recentCandidateIds: [],
        random: () => 0,
        maximumConsecutiveDraws: 1,
      }).candidate,
    ).toBeNull();
  });

  it("draws a distinct fallback pair after one shared delay", () => {
    const initial = state({
      ratings: [
        rating("current", 1000),
        rating("eligible-a", 1000),
        rating("eligible-b", 1000),
        rating("eligible-c", 1000),
      ],
    });
    const options = {
      now: "2026-07-16T00:00:00.000Z",
      currentCandidateIds: ["current"],
      recentCandidateIds: [] as string[],
      random: () => 0,
    };

    const armed = drawFallbackBatch(initial, options, 2);
    expect(armed.candidates).toEqual([]);
    expect(armed.state.nextFallbackAt).toBe("2026-07-16T00:00:03.000Z");

    const result = drawFallbackBatch(
      armed.state,
      { ...options, now: "2026-07-16T00:00:03.000Z" },
      2,
    );
    expect(result.candidates.map(({ id }) => id)).toEqual([
      "eligible-a",
      "eligible-b",
    ]);
    expect(result.state.consecutiveFallbackDraws).toBe(2);
    expect(result.state.nextFallbackAt).toBeNull();
  });

  it("does not partially draw a fallback batch", () => {
    const initial = state({ ratings: [rating("eligible", 1000)] });

    const result = drawFallbackBatch(
      initial,
      {
        now: "2026-07-16T00:00:00.000Z",
        currentCandidateIds: [],
        recentCandidateIds: [],
        random: () => 0,
      },
      2,
    );

    expect(result).toEqual({ candidates: [], state: initial });
  });

  it("updates generation turnaround with a 0.25 exponential moving average", () => {
    const next = recordGenerationTurnaround(
      state({ generationTurnaroundEmaMs: 300_000 }),
      "2026-07-16T00:00:00.000Z",
      "2026-07-16T00:01:40.000Z",
    );

    expect(next.generationTurnaroundEmaMs).toBe(250_000);
  });

  it("computes refill work from ready and active jobs without going negative", () => {
    const initial = state({
      ready: [buffered("ready-1"), buffered("ready-2")],
      refillJobs: [
        {
          jobId: "job-1",
          pinnedWinnerId: "winner",
          enqueuedAt: "2026-07-16T00:00:00.000Z",
          expectedJob: {
            id: "job-1",
            kind: "refill",
            createdAt: "2026-07-16T00:00:00.000Z",
            roundNumber: 1,
            winnerSide: "left",
            retainedWinner: candidate("winner"),
            rejectedCandidate: candidate("loser"),
            selectionHistory: [],
            recentConcepts: [],
            preferenceSeed: "novel test preferences",
            sessionId: "session-1",
            pinnedWinnerId: "winner",
          },
        },
      ],
    });

    expect(refillDeficit(initial)).toBe(2);
    expect(
      refillDeficit({ ...initial, ready: Array(5).fill(buffered("x")) }),
    ).toBe(0);
  });

  it("ranks only reusable pool members without exposing prompts", () => {
    const entries = summarizePoolLeaderboard(
      state({
        ratings: [
          rating("runner-up", 1012.4, { wins: 4, losses: 2 }),
          rating("leader", 1044.6, {
            wins: 6,
            losses: 1,
            source: "curated",
            favorite: true,
          }),
          rating("excluded", 1200, { poolMember: false }),
        ],
      }),
    );

    expect(entries).toEqual([
      {
        rank: 1,
        candidate: {
          id: "leader",
          imageUrl: "/api/assets/leader.png",
          concept: "leader concept",
          style: ["leader"],
        },
        rating: 1045,
        wins: 6,
        losses: 1,
        source: "curated",
        favorite: true,
      },
      expect.objectContaining({
        rank: 2,
        candidate: expect.objectContaining({ id: "runner-up" }),
        rating: 1012,
      }),
    ]);
    expect(JSON.stringify(entries)).not.toContain("prompt");
    expect(JSON.stringify(entries)).not.toContain("excluded");
  });

  it("ranks every favorite without exposing prompts or requiring pool membership", () => {
    const entries = summarizeFavoriteGallery(
      state({
        ratings: [
          rating("pooled", 1012.4, { favorite: true }),
          rating("archived", 1044.6, {
            wins: 6,
            losses: 1,
            poolMember: false,
            favorite: true,
          }),
          rating("not-favorite", 1200),
        ],
      }),
    );

    expect(entries).toEqual([
      {
        rank: 1,
        candidate: {
          id: "archived",
          imageUrl: "/api/assets/archived.png",
          concept: "archived concept",
          style: ["archived"],
        },
        rating: 1045,
        wins: 6,
        losses: 1,
        source: "generated",
        poolMember: false,
      },
      expect.objectContaining({
        rank: 2,
        candidate: expect.objectContaining({ id: "pooled" }),
        poolMember: true,
      }),
    ]);
    expect(JSON.stringify(entries)).not.toContain("prompt");
    expect(JSON.stringify(entries)).not.toContain("not-favorite");
  });

  it("bounds adaptive evidence to leaderboard leaders and trailers", () => {
    const ratings = Array.from({ length: 16 }, (_, index) =>
      rating(`candidate-${index + 1}`, 1200 - index * 20, {
        wins: 16 - index,
        losses: index,
        favorite: index === 0,
      }),
    );
    ratings[0].candidate = {
      ...ratings[0].candidate,
      prompt: "private winning prompt",
      style: ["one", "two", "three", "four", "not included"],
    };

    const evidence = summarizeLeaderboardPreferenceEvidence(
      state({ ratings }),
      6,
    );

    expect(evidence).toMatchObject({
      poolSize: 16,
      entries: [
        { rank: 1, candidateId: "candidate-1", favorite: true },
        { rank: 2, candidateId: "candidate-2" },
        { rank: 3, candidateId: "candidate-3" },
        { rank: 14, candidateId: "candidate-14" },
        { rank: 15, candidateId: "candidate-15" },
        { rank: 16, candidateId: "candidate-16" },
      ],
    });
    expect(evidence.entries[0].style).toEqual(["one", "two", "three", "four"]);
    expect(JSON.stringify(evidence)).not.toContain("private winning prompt");
    expect(evidence.entries).toHaveLength(6);
  });

  it("reranks reusable evidence after excluding an imported leader", () => {
    const evidence = summarizeLeaderboardPreferenceEvidence(
      state({
        ratings: [
          rating("imported", 1200, {
            source: "imported",
            importItemId: "import-item-1",
          }),
          rating("reusable-first", 1180),
          rating("reusable-second", 1160),
        ],
      }),
      3,
    );

    expect(evidence).toMatchObject({
      poolSize: 2,
      entries: [
        { rank: 1, candidateId: "reusable-first" },
        { rank: 2, candidateId: "reusable-second" },
      ],
    });
  });

  it("builds newest-first display-safe comparison history", () => {
    const entries = summarizeComparisonHistory(
      [
        {
          winnerId: "first-winner",
          loserId: "first-loser",
          winnerPrompt: "private first winner prompt",
          loserPrompt: "private first loser prompt",
          winnerConcept: "stored first winner",
          loserConcept: "stored first loser",
          selectedAt: "2026-07-16T00:01:00.000Z",
        },
        {
          winnerId: "latest-winner",
          loserId: "missing-loser",
          winnerPrompt: "private latest winner prompt",
          loserPrompt: "private missing loser prompt",
          winnerConcept: "stored latest winner",
          loserConcept: "archived loser concept",
          selectedAt: "2026-07-16T00:02:00.000Z",
        },
      ],
      state({
        ratings: [
          rating("first-winner", 1016),
          rating("first-loser", 984),
          rating("latest-winner", 1030, { favorite: true }),
        ],
      }),
    );

    expect(entries).toEqual([
      {
        outcome: "selection",
        decisionNumber: 2,
        selectedAt: "2026-07-16T00:02:00.000Z",
        winner: {
          id: "latest-winner",
          imageUrl: "/api/assets/latest-winner.png",
          concept: "latest-winner concept",
          style: ["latest-winner"],
          favorite: true,
        },
        loser: {
          id: "missing-loser",
          imageUrl: null,
          concept: "archived loser concept",
          style: [],
          favorite: null,
        },
      },
      expect.objectContaining({
        decisionNumber: 1,
        winner: expect.objectContaining({ id: "first-winner" }),
      }),
    ]);
    expect(JSON.stringify(entries)).not.toContain("prompt");
  });

  it("keeps ties neutral and display-safe in comparison history", () => {
    const entries = summarizeComparisonHistory(
      [
        {
          outcome: "tie",
          leftId: "left",
          rightId: "right",
          leftPrompt: "private left prompt",
          rightPrompt: "private right prompt",
          leftConcept: "stored left",
          rightConcept: "stored right",
          selectedAt: "2026-07-16T00:03:00.000Z",
        },
      ],
      state({ ratings: [rating("left", 1000), rating("right", 1000)] }),
    );

    expect(entries).toEqual([
      {
        outcome: "tie",
        decisionNumber: 1,
        selectedAt: "2026-07-16T00:03:00.000Z",
        left: expect.objectContaining({ id: "left" }),
        right: expect.objectContaining({ id: "right" }),
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain("prompt");
  });

  it("keeps dual rejections display-safe in comparison history", () => {
    const entries = summarizeComparisonHistory(
      [
        {
          outcome: "both-lose",
          leftId: "left",
          rightId: "right",
          leftPrompt: "private left prompt",
          rightPrompt: "private right prompt",
          leftConcept: "stored left",
          rightConcept: "stored right",
          selectedAt: "2026-07-16T00:04:00.000Z",
        },
      ],
      state({ ratings: [rating("left", 1000), rating("right", 1000)] }),
    );

    expect(entries).toEqual([
      {
        outcome: "both-lose",
        decisionNumber: 1,
        selectedAt: "2026-07-16T00:04:00.000Z",
        left: expect.objectContaining({ id: "left" }),
        right: expect.objectContaining({ id: "right" }),
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain("prompt");
  });
});
