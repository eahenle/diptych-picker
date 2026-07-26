import { describe, expect, it, vi } from "vitest";
import type { ChallengerState } from "@/domain/challenger-state";
import type { Candidate, GameState } from "@/domain/game";
import { MemoryChallengerRepository } from "./challenger-repository";
import { GameReconciler } from "./game-reconciler";
import { MemoryGameRepository } from "./repository";

const NOW = "2026-07-26T08:00:00.000Z";

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
      roundNumber: 8,
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
  const cleanup = vi.fn(async (value: GameState) => value);
  const reconcileGeneration = vi.fn(async (value: GameState) => value);
  const reconcilePromptCards = vi.fn(async (value: GameState) => value);
  const reconcileLeaderboard = vi.fn(
    async (_game: GameState, value: ChallengerState) => value,
  );
  const prepare = vi.fn(
    async (_game: GameState, value: ChallengerState) => value,
  );
  const complete = vi.fn(
    async (value: GameState, challengerState: ChallengerState) => ({
      game: value,
      challengers: challengerState,
    }),
  );
  const removeDisplayedCandidatesFromReady = vi.fn(
    async (_game: GameState, value: ChallengerState) => value,
  );
  const reconcileRefills = vi.fn(
    async (value: GameState, challengerState: ChallengerState) => ({
      game: value,
      challengers: challengerState,
    }),
  );
  const plan = vi.fn((value: ChallengerState) => ({
    state: value,
    jobs: [],
  }));
  const ensureAll = vi.fn(async () => {});
  const drawFallback = vi.fn((value: ChallengerState) => ({
    state: value,
    candidate: null,
  }));
  const reconciler = new GameReconciler({
    gameRepository,
    challengerRepository,
    generationSelectionReconciler: {
      cleanup,
      reconcile: reconcileGeneration,
    },
    promptCardReconciler: { reconcile: reconcilePromptCards },
    leaderboardProfileReconciler: { reconcile: reconcileLeaderboard },
    preparedSelectionReconciler: {
      prepare,
      complete,
      removeDisplayedCandidatesFromReady,
    },
    refillResultReconciler: { reconcile: reconcileRefills },
    refillCapacityService: { plan },
    generationJobPublisher: { ensureAll },
    rulesFor: (value) => value.gameRules!,
    drawFallback,
  });

  return {
    reconciler,
    gameRepository,
    challengerRepository,
    cleanup,
    reconcileGeneration,
    reconcilePromptCards,
    reconcileLeaderboard,
    prepare,
    complete,
    removeDisplayedCandidatesFromReady,
    reconcileRefills,
    plan,
    ensureAll,
    drawFallback,
  };
}

describe("GameReconciler", () => {
  it("returns null without running reconciliation stages when no game exists", async () => {
    const context = fixture(null, null);

    await expect(context.reconciler.reconcile()).resolves.toBeNull();
    expect(context.cleanup).not.toHaveBeenCalled();
  });

  it("short-circuits a legacy generation selection before challenger stages", async () => {
    const pending = game({
      round: { ...game().round, status: "generating" },
      pendingSelection: {
        kind: "generation",
        winnerSide: "left",
        selectedAt: NOW,
        generationJobId: "generation-1",
      },
    });
    const context = fixture(pending, challengers(pending));
    const loadChallengers = vi.spyOn(context.challengerRepository, "load");

    await expect(context.reconciler.reconcile()).resolves.toMatchObject({
      pendingSelection: pending.pendingSelection,
      round: pending.round,
    });

    expect(context.cleanup).toHaveBeenCalledOnce();
    expect(context.reconcilePromptCards).toHaveBeenCalledOnce();
    expect(context.reconcileGeneration).toHaveBeenCalledOnce();
    expect(loadChallengers).not.toHaveBeenCalled();
    expect(context.reconcileLeaderboard).not.toHaveBeenCalled();
  });

  it("completes a buffered selection before planning refill capacity", async () => {
    const pending = game({
      round: { ...game().round, status: "generating" },
      pendingSelection: {
        kind: "buffer",
        winnerSide: "left",
        selectedAt: NOW,
      },
    });
    const state = challengers(pending);
    const nextCandidate = candidate("ready-1");
    state.ready = [
      {
        candidate: nextCandidate,
        source: "generated",
        pinnedWinnerId: "left",
        enqueuedAt: NOW,
      },
    ];
    state.pendingComparison = {
      roundNumber: pending.round.roundNumber,
      winnerSide: "left",
      winnerId: "left",
      loserId: "right",
      selectedAt: NOW,
    };
    const context = fixture(pending, state);

    const result = await context.reconciler.reconcile();

    expect(result?.round).toMatchObject({
      status: "idle",
      leftCandidate: { id: "left" },
      rightCandidate: { id: "ready-1" },
      roundNumber: 9,
    });
    expect(context.drawFallback).not.toHaveBeenCalled();
    expect(context.plan).toHaveBeenCalledOnce();
    expect(context.plan.mock.invocationCallOrder[0]).toBeGreaterThan(
      context.reconcileRefills.mock.invocationCallOrder[0]!,
    );
    expect(
      (await context.challengerRepository.load())?.pendingComparison,
    ).toBeNull();
  });

  it("coalesces concurrent reconciliation calls", async () => {
    const context = fixture(game(), null);
    let releaseCleanup: (() => void) | undefined;
    context.cleanup.mockImplementation(
      (value) =>
        new Promise((resolve) => {
          releaseCleanup = () => resolve(value);
        }),
    );

    const first = context.reconciler.reconcile();
    const second = context.reconciler.reconcile();
    await vi.waitFor(() => expect(context.cleanup).toHaveBeenCalledOnce());
    releaseCleanup?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ preferenceSeed: game().preferenceSeed }),
      expect.objectContaining({ preferenceSeed: game().preferenceSeed }),
    ]);
    expect(context.cleanup).toHaveBeenCalledOnce();
  });
});
