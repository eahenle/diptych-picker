import { describe, expect, it, vi } from "vitest";
import type { ChallengerState } from "@/domain/challenger-state";
import type { Candidate, GameState } from "@/domain/game";
import { MemoryChallengerRepository } from "./challenger-repository";
import {
  GAME_SNAPSHOT_FORMAT,
  GameSnapshotService,
  GameSnapshotUnavailableError,
  InvalidGameSnapshotError,
} from "./game-snapshot";
import { MemoryInitialBootstrapRepository } from "./initial-bootstrap";
import { MemoryGameRepository } from "./repository";

const NOW = "2026-07-17T12:00:00.000Z";

function candidate(id: string): Candidate {
  return {
    id,
    imageUrl: `/api/assets/${id}.png`,
    prompt: `${id} prompt`,
    concept: `${id} concept`,
    style: ["photographic"],
    createdAt: NOW,
    winCount: 0,
  };
}

function gameState(): GameState {
  return {
    round: {
      leftCandidate: candidate("left"),
      rightCandidate: candidate("right"),
      status: "idle",
      replacingSide: null,
      roundNumber: 8,
      retainedCandidateId: "left",
      winStreak: 3,
    },
    history: [
      {
        winnerId: "left",
        loserId: "old-loser",
        winnerPrompt: "left prompt",
        loserPrompt: "old prompt",
        winnerConcept: "left concept",
        loserConcept: "old concept",
        selectedAt: NOW,
      },
    ],
    preferenceSeed: "Prefer cinematic mechanical botany",
  };
}

function challengerState(): ChallengerState {
  const candidates = [
    candidate("left"),
    candidate("right"),
    candidate("ready"),
  ];
  return {
    version: 1,
    sessionId: "source-session",
    ready: [
      {
        candidate: candidates[2],
        source: "generated",
        pinnedWinnerId: "left",
        enqueuedAt: NOW,
      },
    ],
    refillJobs: [],
    pendingComparison: null,
    ratings: candidates.map((item, index) => ({
      candidate: item,
      rating: 1000 + index,
      wins: index === 0 ? 3 : 0,
      losses: index === 1 ? 1 : 0,
      source: "generated" as const,
      poolMember: true,
      lastServedAt: null,
    })),
    generationTurnaroundEmaMs: 120_000,
    consecutiveFallbackDraws: 4,
    nextFallbackAt: null,
  };
}

function withRefillJob(state: ChallengerState): ChallengerState {
  const game = gameState();
  const expectedJob = {
    id: "old-refill",
    kind: "refill" as const,
    createdAt: NOW,
    roundNumber: game.round.roundNumber,
    winnerSide: "left" as const,
    retainedWinner: game.round.leftCandidate,
    rejectedCandidate: game.round.rightCandidate,
    selectionHistory: game.history,
    recentConcepts: [game.round.leftCandidate.concept],
    preferenceSeed: game.preferenceSeed,
    sessionId: "current-session",
    pinnedWinnerId: game.round.leftCandidate.id,
  };
  return {
    ...state,
    sessionId: "current-session",
    refillJobs: [
      {
        jobId: expectedJob.id,
        pinnedWinnerId: expectedJob.pinnedWinnerId,
        enqueuedAt: expectedJob.createdAt,
        expectedJob,
      },
    ],
  };
}

function service(options: {
  game?: GameState | null;
  challengers?: ChallengerState | null;
  verifyCandidateAsset?: (
    candidate: Candidate,
    source: "generated" | "curated",
  ) => Promise<void>;
  createId?: () => string;
}) {
  const gameRepository = new MemoryGameRepository(options.game ?? null);
  const challengerRepository = new MemoryChallengerRepository(
    options.challengers ?? null,
  );
  const archive = vi.fn(async () => undefined);
  const verifyCandidateAsset = vi.fn(
    options.verifyCandidateAsset ?? (async () => undefined),
  );
  return {
    snapshotService: new GameSnapshotService({
      gameRepository,
      challengerRepository,
      bootstrapRepository: new MemoryInitialBootstrapRepository(),
      mailbox: { archive },
      verifyCandidateAsset,
      now: () => NOW,
      createId: options.createId ?? (() => "restored-session"),
    }),
    gameRepository,
    challengerRepository,
    archive,
    verifyCandidateAsset,
  };
}

