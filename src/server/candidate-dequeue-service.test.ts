import { describe, expect, it } from "vitest";
import type {
  BufferedCandidate,
  ChallengerState,
  PendingComparisonReceipt,
} from "@/domain/challenger-state";
import type { Candidate } from "@/domain/game";
import {
  deriveDequeueOperationId,
  type ImportItem,
  type ImportSession,
} from "@/domain/import-session";
import {
  CandidateDequeueService,
  type CandidateDequeueRequest,
} from "./candidate-dequeue-service";
import {
  MemoryChallengerRepository,
  type ChallengerRepository,
} from "./challenger-repository";
import { MemoryImportSessionRepository } from "./import-session-repository";
import { MemoryInitialBootstrapRepository } from "./initial-bootstrap";
import { MemoryGameRepository } from "./repository";
import { StateLockCoordinator } from "./state-lock-coordinator";

const timestamp = "2026-08-10T20:00:00.000Z";

function candidate(id: string, character = "a"): Candidate {
  const digest = character.repeat(64);
  return {
    id,
    imageUrl: `/api/assets/${digest}.png`,
    prompt: `${id} prompt`,
    concept: `${id} concept`,
    style: ["studio photography"],
    createdAt: timestamp,
    winCount: 0,
    reasoningSummary: "Visible transferable composition.",
  };
}

function importItem(
  id: string,
  value: Candidate,
  character: string,
): ImportItem {
  const digest = character.repeat(64);
  return {
    id,
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
      concept: value.concept,
      prompt: value.prompt,
      style: value.style,
      reasoningSummary: "Visible transferable composition.",
      source: "automated",
    },
    candidateId: value.id,
    failureMessage: null,
    approvedAt: timestamp,
    servedAt: null,
  };
}

function importSession(values: Candidate[]): ImportSession {
  return {
    version: 1,
    id: "import-session-1",
    status: "active",
    createdAt: timestamp,
    sealedAt: timestamp,
    activatedAt: timestamp,
    items: values.map((value, index) =>
      importItem(`import-item-${index + 1}`, value, String(index + 1)),
    ),
    initialFillJobs: [],
    initialFillRetry: null,
    servedReceipts: [],
  };
}

function buffered(
  value: Candidate,
  source: BufferedCandidate["source"],
  importItemId: string | null,
): BufferedCandidate {
  return {
    candidate: value,
    source,
    importItemId,
    pinnedWinnerId: null,
    enqueuedAt: timestamp,
  };
}

function challengerState(
  overrides: Partial<ChallengerState> = {},
): ChallengerState {
  return {
    version: 1,
    sessionId: "challenger-session-1",
    ready: [],
    importQueue: [],
    refillJobs: [],
    pendingComparison: null,
    ratings: [],
    generationTurnaroundEmaMs: 300_000,
    consecutiveFallbackDraws: 0,
    nextFallbackAt: null,
    ...overrides,
  };
}

function receipt(roundNumber = 1): PendingComparisonReceipt {
  return {
    selectedAt: timestamp,
    roundNumber,
    winnerSide: "left",
    winnerId: `winner-${roundNumber}`,
    loserId: `loser-${roundNumber}`,
  };
}

function request(
  originalReceipt: PendingComparisonReceipt,
  importSessionId: string | null = "import-session-1",
): CandidateDequeueRequest {
  return {
    dequeueOperationId: deriveDequeueOperationId(
      importSessionId,
      "challenger-session-1",
      originalReceipt,
      "single",
    ),
    importSessionId,
    challengerSessionId: "challenger-session-1",
    originalReceipt,
    replacementSlot: "single",
    reason: "selection",
    invocation: "live",
    roundNumber: originalReceipt.roundNumber + 1,
    excludedCandidateIds: ["winner", "loser"],
    fallbackMaximumConsecutive: 10,
  };
}

function activationIntentLock() {
  return {
    async withLock<T>(operation: () => Promise<T>): Promise<T> {
      return operation();
    },
  };
}

