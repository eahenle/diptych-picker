import { describe, expect, it } from "vitest";
import type { ChallengerState } from "@/domain/challenger-state";
import {
  beginBufferedSelection,
  beginChampionRetirement,
  beginTie,
  type Candidate,
  type GameRules,
  type GameState,
} from "@/domain/game";
import { MemoryChallengerRepository } from "./challenger-repository";
import { PreparedSelectionReconciler } from "./prepared-selection-reconciler";
import { MemoryGameRepository } from "./repository";

const NOW = "2026-07-25T20:00:00.000Z";
const RULES: GameRules = {
  bufferTarget: 5,
  poolMaximum: 50,
  championRetirementStreak: 2,
  fallbackMaximumConsecutive: 10,
};

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
      retainedCandidateId: null,
      winStreak: 0,
    },
    history: [],
    preferenceSeed: "Architectural portraits with dramatic natural light.",
    gameRules: RULES,
    ...overrides,
  };
}

function challengers(
  current: GameState,
  readyIds: string[] = ["buffer-1", "buffer-2"],
): ChallengerState {
  const ready = readyIds.map((id) => ({
    candidate: candidate(id),
    source: "generated" as const,
    pinnedWinnerId: current.round.leftCandidate.id,
    enqueuedAt: NOW,
  }));
  return {
    version: 1,
    sessionId: "session-1",
    ready,
    refillJobs: [],
    pendingComparison: null,
    pendingSelectionBaseline: null,
    ratings: [
      current.round.leftCandidate,
      current.round.rightCandidate,
      ...ready.map(({ candidate: item }) => item),
    ].map((item) => ({
      candidate: item,
      rating: 1000,
      wins: 0,
      losses: 0,
      source: "generated" as const,
      poolMember: true,
      lastServedAt: null,
    })),
    generationTurnaroundEmaMs: 100_000,
    consecutiveFallbackDraws: 0,
    nextFallbackAt: null,
  };
}

function fixture(currentGame: GameState, state: ChallengerState) {
  const gameRepository = new MemoryGameRepository(currentGame);
  const challengerRepository = new MemoryChallengerRepository(state);
  const reconciler = new PreparedSelectionReconciler({
    gameRepository,
    challengerRepository,
    initialRating: 1000,
    eloKFactor: 32,
    fallbackDelayMs: 5_000,
    now: () => NOW,
    random: () => 0,
    rulesFor: () => RULES,
  });
  return { gameRepository, challengerRepository, reconciler };
}

describe("PreparedSelectionReconciler", () => {
  it("prepares and completes a buffered comparison exactly once", async () => {
    const idle = game();
    const pending = beginBufferedSelection(idle, "left", NOW)!;
    const state = challengers(idle);
    const context = fixture(pending, state);

    const prepared = await context.reconciler.prepare(pending, state);
    expect(prepared.pendingComparison).toMatchObject({
      roundNumber: 4,
      winnerSide: "left",
      winnerId: "left",
      loserId: "right",
    });
    expect(prepared.pendingSelectionBaseline?.ready).toEqual(state.ready);

    const replayed = await context.reconciler.prepare(pending, prepared);
    expect(replayed).toBe(prepared);

    const completed = await context.reconciler.complete(pending, replayed);
    expect(completed.game.round).toMatchObject({
      status: "idle",
      leftCandidate: { id: "left" },
      rightCandidate: { id: "buffer-1" },
      roundNumber: 5,
    });
    expect(
      completed.challengers.ready.map(({ candidate: item }) => item.id),
    ).toEqual(["buffer-2"]);
    expect(completed.challengers.pendingComparison).toBeNull();
    expect(completed.challengers.pendingSelectionBaseline).toBeNull();
  });

  it("rejects a receipt that belongs to a different pending selection", async () => {
    const idle = game();
    const pending = beginBufferedSelection(idle, "left", NOW)!;
    const state = challengers(idle);
    state.pendingComparison = {
      selectedAt: NOW,
      roundNumber: 3,
      winnerSide: "right",
      winnerId: "other-winner",
      loserId: "other-loser",
    };
    const context = fixture(pending, state);

    await expect(context.reconciler.prepare(pending, state)).rejects.toThrow(
      "Persisted comparison receipt does not match the pending selection",
    );
  });

  it("waits for both retirement replacements before completing", async () => {
    const idle = game({
      round: {
        ...game().round,
        retainedCandidateId: "left",
        winStreak: 1,
      },
    });
    const pending = beginChampionRetirement(idle, "left", NOW, 2)!;
    const waitingState = challengers(idle, ["buffer-1"]);
    const context = fixture(pending, waitingState);

    const waiting = await context.reconciler.complete(pending, waitingState);
    expect(waiting.game.round.status).toBe("generating");

    const readyState = challengers(idle);
    const completed = await context.reconciler.complete(pending, readyState);
    expect(completed.game.round).toMatchObject({
      status: "idle",
      leftCandidate: { id: "buffer-1" },
      rightCandidate: { id: "buffer-2" },
      retainedCandidateId: null,
      winStreak: 0,
    });
    expect(completed.challengers.ready).toEqual([]);
  });

  it("completes a tie with two distinct replacements", async () => {
    const idle = game();
    const pending = beginTie(idle, "left", NOW)!;
    const state = challengers(idle);
    const context = fixture(pending, state);

    const completed = await context.reconciler.complete(pending, state);

    expect(completed.game.round).toMatchObject({
      status: "idle",
      leftCandidate: { id: "buffer-1" },
      rightCandidate: { id: "buffer-2" },
    });
    expect(completed.challengers.ready).toEqual([]);
  });

  it("removes displayed candidates from an idle ready queue", async () => {
    const idle = game();
    const state = challengers(idle, ["left", "buffer-1", "right"]);
    const context = fixture(idle, state);

    const cleaned = await context.reconciler.removeDisplayedCandidatesFromReady(
      idle,
      state,
    );

    expect(cleaned.ready.map(({ candidate: item }) => item.id)).toEqual([
      "buffer-1",
    ]);
    expect(
      (await context.challengerRepository.load())?.ready.map(
        ({ candidate: item }) => item.id,
      ),
    ).toEqual(["buffer-1"]);
  });
});