describe("GameSnapshotService", () => {
  it("exports a versioned restorable snapshot without session-bound work", async () => {
    const context = service({
      game: gameState(),
      challengers: { ...challengerState(), nextFallbackAt: NOW },
    });

    const snapshot = await context.snapshotService.export();

    expect(snapshot).toMatchObject({
      format: GAME_SNAPSHOT_FORMAT,
      version: 1,
      exportedAt: NOW,
      game: { round: { roundNumber: 8 } },
      challengers: {
        sessionId: "source-session",
        refillJobs: [],
        pendingComparison: null,
        nextFallbackAt: null,
      },
    });
  });

  it("exports the last stable comparison while the next challenger is loading", async () => {
    const stableGame = gameState();
    const game = structuredClone(stableGame);
    game.round.status = "generating";
    game.round.replacingSide = "right";
    game.pendingSelection = {
      kind: "buffer",
      winnerSide: "left",
      selectedAt: NOW,
    };
    const stableChallengers = challengerState();
    const challengers: ChallengerState = {
      ...stableChallengers,
      pendingComparison: {
        selectedAt: NOW,
        roundNumber: stableGame.round.roundNumber,
        winnerSide: "left",
        winnerId: "left",
        loserId: "right",
      },
      pendingSelectionBaseline: {
        ready: stableChallengers.ready,
        ratings: stableChallengers.ratings,
        generationTurnaroundEmaMs: stableChallengers.generationTurnaroundEmaMs,
        consecutiveFallbackDraws: stableChallengers.consecutiveFallbackDraws,
        nextFallbackAt: stableChallengers.nextFallbackAt,
      },
      ratings: stableChallengers.ratings.map((item) =>
        item.candidate.id === "left"
          ? { ...item, rating: item.rating + 16, wins: item.wins + 1 }
          : item.candidate.id === "right"
            ? { ...item, rating: item.rating - 16, losses: item.losses + 1 }
            : item,
      ),
      nextFallbackAt: "2026-07-17T12:00:03.000Z",
    };
    const context = service({ game, challengers });

    const snapshot = await context.snapshotService.export();

    expect(snapshot.game).toEqual({
      ...stableGame,
      preferenceProfile: expect.any(Object),
    });
    expect(snapshot.challengers).toMatchObject({
      ready: stableChallengers.ready,
      ratings: stableChallengers.ratings,
      pendingComparison: null,
      pendingSelectionBaseline: null,
      refillJobs: [],
      nextFallbackAt: null,
    });
    await expect(context.gameRepository.load()).resolves.toMatchObject({
      round: { status: "generating" },
      pendingSelection: { kind: "buffer" },
    });
    await expect(context.challengerRepository.load()).resolves.toMatchObject({
      pendingComparison: { winnerId: "left" },
      nextFallbackAt: "2026-07-17T12:00:03.000Z",
    });
  });

  it("refuses to export legacy in-progress work without a stable baseline", async () => {
    const game = gameState();
    game.round.status = "generating";
    game.round.replacingSide = "right";
    game.pendingSelection = {
      kind: "generation",
      winnerSide: "left",
      selectedAt: NOW,
      generationJobId: "legacy-job",
    };
    const context = service({ game, challengers: challengerState() });

    await expect(context.snapshotService.export()).rejects.toBeInstanceOf(
      GameSnapshotUnavailableError,
    );
  });

  it("restores validated state under a fresh session and verifies every asset", async () => {
    const source = service({
      game: gameState(),
      challengers: challengerState(),
    });
    const snapshot = await source.snapshotService.export();
    const target = service({
      game: { ...gameState(), history: [] },
      challengers: withRefillJob(challengerState()),
      createId: () => "new-session",
    });

    const imported = await target.snapshotService.import(snapshot);

    expect(imported).toEqual(snapshot.game);
    await expect(target.gameRepository.load()).resolves.toEqual(snapshot.game);
    await expect(target.challengerRepository.load()).resolves.toMatchObject({
      sessionId: "new-session",
      ready: snapshot.challengers.ready,
      ratings: snapshot.challengers.ratings,
      refillJobs: [],
      pendingComparison: null,
    });
    expect(target.verifyCandidateAsset).toHaveBeenCalledTimes(3);
    expect(target.archive).toHaveBeenCalledWith("old-refill");
  });

  it("rejects unavailable assets before changing the current game", async () => {
    const source = service({
      game: gameState(),
      challengers: challengerState(),
    });
    const snapshot = await source.snapshotService.export();
    const current = { ...gameState(), history: [] };
    const target = service({
      game: current,
      challengers: challengerState(),
      verifyCandidateAsset: vi.fn(async () => {
        throw new Error("missing");
      }),
    });
    const before = await target.gameRepository.load();

    await expect(
      target.snapshotService.import(snapshot),
    ).rejects.toBeInstanceOf(InvalidGameSnapshotError);
    await expect(target.gameRepository.load()).resolves.toEqual(before);
  });
});