function harness(
  challengers: ChallengerRepository,
  imports: MemoryImportSessionRepository,
  options: { now?: () => string; fallbackDelayMs?: number } = {},
) {
  const coordinator = new StateLockCoordinator({
    activationIntent: activationIntentLock(),
    importSession: imports,
    game: new MemoryGameRepository(),
    challenger: challengers,
    initialBootstrap: new MemoryInitialBootstrapRepository(),
  });
  const service = new CandidateDequeueService({
    challengerRepository: challengers,
    importSessionRepository: imports,
    initialRating: 1000,
    fallbackDelayMs: options.fallbackDelayMs ?? 3_000,
    random: () => 0,
    now: options.now ?? (() => timestamp),
  });
  const dequeue = (value: CandidateDequeueRequest) =>
    coordinator.withStateLocks(
      ["activation-intent", "import-session", "game", "challenger"],
      (context) => service.dequeueLocked(context, value),
    );
  return { dequeue };
}

describe("CandidateDequeueService", () => {
  it("queues imported candidates that become ready after activation", async () => {
    const first = candidate("imported-late-1", "1");
    const second = candidate("imported-late-2", "2");
    const imports = new MemoryImportSessionRepository(
      importSession([first, second]),
    );
    const challengers = new MemoryChallengerRepository(
      challengerState({
        consecutiveFallbackDraws: 10,
        nextFallbackAt: timestamp,
      }),
    );
    const { dequeue } = harness(challengers, imports);

    const result = await dequeue(request(receipt()));

    expect(result).toMatchObject({
      candidate: { id: "imported-late-1" },
      provenance: "imported",
      importItemId: "import-item-1",
      importSupply: {
        readyUnserved: 1,
        servedImportedItemCount: 1,
      },
    });
    expect(result.challengers.importQueue).toMatchObject([
      {
        candidate: { id: "imported-late-2" },
        source: "imported",
        importItemId: "import-item-2",
      },
    ]);
    expect(result.challengers.consecutiveFallbackDraws).toBe(0);
    expect(result.challengers.nextFallbackAt).toBeNull();
  });

  it("serves imported candidates first and replays one receipt without skipping", async () => {
    const first = candidate("imported-1", "1");
    const second = candidate("imported-2", "2");
    const imports = new MemoryImportSessionRepository(
      importSession([first, second]),
    );
    const challengers = new MemoryChallengerRepository(
      challengerState({
        importQueue: [
          buffered(first, "imported", "import-item-1"),
          buffered(second, "imported", "import-item-2"),
        ],
        ready: [buffered(candidate("generated-ready", "3"), "generated", null)],
      }),
    );
    const { dequeue } = harness(challengers, imports);
    const operation = request(receipt());

    const firstResult = await dequeue(operation);
    const replay = await dequeue({
      ...operation,
      invocation: "restart-recovery",
    });

    expect(firstResult).toMatchObject({
      candidate: { id: "imported-1" },
      provenance: "imported",
      importItemId: "import-item-1",
      importSupply: {
        readyUnserved: 1,
        servedImportedItemCount: 1,
        activationDisplayReceiptCount: 0,
        dequeueReceiptCount: 1,
        terminal: false,
      },
    });
    expect(replay.candidate?.id).toBe("imported-1");
    expect(
      replay.challengers.importQueue.map(({ candidate }) => candidate.id),
    ).toEqual(["imported-2"]);
    expect((await imports.load())?.servedReceipts).toHaveLength(1);
    expect(
      replay.challengers.ratings.find(
        ({ candidate }) => candidate.id === "imported-1",
      ),
    ).toMatchObject({
      source: "imported",
      importItemId: "import-item-1",
      poolMember: false,
      poolEligible: true,
    });
  });

  it("recovers after the import receipt commits before challenger queue persistence", async () => {
    const imported = candidate("imported-1", "1");
    const imports = new MemoryImportSessionRepository(
      importSession([imported]),
    );
    const memory = new MemoryChallengerRepository(
      challengerState({
        importQueue: [buffered(imported, "imported", "import-item-1")],
      }),
    );
    let failSave = true;
    const challengers: ChallengerRepository = {
      load: () => memory.load(),
      clearSession: (sessionId) => memory.clearSession(sessionId),
      withLock: (operation) => memory.withLock(operation),
      save: async (state) => {
        if (failSave) {
          failSave = false;
          throw new Error("simulated crash after import receipt");
        }
        await memory.save(state);
      },
    };
    const { dequeue } = harness(challengers, imports);
    const operation = request(receipt());

    await expect(dequeue(operation)).rejects.toThrow("simulated crash");
    expect((await imports.load())?.servedReceipts).toHaveLength(1);
    expect((await memory.load())?.importQueue).toHaveLength(1);

    const recovered = await dequeue({
      ...operation,
      invocation: "prepared-recovery",
    });

    expect(recovered.candidate?.id).toBe("imported-1");
    expect(recovered.challengers.importQueue).toHaveLength(0);
    expect(recovered.importSupply).toMatchObject({
      dequeueReceiptCount: 1,
      terminal: true,
    });
    expect((await imports.load())?.status).toBe("completed");
  });

  it("draws ordinary ready supply only after the import queue is empty", async () => {
    const generated = candidate("generated-ready", "3");
    const second = candidate("generated-second", "4");
    const imports = new MemoryImportSessionRepository(null);
    const challengers = new MemoryChallengerRepository(
      challengerState({
        ready: [
          buffered(generated, "generated", null),
          buffered(second, "generated", null),
        ],
      }),
    );
    const { dequeue } = harness(challengers, imports);
    const operation = request(receipt(), null);

    const result = await dequeue(operation);
    const replay = await dequeue({
      ...operation,
      invocation: "restart-recovery",
    });

    expect(result).toMatchObject({
      candidate: { id: "generated-ready" },
      provenance: "ready",
      importItemId: null,
      importSupply: { importSessionId: null, terminal: true },
    });
    expect(result.challengers.ratings[0]).toMatchObject({
      source: "generated",
      importItemId: null,
      poolMember: false,
      poolEligible: true,
    });
    expect(replay.candidate?.id).toBe("generated-ready");
    expect(replay.challengers.ready[0]?.candidate.id).toBe("generated-second");
    expect(replay.challengers.preparedDequeues).toHaveLength(1);
  });

  it("honors the configured pool fallback delay and per-game draw cap", async () => {
    const fallback = candidate("pool-fallback", "5");
    const imports = new MemoryImportSessionRepository(null);
    const challengers = new MemoryChallengerRepository(
      challengerState({
        ratings: [
          {
            candidate: fallback,
            rating: 1000,
            wins: 0,
            losses: 0,
            source: "curated",
            importItemId: null,
            poolMember: true,
            poolEligible: true,
            lastServedAt: null,
          },
        ],
      }),
    );
    let now = timestamp;
    const { dequeue } = harness(challengers, imports, {
      fallbackDelayMs: 250,
      now: () => now,
    });
    const operation = {
      ...request(receipt(), null),
      fallbackMaximumConsecutive: 1,
    };

    const armed = await dequeue(operation);
    expect(armed.candidate).toBeNull();
    expect(armed.challengers.nextFallbackAt).toBe("2026-08-10T20:00:00.250Z");

    now = "2026-08-10T20:00:00.249Z";
    expect((await dequeue(operation)).candidate).toBeNull();

    now = "2026-08-10T20:00:00.250Z";
    const drawn = await dequeue(operation);
    expect(drawn).toMatchObject({
      candidate: { id: "pool-fallback" },
      provenance: "pool-fallback",
    });
    expect(drawn.challengers.consecutiveFallbackDraws).toBe(1);

    const capped = await dequeue({
      ...request(receipt(2), null),
      fallbackMaximumConsecutive: 1,
    });
    expect(capped.candidate).toBeNull();
  });

  it("rejects a dequeue operation ID derived from different evidence", async () => {
    const imports = new MemoryImportSessionRepository(null);
    const challengers = new MemoryChallengerRepository(challengerState());
    const { dequeue } = harness(challengers, imports);

    await expect(
      dequeue({
        ...request(receipt(), null),
        dequeueOperationId: "dequeue-wrong",
      }),
    ).rejects.toThrow("does not match its request");
  });
});
