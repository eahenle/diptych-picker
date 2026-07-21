import { describe, expect, it, vi } from "vitest";
import type { ChallengerState } from "@/domain/challenger-state";
import {
  composePreferenceSeed,
  preferenceProfileFromSeed,
  type Candidate,
  type GameState,
} from "@/domain/game";
import { MemoryChallengerRepository } from "./challenger-repository";
import {
  GAME_SNAPSHOT_FORMAT,
  GameSnapshotService,
  GameSnapshotUnavailableError,
  InvalidGameSnapshotError,
  parseGameSnapshot,
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
    preferenceRevision: {
      themes: "Cinematic mechanical botany studies",
      inspiration: "low-key lighting",
      mediaTypes: "photography",
      visualStyle: "cinematic",
      colorPalette: "copper and ultraviolet",
      contentLevel: "family-friendly",
      avoid: "readable text",
    },
  };
}

function gameState(): GameState {
  const preferenceProfile = {
    ...preferenceProfileFromSeed("Prefer cinematic mechanical botany"),
    inspiration: "low-key lighting",
    adaptationMode: "adaptive" as const,
    adaptationSourceWinnerIds: ["left"],
  };
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
    preferenceSeed: composePreferenceSeed(preferenceProfile),
    preferenceProfile,
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
      favorite: index === 0,
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

function withPromptCardEditorJob(game: GameState): GameState {
  const card = {
    id: "card-1",
    title: "Copper nocturne",
    prompt: "A severe copper-lit industrial editorial portrait.",
    negativePrompt: "readable text",
    weight: 1,
    tags: ["portrait", "copper"],
    parents: [],
    active: true,
    createdAt: NOW,
    stats: { wins: 0, rejects: 4 },
    editorRejectCheckpoint: 4,
  };
  const recentRejections = Array.from({ length: 4 }, (_, index) => ({
    resultId: `rejected-${index + 1}`,
    reason: "Selected comparison winner",
    recordedAt: `2026-07-17T11:00:0${index}.000Z`,
  }));
  const expectedJob = {
    id: "editor-1",
    kind: "prompt-card-editor" as const,
    createdAt: NOW,
    card: {
      id: card.id,
      title: card.title,
      prompt: card.prompt,
      negativePrompt: card.negativePrompt,
      tags: card.tags,
    },
    recentRejections,
  };
  return {
    ...game,
    promptDeck: {
      enabled: true,
      cards: [card],
      verdicts: recentRejections.map((evidence) => ({
        cardId: card.id,
        ...evidence,
        verdict: "reject" as const,
      })),
      editorJob: {
        jobId: expectedJob.id,
        cardId: card.id,
        enqueuedAt: NOW,
        previousRejectCheckpoint: 0,
        expectedJob,
      },
      suggestions: [],
    },
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
  it.each([
    [
      "an oversized candidate preference revision",
      (game: GameState) => {
        game.round.leftCandidate.preferenceRevision!.themes = "x".repeat(2_001);
      },
    ],
    [
      "too many adaptive source winners",
      (game: GameState) => {
        game.preferenceProfile!.adaptationSourceWinnerIds = Array.from(
          { length: 13 },
          (_, index) => `winner-${index}`,
        );
      },
    ],
  ])("rejects %s in an imported snapshot", (_label, mutate) => {
    const game = gameState();
    mutate(game);

    expect(() =>
      parseGameSnapshot({
        format: GAME_SNAPSHOT_FORMAT,
        version: 1,
        exportedAt: NOW,
        game,
        challengers: challengerState(),
      }),
    ).toThrow(InvalidGameSnapshotError);
  });

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

  it("exports an editor request as replayable rejection evidence", async () => {
    const context = service({
      game: withPromptCardEditorJob(gameState()),
      challengers: challengerState(),
    });

    const snapshot = await context.snapshotService.export();

    expect(snapshot.game.promptDeck?.editorJob).toBeNull();
    expect(snapshot.game.promptDeck?.cards[0].editorRejectCheckpoint).toBe(0);
    expect(snapshot.game.promptDeck?.verdicts).toHaveLength(4);
  });

  it.each(["buffer", "retirement"] as const)(
    "exports the last stable comparison while a %s selection is loading",
    async (pendingKind) => {
      const stableGame = gameState();
      const game = structuredClone(stableGame);
      game.round.status = "generating";
      game.round.replacingSide = pendingKind === "retirement" ? null : "right";
      game.pendingSelection = {
        kind: pendingKind,
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
          generationTurnaroundEmaMs:
            stableChallengers.generationTurnaroundEmaMs,
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
        pendingSelection: { kind: pendingKind },
      });
      await expect(context.challengerRepository.load()).resolves.toMatchObject({
        pendingComparison: { winnerId: "left" },
        nextFallbackAt: "2026-07-17T12:00:03.000Z",
      });
    },
  );

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
      game: withPromptCardEditorJob({ ...gameState(), history: [] }),
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
    expect(target.archive).toHaveBeenCalledWith("editor-1");
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
