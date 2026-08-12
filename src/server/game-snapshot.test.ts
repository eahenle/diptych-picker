import { describe, expect, it, vi } from "vitest";
import type { ChallengerState } from "@/domain/challenger-state";
import {
  composePreferenceSeed,
  preferenceProfileFromSeed,
  type Candidate,
  type GameState,
  type GenerationPromptCard,
} from "@/domain/game";
import {
  deriveActivationDisplayReceiptId,
  deriveDequeueOperationId,
  type ImportSession,
} from "@/domain/import-session";
import { MemoryChallengerRepository } from "./challenger-repository";
import {
  GAME_SNAPSHOT_FORMAT,
  GAME_SNAPSHOT_VERSION,
  GameSnapshotService,
  GameSnapshotUnavailableError,
  InvalidGameSnapshotError,
  parseGameSnapshot,
} from "./game-snapshot";
import { MemoryInitialBootstrapRepository } from "./initial-bootstrap";
import { MemoryImportSessionRepository } from "./import-session-repository";
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
        importItemId: null,
        pinnedWinnerId: "left",
        enqueuedAt: NOW,
      },
    ],
    importQueue: [],
    refillJobs: [],
    pendingComparison: null,
    ratings: candidates.map((item, index) => ({
      candidate: item,
      rating: 1000 + index,
      wins: index === 0 ? 3 : 0,
      losses: index === 1 ? 1 : 0,
      source: "generated" as const,
      importItemId: null,
      poolMember: true,
      lastServedAt: null,
      favorite: index === 0,
    })),
    generationTurnaroundEmaMs: 120_000,
    consecutiveFallbackDraws: 4,
    nextFallbackAt: null,
  };
}

