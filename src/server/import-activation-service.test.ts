import { describe, expect, it, vi } from "vitest";
import type { ChallengerState } from "@/domain/challenger-state";
import type { Candidate, GameState } from "@/domain/game";
import type {
  ImportedAssetMetadata,
  ImportItem,
  ImportSession,
} from "@/domain/import-session";
import { MemoryChallengerRepository } from "./challenger-repository";
import { ImportActivationService } from "./import-activation-service";
import { MemoryImportActivationIntentRepository } from "./import-activation-intent-repository";
import { MemoryImportSessionRepository } from "./import-session-repository";
import { MemoryInitialBootstrapRepository } from "./initial-bootstrap";
import { MemoryGameRepository } from "./repository";
import { StateLockCoordinator } from "./state-lock-coordinator";

const baseTime = "2026-08-10T20:00:00.000Z";
const preferenceSeed =
  "Clean-session editorial imagery with deliberate composition and tactile detail.";

function asset(character: string): ImportedAssetMetadata {
  const digest = character.repeat(64);
  return {
    digest,
    filename: `${digest}.png`,
    url: `/api/assets/${digest}.png`,
    contentType: "image/png",
    width: 1024,
    height: 1024,
    byteLength: 1024,
  };
}

function candidate(
  id: string,
  character: string,
  createdAt = baseTime,
): Candidate {
  return {
    id,
    imageUrl: asset(character).url,
    prompt: `${id} prompt`,
    concept: `${id} concept`,
    style: ["editorial photography"],
    createdAt,
    winCount: 0,
    reasoningSummary: "Visible composition and material detail.",
  };
}

function readyItem(index: number, approvedAt: string): ImportItem {
  const id = `import-item-${index}`;
  const value = asset(String(index));
  return {
    id,
    normalizedDigest: value.digest,
    status: "ready",
    asset: value,
    annotationJob: null,
    annotation: {
      concept: `${id} concept`,
      prompt: `${id} prompt`,
      style: ["editorial photography"],
      reasoningSummary: "Visible composition and material detail.",
      source: "automated",
    },
    candidateId: `imported-${index}`,
    failureMessage: null,
    approvedAt,
    servedAt: null,
  };
}

function importSession(items: ImportItem[]): ImportSession {
  return {
    version: 1,
    id: "import-session-1",
    status: "preparing",
    createdAt: baseTime,
    sealedAt: baseTime,
    activatedAt: null,
    items,
    initialFillJobs: [],
    initialFillRetry: null,
    servedReceipts: [],
  };
}

function oldGame(): GameState {
  return {
    round: {
      leftCandidate: candidate("old-left", "a"),
      rightCandidate: candidate("old-right", "b"),
      status: "idle",
      replacingSide: null,
      roundNumber: 9,
      retainedCandidateId: "old-left",
      winStreak: 4,
    },
    history: [
      {
        winnerId: "old-left",
        loserId: "old-right",
        winnerPrompt: "old-left prompt",
        loserPrompt: "old-right prompt",
        winnerConcept: "old-left concept",
        loserConcept: "old-right concept",
        selectedAt: baseTime,
      },
    ],
    preferenceSeed: "Old game preferences that must not survive activation.",
  };
}

function oldChallengers(): ChallengerState {
  return {
    version: 1,
    sessionId: "old-challenger-session",
    ready: [],
    importQueue: [],
    refillJobs: [],
    pendingComparison: null,
    ratings: [],
    generationTurnaroundEmaMs: 300_000,
    consecutiveFallbackDraws: 0,
    nextFallbackAt: null,
  };
}

function fixture(session: ImportSession, ids: string[]) {
  const intentRepository = new MemoryImportActivationIntentRepository();
  const importSessionRepository = new MemoryImportSessionRepository(session);
  const gameRepository = new MemoryGameRepository(
    oldGame(),
    "old-game-revision",
  );
  const challengerRepository = new MemoryChallengerRepository(oldChallengers());
  const bootstrapRepository = new MemoryInitialBootstrapRepository();
  const coordinator = new StateLockCoordinator({
    activationIntent: intentRepository,
    importSession: importSessionRepository,
    game: gameRepository,
    challenger: challengerRepository,
    initialBootstrap: bootstrapRepository,
  });
  let index = 0;
  const verifyCandidateAsset = vi.fn(async () => undefined);
  const archiveSupersededJob = vi.fn(async () => undefined);
  const service = new ImportActivationService({
    coordinator,
    intentRepository,
    importSessionRepository,
    gameRepository,
    challengerRepository,
    bootstrapRepository,
    preferenceSeed,
    gameRules: {
      bufferTarget: 5,
      poolMaximum: 50,
      championRetirementStreak: 10,
      fallbackMaximumConsecutive: 10,
    },
    initialRating: 1000,
    verifyCandidateAsset,
    archiveSupersededJob,
    createId: () => ids[index++],
    now: () => "2026-08-10T21:00:00.000Z",
  });
  return {
    service,
    intentRepository,
    importSessionRepository,
    gameRepository,
    challengerRepository,
    verifyCandidateAsset,
    archiveSupersededJob,
  };
}

