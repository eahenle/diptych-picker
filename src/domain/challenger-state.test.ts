import { describe, expect, it } from "vitest";
import type { Candidate } from "./game";
import {
  admitGeneratedCandidate,
  backfillGeneratedPool,
  drawFallback,
  popReady,
  recordGenerationTurnaround,
  refillDeficit,
  summarizeBufferHealth,
  summarizeComparisonHistory,
  summarizeDisplayedEloRatings,
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
  poolMember: true,
  lastServedAt: null,
  ...overrides,
});

const state = (overrides: Partial<ChallengerState> = {}): ChallengerState => ({
  version: 1,
  sessionId: "session-1",
  ready: [],
  refillJobs: [],
  pendingComparison: null,
  ratings: [],
  generationTurnaroundEmaMs: 300_000,
  consecutiveFallbackDraws: 0,
  nextFallbackAt: null,
  ...overrides,
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
      target: 5,
      pool: 1,
      poolMaximum: 50,
    });
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
});
