import { describe, expect, it, vi } from "vitest";
import type { ChallengerState } from "@/domain/challenger-state";
import type { Candidate, GameState } from "@/domain/game";
import { MemoryChallengerRepository } from "./challenger-repository";
import type { GenerationJobPublisher } from "./generation-job-publisher";
import { RefillCapacityService } from "./refill-capacity-service";
import { MemoryGameRepository } from "./repository";

const NOW = "2026-07-26T06:00:00.000Z";

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

function game(overrides: Partial<GameState> = {}): GameState {
  return {
    round: {
      leftCandidate: candidate("left"),
      rightCandidate: candidate("right"),
      status: "idle",
      replacingSide: null,
      roundNumber: 4,
      retainedCandidateId: "left",
      winStreak: 2,
    },
    history: [],
    preferenceSeed: "Architectural portraits in dramatic natural light.",
    gameRules: {
      bufferTarget: 2,
      poolMaximum: 12,
      championRetirementStreak: 4,
      fallbackMaximumConsecutive: 3,
    },
    ...overrides,
  };
}

function challengers(current: GameState): ChallengerState {
  return {
    version: 1,
    sessionId: "session-1",
    ready: [],
    refillJobs: [],
    pendingComparison: null,
    pendingSelectionBaseline: null,
    ratings: [current.round.leftCandidate, current.round.rightCandidate].map(
      (item) => ({
        candidate: item,
        rating: 1000,
        wins: 0,
        losses: 0,
        source: "curated" as const,
        poolMember: true,
        lastServedAt: null,
      }),
    ),
    generationTurnaroundEmaMs: 100_000,
    consecutiveFallbackDraws: 0,
    nextFallbackAt: null,
  };
}

function fixture(
  current: GameState | null = game(),
  state: ChallengerState | null = current ? challengers(current) : null,
) {
  const gameRepository = new MemoryGameRepository(current);
  const challengerRepository = new MemoryChallengerRepository(state);
  const ensureAll = vi.fn<GenerationJobPublisher["ensureAll"]>(async () => {});
  let nextId = 0;
  const service = new RefillCapacityService({
    gameRepository,
    challengerRepository,
    publisher: { ensureAll },
    rulesFor: (value) => value.gameRules!,
    leaderboardVisualProfile: () => undefined,
    createId: () => `refill-${++nextId}`,
    now: () => NOW,
    random: () => 0,
  });
  return {
    service,
    gameRepository,
    challengerRepository,
    ensureAll,
  };
}

describe("RefillCapacityService", () => {
  it("plans the exact saved-rule deficit with durable expected work", () => {
    const current = game();
    const state = challengers(current);
    const context = fixture(current, state);

    const capacity = context.service.plan(state, {
      game: current,
      winnerSide: "left",
      retainedWinner: current.round.leftCandidate,
      rejectedCandidate: current.round.rightCandidate,
    });

    expect(capacity.jobs.map(({ id }) => id)).toEqual(["refill-1", "refill-2"]);
    expect(capacity.state.refillJobs).toEqual([
      expect.objectContaining({
        jobId: "refill-1",
        expectedJob: capacity.jobs[0],
      }),
      expect.objectContaining({
        jobId: "refill-2",
        expectedJob: capacity.jobs[1],
      }),
    ]);
  });

  it("persists planned intent before publishing refill jobs", async () => {
    const context = fixture();

    await context.service.ensure();

    const persisted = await context.challengerRepository.load();
    expect(persisted?.refillJobs.map(({ jobId }) => jobId)).toEqual([
      "refill-1",
      "refill-2",
    ]);
    expect(context.ensureAll).toHaveBeenCalledWith(
      persisted?.refillJobs.map(({ expectedJob }) => expectedJob),
    );
  });

  it("does nothing without a retained-winner context or capacity deficit", async () => {
    const noWinner = game({
      round: { ...game().round, retainedCandidateId: null },
    });
    const noWinnerContext = fixture(noWinner, challengers(noWinner));
    await noWinnerContext.service.ensure();
    expect(noWinnerContext.ensureAll).not.toHaveBeenCalled();

    const full = game();
    const fullState = challengers(full);
    fullState.ready = ["ready-1", "ready-2"].map((id) => ({
      candidate: candidate(id),
      source: "generated",
      pinnedWinnerId: "left",
      enqueuedAt: NOW,
    }));
    const fullContext = fixture(full, fullState);
    await fullContext.service.ensure();
    expect(fullContext.ensureAll).not.toHaveBeenCalled();
    expect((await fullContext.challengerRepository.load())?.refillJobs).toEqual(
      [],
    );
  });
});
