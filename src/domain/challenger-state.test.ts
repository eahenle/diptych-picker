import { describe, expect, it } from "vitest";
import type { Candidate } from "./game";
import {
  drawFallback,
  popReady,
  promoteWinner,
  recordGenerationTurnaround,
  refillDeficit,
  updateElo,
  type BufferedCandidate,
  type CandidateRating,
  type ChallengerState,
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

  it("promotes a generated winner into a non-full pool without duplicating its ID", () => {
    const winner = rating("winner", 1016, { poolMember: false, wins: 1 });
    const initial = state({ ratings: [rating("incumbent", 1000), winner] });

    const next = promoteWinner(initial, "winner");

    expect(
      next.ratings.filter((item) => item.candidate.id === "winner"),
    ).toHaveLength(1);
    expect(
      next.ratings.find((item) => item.candidate.id === "winner")?.poolMember,
    ).toBe(true);
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

    const next = promoteWinner(initial, "winner");
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

    const next = promoteWinner(initial, "winner");

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
      promoteWinner(initial, "winner").ratings.filter(
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

    const next = promoteWinner(initial, "winner", 51);
    const pool = next.ratings.filter((item) => item.poolMember);

    expect(pool).toHaveLength(50);
    expect(pool.some((item) => item.candidate.id === "winner")).toBe(true);
    expect(pool.some((item) => item.candidate.id === "member-0")).toBe(false);
  });

  it("repairs oversized membership by demoting lowest-rated ties in stable order", () => {
    const oversized = Array.from({ length: 52 }, (_, index) =>
      rating(`member-${index}`, 900 + Math.floor(index / 2)),
    );

    const next = promoteWinner(
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

  it("draws uniformly from eligible pool members and records fallback pacing", () => {
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

    const result = drawFallback(initial, {
      now: "2026-07-16T00:00:00.000Z",
      currentCandidateIds: ["current"],
      recentCandidateIds: ["recent"],
      random: () => 0.75,
    });

    expect(result.candidate?.id).toBe("eligible-b");
    expect(result.state.consecutiveFallbackDraws).toBe(1);
    expect(result.state.nextFallbackAt).toBe("2026-07-16T00:00:50.000Z");
    expect(
      result.state.ratings.find((item) => item.candidate.id === "eligible-b")
        ?.lastServedAt,
    ).toBe("2026-07-16T00:00:00.000Z");
  });

  it("does not draw during cooldown, after two fallbacks, or without an eligible member", () => {
    const eligible = rating("eligible", 1000);
    const duringCooldown = state({
      ratings: [eligible],
      consecutiveFallbackDraws: 1,
      nextFallbackAt: "2026-07-16T00:01:00.000Z",
    });
    const exhausted = state({
      ratings: [eligible],
      consecutiveFallbackDraws: 2,
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

  it("clamps fallback cooldown to thirty seconds and five minutes", () => {
    const pool = [rating("eligible", 1000)];
    const draw = (generationTurnaroundEmaMs: number) =>
      drawFallback(state({ ratings: pool, generationTurnaroundEmaMs }), {
        now: "2026-07-16T00:00:00.000Z",
        currentCandidateIds: [],
        recentCandidateIds: [],
        random: () => 0,
      }).state.nextFallbackAt;

    expect(draw(10_000)).toBe("2026-07-16T00:00:30.000Z");
    expect(draw(1_000_000)).toBe("2026-07-16T00:05:00.000Z");
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
        },
      ],
    });

    expect(refillDeficit(initial)).toBe(2);
    expect(
      refillDeficit({ ...initial, ready: Array(5).fill(buffered("x")) }),
    ).toBe(0);
  });
});
