import { describe, expect, it, vi } from "vitest";
import type {
  CandidateRating,
  ChallengerState,
} from "@/domain/challenger-state";
import type { Candidate, GameState } from "@/domain/game";
import type { ImportSession } from "@/domain/import-session";
import { MemoryChallengerRepository } from "./challenger-repository";
import { CandidateDequeueService } from "./candidate-dequeue-service";
import { GameSelectionService } from "./game-selection-service";
import { MemoryImportActivationIntentRepository } from "./import-activation-intent-repository";
import { MemoryImportSessionRepository } from "./import-session-repository";
import { MemoryInitialBootstrapRepository } from "./initial-bootstrap";
import { PreparedSelectionReconciler } from "./prepared-selection-reconciler";
import { MemoryGameRepository } from "./repository";
import { StateLockCoordinator } from "./state-lock-coordinator";

const NOW = "2026-07-26T09:00:00.000Z";
const RULES = {
  bufferTarget: 2,
  poolMaximum: 12,
  championRetirementStreak: 4,
  fallbackMaximumConsecutive: 3,
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

function rating(item: Candidate): CandidateRating {
  return {
    candidate: item,
    rating: 1000,
    wins: 0,
    losses: 0,
    source: "curated",
    importItemId: null,
    poolMember: true,
    lastServedAt: null,
  };
}

function game(overrides: Partial<GameState> = {}): GameState {
  return {
    round: {
      leftCandidate: candidate("left"),
      rightCandidate: candidate("right"),
      status: "idle",
      replacingSide: null,
      roundNumber: 6,
      retainedCandidateId: "left",
      winStreak: 1,
    },
    history: [],
    preferenceSeed: "Architectural portraits in dramatic natural light.",
    gameRules: RULES,
    ...overrides,
  };
}

function challengers(
  current: GameState,
  readyIds = ["ready-1", "ready-2", "ready-3"],
): ChallengerState {
  const ready = readyIds.map((id) => ({
    candidate: candidate(id),
    source: "seed" as const,
    importItemId: null,
    pinnedWinnerId: null,
    enqueuedAt: NOW,
  }));
  return {
    version: 1,
    sessionId: "session-1",
    ready,
    importQueue: [],
    refillJobs: [],
    pendingComparison: null,
    pendingSelectionBaseline: null,
    ratings: [
      rating(current.round.leftCandidate),
      rating(current.round.rightCandidate),
      ...ready.map(({ candidate: item }) => rating(item)),
    ],
    generationTurnaroundEmaMs: 100_000,
    consecutiveFallbackDraws: 0,
    nextFallbackAt: null,
  };
}

function fixture(
  current: GameState | null = game(),
  state: ChallengerState | null = current ? challengers(current) : null,
  importSession: ImportSession | null = null,
) {
  const gameRepository = new MemoryGameRepository(current);
  const challengerRepository = new MemoryChallengerRepository(state);
  const importSessionRepository = new MemoryImportSessionRepository(
    importSession,
  );
  const stateLockCoordinator = new StateLockCoordinator({
    activationIntent: new MemoryImportActivationIntentRepository(),
    importSession: importSessionRepository,
    game: gameRepository,
    challenger: challengerRepository,
    initialBootstrap: new MemoryInitialBootstrapRepository(),
  });
  const candidateDequeueService = new CandidateDequeueService({
    challengerRepository,
    importSessionRepository,
    initialRating: 1000,
    fallbackDelayMs: 3_000,
    now: () => NOW,
    random: () => 0,
  });
  const preparedSelectionReconciler = new PreparedSelectionReconciler({
    gameRepository,
    challengerRepository,
    initialRating: 1000,
    eloKFactor: 32,
    fallbackDelayMs: 1000,
    now: () => NOW,
    random: () => 0,
    rulesFor: (value) => value.gameRules!,
  });
  const reconcileEditor = vi.fn(async (value: GameState) => value);
  const plan = vi.fn((value: ChallengerState) => ({
    state: value,
    jobs: [],
  }));
  const ensureAll = vi.fn(async () => {});
  const service = new GameSelectionService({
    gameRepository,
    challengerRepository,
    importSessionRepository,
    stateLockCoordinator,
    candidateDequeueService,
    promptCardReconciler: { reconcileEditor },
    preparedSelectionReconciler,
    refillCapacityService: { plan },
    generationJobPublisher: { ensureAll },
    config: { initialRating: 1000, eloKFactor: 32 },
    rulesFor: (value) => value.gameRules!,
    now: () => NOW,
  });

  return {
    service,
    gameRepository,
    challengerRepository,
    importSessionRepository,
    reconcileEditor,
    plan,
    ensureAll,
  };
}

describe("GameSelectionService", () => {
  it("rejects a missing game before loading challenger state", async () => {
    const context = fixture(null, null);
    const loadChallengers = vi.spyOn(context.challengerRepository, "load");

    await expect(context.service.select("left", 6)).rejects.toThrow(
      "Start a game before choosing an image",
    );
    expect(loadChallengers).not.toHaveBeenCalled();
  });

  it("rejects a stale round before loading challenger state", async () => {
    const context = fixture();
    const loadChallengers = vi.spyOn(context.challengerRepository, "load");

    await expect(context.service.select("left", 5)).rejects.toThrow(
      "The round changed before this selection arrived",
    );
    expect(loadChallengers).not.toHaveBeenCalled();
  });

  it("completes a buffered selection under game-before-challenger locks", async () => {
    const current = game();
    const context = fixture(current, challengers(current));
    const gameLock = vi.spyOn(context.gameRepository, "withLock");
    const challengerLock = vi.spyOn(context.challengerRepository, "withLock");

    const selected = await context.service.select("left", 6);

    expect(selected.round).toMatchObject({
      status: "idle",
      leftCandidate: { id: "left" },
      rightCandidate: { id: "ready-1" },
      roundNumber: 7,
      retainedCandidateId: "left",
      winStreak: 2,
    });
    expect(selected.history.at(-1)).toMatchObject({
      winnerId: "left",
      loserId: "right",
      selectedAt: NOW,
    });
    expect(gameLock.mock.invocationCallOrder[0]).toBeLessThan(
      challengerLock.mock.invocationCallOrder[0]!,
    );
    expect(context.plan).toHaveBeenCalledOnce();
    expect(context.reconcileEditor).toHaveBeenCalledOnce();
    expect(context.ensureAll).toHaveBeenCalledWith([]);
    expect(
      (await context.challengerRepository.load())?.pendingComparison,
    ).toBeNull();
  });

  it("completes a tie with two distinct FIFO replacements", async () => {
    const current = game();
    const context = fixture(current, challengers(current, ["one", "two"]));

    const tied = await context.service.tie(6);

    expect(tied.round).toMatchObject({
      status: "idle",
      leftCandidate: { id: "one" },
      rightCandidate: { id: "two" },
      roundNumber: 7,
      retainedCandidateId: null,
      winStreak: 0,
    });
    expect(tied.history.at(-1)).toMatchObject({
      outcome: "tie",
      leftId: "left",
      rightId: "right",
      selectedAt: NOW,
    });
    expect(context.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ comparisonOutcome: "tie" }),
      expect.objectContaining({ terminal: true }),
    );
  });

  it("records both active candidates as rejected before replacing them", async () => {
    const current = game();
    const context = fixture(current, challengers(current, ["one", "two"]));

    const rejected = await context.service.bothLose(6);

    expect(rejected.round).toMatchObject({
      status: "idle",
      leftCandidate: { id: "one" },
      rightCandidate: { id: "two" },
      roundNumber: 7,
    });
    expect(rejected.history.at(-1)).toMatchObject({
      outcome: "both-lose",
      leftId: "left",
      rightId: "right",
      selectedAt: NOW,
    });
    expect(context.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ comparisonOutcome: "both-lose" }),
      expect.objectContaining({ terminal: true }),
    );
  });

  it("serves an activated imported candidate before the ordinary ready queue", async () => {
    const current = game();
    const imported = candidate("imported-1");
    const digest = "a".repeat(64);
    imported.imageUrl = `/api/assets/${digest}.png`;
    const session: ImportSession = {
      version: 1,
      id: "import-session-1",
      status: "active",
      createdAt: NOW,
      sealedAt: NOW,
      activatedAt: NOW,
      items: [
        {
          id: "import-item-1",
          normalizedDigest: digest,
          status: "ready",
          asset: {
            digest,
            filename: `${digest}.png`,
            url: `/api/assets/${digest}.png`,
            contentType: "image/png",
            width: 1024,
            height: 1024,
            byteLength: 1024,
          },
          annotationJob: null,
          annotation: {
            concept: imported.concept,
            prompt: imported.prompt,
            style: imported.style,
            reasoningSummary: "Visible composition and palette.",
            source: "automated",
          },
          candidateId: imported.id,
          failureMessage: null,
          approvedAt: NOW,
          servedAt: null,
        },
      ],
      initialFillJobs: [],
      initialFillRetry: null,
      servedReceipts: [],
    };
    const state = challengers(current);
    state.importQueue = [
      {
        candidate: imported,
        source: "imported",
        importItemId: "import-item-1",
        pinnedWinnerId: null,
        enqueuedAt: NOW,
      },
    ];
    const context = fixture(current, state, session);

    const selected = await context.service.select("left", 6);

    expect(selected.round.rightCandidate.id).toBe("imported-1");
    expect(
      (await context.challengerRepository.load())?.ready[0].candidate.id,
    ).toBe("ready-1");
    expect(
      (await context.importSessionRepository.load())?.servedReceipts,
    ).toMatchObject([
      {
        kind: "dequeue",
        replacementSlot: "single",
        candidateId: "imported-1",
      },
    ]);
    expect(context.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        readyUnserved: 0,
        dequeueReceiptCount: 1,
        terminal: true,
      }),
    );
  });
});