function importedFixture(): {
  game: GameState;
  challengers: ChallengerState;
  importSession: ImportSession;
} {
  const game = gameState();
  const challengers = challengerState();
  const firstDigest = "a".repeat(64);
  const secondDigest = "b".repeat(64);
  const thirdDigest = "c".repeat(64);
  const first = {
    ...game.round.leftCandidate,
    id: "imported-left",
    imageUrl: `/api/assets/${firstDigest}.png`,
  };
  const second = {
    ...candidate("imported-queued"),
    imageUrl: `/api/assets/${secondDigest}.png`,
  };
  const third = {
    ...candidate("imported-served"),
    imageUrl: `/api/assets/${thirdDigest}.png`,
  };
  game.round.leftCandidate = first;
  challengers.ratings = challengers.ratings.map((rating) =>
    rating.candidate.id === "left"
      ? {
          ...rating,
          candidate: first,
          source: "imported" as const,
          importItemId: "import-item-1",
          poolMember: false,
          poolEligible: true,
        }
      : rating,
  );
  challengers.importQueue = [
    {
      candidate: second,
      source: "imported",
      importItemId: "import-item-2",
      pinnedWinnerId: null,
      enqueuedAt: NOW,
    },
  ];
  challengers.ratings.push({
    candidate: third,
    rating: 1000,
    wins: 0,
    losses: 0,
    source: "imported",
    importItemId: "import-item-3",
    poolMember: false,
    poolEligible: true,
    lastServedAt: NOW,
  });
  const originalReceipt = {
    selectedAt: NOW,
    roundNumber: 7,
    winnerSide: "left" as const,
    winnerId: "imported-left",
    loserId: "old-loser",
  };
  const item = (
    id: string,
    digest: string,
    candidateValue: Candidate,
    status: "ready" | "served",
  ) => ({
    id,
    normalizedDigest: digest,
    status,
    asset: {
      digest,
      filename: `${digest}.png`,
      url: `/api/assets/${digest}.png`,
      contentType: "image/png" as const,
      width: 1024 as const,
      height: 1024 as const,
      byteLength: 1024,
    },
    annotationJob: null,
    annotation: {
      concept: candidateValue.concept,
      prompt: candidateValue.prompt,
      style: candidateValue.style,
      reasoningSummary: "Visible imported composition.",
      source: "automated" as const,
    },
    candidateId: candidateValue.id,
    failureMessage: null,
    approvedAt: NOW,
    readyAt: NOW,
    servedAt: status === "served" ? NOW : null,
  });
  return {
    game,
    challengers,
    importSession: {
      version: 1,
      id: "import-session-source",
      status: "active",
      createdAt: NOW,
      sealedAt: NOW,
      activatedAt: NOW,
      items: [
        item("import-item-1", firstDigest, first, "served"),
        item("import-item-2", secondDigest, second, "ready"),
        item("import-item-3", thirdDigest, third, "served"),
      ],
      initialFillJobs: [],
      initialFillRetry: null,
      servedReceipts: [
        {
          kind: "activation-display",
          activationDisplayReceiptId: deriveActivationDisplayReceiptId(
            "activation-source",
            "import-session-source",
            "initial-left",
          ),
          activationIntentId: "activation-source",
          importSessionId: "import-session-source",
          replacementSlot: "initial-left",
          importItemId: "import-item-1",
          candidateId: first.id,
          candidate: first,
          provenance: "imported",
          servedAt: NOW,
        },
        {
          kind: "dequeue",
          dequeueOperationId: deriveDequeueOperationId(
            "import-session-source",
            "source-session",
            originalReceipt,
            "single",
          ),
          importSessionId: "import-session-source",
          originalReceipt,
          replacementSlot: "single",
          importItemId: "import-item-3",
          candidateId: third.id,
          candidate: third,
          provenance: "imported",
          roundNumber: 8,
          servedAt: NOW,
        },
      ],
    },
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

function withPromptCardBlendJob(game: GameState): GameState {
  const first = game.promptDeck?.cards[0] ?? {
    id: "card-1",
    title: "Copper nocturne",
    prompt: "A severe copper-lit industrial editorial portrait.",
    negativePrompt: "readable text",
    weight: 1,
    tags: ["portrait", "copper"],
    parents: [],
    active: true,
    createdAt: NOW,
    stats: { wins: 0, rejects: 0 },
  };
  const second = {
    ...first,
    id: "card-2",
    title: "Glass botany",
    prompt: "Translucent botanical structures in soft green daylight.",
    tags: ["botanical", "glass"],
  };
  const expectedJob = {
    id: "blend-1",
    kind: "prompt-card-blender" as const,
    createdAt: NOW,
    cards: [
      {
        id: first.id,
        title: first.title,
        prompt: first.prompt,
        negativePrompt: first.negativePrompt,
        tags: first.tags,
      },
      {
        id: second.id,
        title: second.title,
        prompt: second.prompt,
        negativePrompt: second.negativePrompt,
        tags: second.tags,
      },
    ] as [GenerationPromptCard, GenerationPromptCard],
    ratio: 0.5,
  };
  return {
    ...game,
    promptDeck: {
      enabled: game.promptDeck?.enabled ?? true,
      cards: [first, second],
      verdicts: game.promptDeck?.verdicts ?? [],
      editorJob: game.promptDeck?.editorJob ?? null,
      blendJob: {
        jobId: expectedJob.id,
        cardIds: [first.id, second.id],
        enqueuedAt: NOW,
        expectedJob,
      },
      suggestions: game.promptDeck?.suggestions ?? [],
    },
  };
}

function withPromptCardWriterJob(game: GameState): GameState {
  const sourceCandidateIds = ["favorite-1", "favorite-2", "favorite-3"];
  const sources = sourceCandidateIds.map((candidateId, index) => {
    const filename = `${String(index + 1).repeat(64)}.png`;
    return {
      candidateId,
      concept: `Favorite ${index + 1}`,
      style: ["photographic"],
      sourceImage: {
        filename,
        path: `profile-sources/${filename}`,
        contentType: "image/png" as const,
        width: 1024,
        height: 1024,
        byteLength: 4096,
      },
    };
  });
  const expectedJob = {
    id: "writer-1",
    kind: "prompt-card-writer" as const,
    createdAt: NOW,
    sources,
  };
  return {
    ...game,
    promptDeck: {
      enabled: game.promptDeck?.enabled ?? false,
      cards: game.promptDeck?.cards ?? [],
      verdicts: game.promptDeck?.verdicts ?? [],
      editorJob: game.promptDeck?.editorJob ?? null,
      blendJob: game.promptDeck?.blendJob ?? null,
      writerJob: {
        jobId: expectedJob.id,
        sourceCandidateIds,
        enqueuedAt: NOW,
        expectedJob,
      },
      suggestions: game.promptDeck?.suggestions ?? [],
    },
  };
}

function service(options: {
  game?: GameState | null;
  challengers?: ChallengerState | null;
  verifyCandidateAsset?: (
    candidate: Candidate,
    source: "generated" | "curated" | "imported",
  ) => Promise<void>;
  createId?: () => string;
  importSession?: ImportSession | null;
}) {
  const gameRepository = new MemoryGameRepository(options.game ?? null);
  const challengerRepository = new MemoryChallengerRepository(
    options.challengers ?? null,
  );
  const archive = vi.fn(async () => undefined);
  const verifyCandidateAsset = vi.fn(
    options.verifyCandidateAsset ?? (async () => undefined),
  );
  const verifyImportedAsset = vi.fn(async () => undefined);
  const importSessionRepository = new MemoryImportSessionRepository(
    options.importSession ?? null,
  );
  return {
    snapshotService: new GameSnapshotService({
      gameRepository,
      challengerRepository,
      bootstrapRepository: new MemoryInitialBootstrapRepository(),
      mailbox: { archive },
      verifyCandidateAsset,
      importSessionRepository,
      verifyImportedAsset,
      now: () => NOW,
      createId: options.createId ?? (() => "restored-session"),
    }),
    gameRepository,
    challengerRepository,
    importSessionRepository,
    archive,
    verifyCandidateAsset,
    verifyImportedAsset,
  };
}

describe("GameSnapshotService", () => {
  it("continues to parse legacy version-one saves without import state", () => {
    expect(
      parseGameSnapshot({
        format: GAME_SNAPSHOT_FORMAT,
        version: 1,
        exportedAt: NOW,
        game: gameState(),
        challengers: challengerState(),
      }),
    ).toMatchObject({ version: 1 });
  });

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
      version: GAME_SNAPSHOT_VERSION,
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

  it("exports without session-bound prompt-card jobs", async () => {
    const context = service({
      game: withPromptCardWriterJob(
        withPromptCardBlendJob(withPromptCardEditorJob(gameState())),
      ),
      challengers: challengerState(),
    });

    const snapshot = await context.snapshotService.export();

    expect(snapshot.game.promptDeck?.editorJob).toBeNull();
    expect(snapshot.game.promptDeck?.blendJob).toBeNull();
    expect(snapshot.game.promptDeck?.writerJob).toBeNull();
    expect(snapshot.game.promptDeck?.cards[0].editorRejectCheckpoint).toBe(0);
    expect(snapshot.game.promptDeck?.verdicts).toHaveLength(4);
  });

  it("exports and restores an activated imported stream with fresh durable IDs", async () => {
    const imported = importedFixture();
    const source = service(imported);

    const snapshot = await source.snapshotService.export();

    expect(snapshot.version).toBe(GAME_SNAPSHOT_VERSION);
    expect(snapshot.importSession).toMatchObject({
      status: "active",
      items: [
        { id: "import-item-1", status: "served" },
        { id: "import-item-2", status: "ready" },
        { id: "import-item-3", status: "served" },
      ],
      servedReceipts: [
        {
          kind: "activation-display",
          replacementSlot: "initial-left",
          importItemId: "import-item-1",
        },
        {
          kind: "dequeue",
          replacementSlot: "single",
          importItemId: "import-item-3",
        },
      ],
    });
    expect(snapshot.importSession?.servedReceipts[0]).not.toHaveProperty(
      "activationDisplayReceiptId",
    );
    expect(snapshot.importSession?.servedReceipts[0]).not.toHaveProperty(
      "activationIntentId",
    );
    expect(snapshot.importSession?.servedReceipts[1]).not.toHaveProperty(
      "dequeueOperationId",
    );

    const ids = [
      "challenger-restored",
      "import-session-restored",
      "activation-restored",
    ];
    const target = service({
      game: gameState(),
      challengers: challengerState(),
      importSession: null,
      createId: () => ids.shift()!,
    });
    await target.snapshotService.import(snapshot);

    const restoredImport = await target.importSessionRepository.load();
    expect(restoredImport).toMatchObject({
      id: "import-session-restored",
      items: [
        { id: "import-item-1", status: "served" },
        { id: "import-item-2", status: "ready" },
        { id: "import-item-3", status: "served" },
      ],
      servedReceipts: [
        {
          kind: "activation-display",
          activationIntentId: "activation-restored",
          importSessionId: "import-session-restored",
          importItemId: "import-item-1",
        },
        {
          kind: "dequeue",
          importSessionId: "import-session-restored",
          replacementSlot: "single",
          importItemId: "import-item-3",
        },
      ],
    });
    const restoredDequeue = restoredImport?.servedReceipts.find(
      (receipt) => receipt.kind === "dequeue",
    );
    expect(restoredDequeue?.kind).toBe("dequeue");
    if (restoredDequeue?.kind === "dequeue") {
      expect(restoredDequeue.dequeueOperationId).toBe(
        deriveDequeueOperationId(
          "import-session-restored",
          "challenger-restored",
          restoredDequeue.originalReceipt,
          "single",
        ),
      );
    }
    expect(
      (await target.challengerRepository.load())?.importQueue[0],
    ).toMatchObject({
      candidate: { id: "imported-queued" },
      importItemId: "import-item-2",
    });
    expect(target.verifyImportedAsset).toHaveBeenCalledTimes(3);
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
      game: withPromptCardWriterJob(
        withPromptCardBlendJob(
          withPromptCardEditorJob({ ...gameState(), history: [] }),
        ),
      ),
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
    expect(target.archive).toHaveBeenCalledWith("blend-1");
    expect(target.archive).toHaveBeenCalledWith("writer-1");
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