describe("ImportActivationService", () => {
  it("atomically starts a clean game with two displayed imports and three prioritized imports", async () => {
    const items = Array.from({ length: 5 }, (_, index) =>
      readyItem(index + 1, `2026-08-10T20:0${index + 1}:00.000Z`),
    );
    const context = fixture(importSession(items), [
      "activation-intent-1",
      "new-game-revision",
      "new-challenger-session",
    ]);

    const activated = await context.service.reconcile();

    expect(activated).toMatchObject({
      status: "ready",
      game: {
        round: {
          leftCandidate: { id: "imported-1" },
          rightCandidate: { id: "imported-2" },
          roundNumber: 1,
          retainedCandidateId: null,
        },
        history: [],
        preferenceSeed,
      },
    });
    const challengers = await context.challengerRepository.load();
    expect(
      challengers?.importQueue.map(({ candidate }) => candidate.id),
    ).toEqual(["imported-3", "imported-4", "imported-5"]);
    expect(challengers?.ready).toEqual([]);
    expect(challengers?.ratings).toEqual([
      expect.objectContaining({
        candidate: expect.objectContaining({ id: "imported-1" }),
        source: "imported",
        importItemId: "import-item-1",
        poolMember: false,
        poolEligible: true,
      }),
      expect.objectContaining({
        candidate: expect.objectContaining({ id: "imported-2" }),
        source: "imported",
        importItemId: "import-item-2",
        poolMember: false,
        poolEligible: true,
      }),
    ]);
    const imported = await context.importSessionRepository.load();
    expect(imported?.items.map(({ status }) => status)).toEqual([
      "served",
      "served",
      "ready",
      "ready",
      "ready",
    ]);
    expect(
      imported?.servedReceipts.map((receipt) => [
        receipt.kind,
        receipt.kind === "activation-display" ? receipt.replacementSlot : null,
      ]),
    ).toEqual([
      ["activation-display", "initial-left"],
      ["activation-display", "initial-right"],
    ]);
    expect(
      imported?.servedReceipts.every(
        (receipt) => !("originalReceipt" in receipt),
      ),
    ).toBe(true);
    expect((await context.intentRepository.load())?.phase).toBe("cleaned");
    expect(context.verifyCandidateAsset).toHaveBeenCalledTimes(5);

    await context.service.reconcile();
    expect(await context.intentRepository.load()).toBeNull();
  });

  it("preserves exact imported/generated provenance in a completion-ordered mixed start", async () => {
    const session = importSession([
      readyItem(1, "2026-08-10T20:01:00.000Z"),
      readyItem(2, "2026-08-10T20:03:00.000Z"),
      readyItem(3, "2026-08-10T20:05:00.000Z"),
    ]);
    session.initialFillJobs = [
      {
        id: "fill-job-1",
        attemptId: "fill-attempt-1",
        status: "ready",
        candidate: candidate("generated-1", "d", "2026-08-10T20:02:00.000Z"),
        source: "generated",
        importItemId: null,
        failureMessage: null,
        completedAt: "2026-08-10T20:02:00.000Z",
      },
      {
        id: "fill-job-2",
        attemptId: "fill-attempt-1",
        status: "ready",
        candidate: candidate("generated-2", "e", "2026-08-10T20:04:00.000Z"),
        source: "generated",
        importItemId: null,
        failureMessage: null,
        completedAt: "2026-08-10T20:04:00.000Z",
      },
    ];
    const context = fixture(session, [
      "activation-intent-2",
      "new-game-revision-2",
      "new-challenger-session-2",
    ]);

    const activated = await context.service.reconcile();
    const challengers = await context.challengerRepository.load();
    const imported = await context.importSessionRepository.load();

    expect(activated?.status).toBe("ready");
    if (activated?.status !== "ready") throw new Error("Expected activation");
    expect([
      activated.game.round.leftCandidate.id,
      activated.game.round.rightCandidate.id,
    ]).toEqual(["imported-1", "generated-1"]);
    expect(
      challengers?.ratings.map(({ source, importItemId }) => ({
        source,
        importItemId,
      })),
    ).toEqual([
      { source: "imported", importItemId: "import-item-1" },
      { source: "generated", importItemId: null },
    ]);
    expect(
      challengers?.importQueue.map(({ candidate }) => candidate.id),
    ).toEqual(["imported-2", "imported-3"]);
    expect(challengers?.ready.map(({ candidate }) => candidate.id)).toEqual([
      "generated-2",
    ]);
    expect(imported?.servedReceipts).toHaveLength(1);
    expect(imported?.servedReceipts[0]).toMatchObject({
      kind: "activation-display",
      replacementSlot: "initial-left",
      importItemId: "import-item-1",
    });
  });

  it("leaves the old game untouched before the sealed session has five ready candidates", async () => {
    const context = fixture(
      importSession([
        readyItem(1, "2026-08-10T20:01:00.000Z"),
        readyItem(2, "2026-08-10T20:02:00.000Z"),
        readyItem(3, "2026-08-10T20:03:00.000Z"),
        readyItem(4, "2026-08-10T20:04:00.000Z"),
      ]),
      [],
    );
    const before = await context.gameRepository.loadEnvelope();

    const result = await context.service.reconcile();

    expect(result).toEqual({ status: "ready", game: before?.state });
    expect(await context.gameRepository.loadEnvelope()).toBe(before);
    expect(await context.intentRepository.load()).toBeNull();
  });
});
