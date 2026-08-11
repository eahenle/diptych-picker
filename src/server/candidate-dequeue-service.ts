import { isDeepStrictEqual } from "node:util";
import {
  drawFallback,
  popReady,
  type BufferedCandidate,
  type ChallengerState,
  type PendingComparisonReceipt,
  type PreparedCandidateDequeue,
} from "@/domain/challenger-state";
import type { Candidate } from "@/domain/game";
import {
  deriveDequeueOperationId,
  type DequeueServedImportReceipt,
  type ImportSession,
  type ImportSupplySnapshot,
} from "@/domain/import-session";
import type { ChallengerRepository } from "./challenger-repository";
import { createCandidateRating } from "./game-comparison";
import type { ImportSessionRepository } from "./import-session-repository";
import {
  requireStateLocks,
  type LockedStateContext,
} from "./state-lock-coordinator";

export interface CandidateDequeueRequest {
  dequeueOperationId: string;
  importSessionId: string | null;
  challengerSessionId: string;
  originalReceipt: PendingComparisonReceipt;
  replacementSlot: "single" | "pair-left" | "pair-right";
  reason: "selection" | "retirement" | "tie" | "both-lose";
  invocation: "live" | "prepared-recovery" | "restart-recovery";
  roundNumber: number;
  excludedCandidateIds: string[];
}

export interface CandidateDequeueResult {
  dequeueOperationId: string;
  candidate: Candidate | null;
  provenance: "imported" | "ready" | "pool-fallback" | null;
  importItemId: string | null;
  challengers: ChallengerState;
  importSupply: ImportSupplySnapshot;
}

interface CandidateDequeueServiceOptions {
  challengerRepository: ChallengerRepository;
  importSessionRepository: ImportSessionRepository;
  initialRating: number;
  random?: () => number;
  now?: () => string;
}

const requiredLocks = [
  "activation-intent",
  "import-session",
  "game",
  "challenger",
] as const;

export class CandidateDequeueService {
  private readonly random: () => number;
  private readonly now: () => string;

  constructor(private readonly options: CandidateDequeueServiceOptions) {
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async dequeueLocked(
    context: LockedStateContext,
    request: CandidateDequeueRequest,
  ): Promise<CandidateDequeueResult> {
    requireStateLocks(context, requiredLocks);
    const expectedOperationId = deriveDequeueOperationId(
      request.importSessionId,
      request.challengerSessionId,
      request.originalReceipt,
      request.replacementSlot,
    );
    if (request.dequeueOperationId !== expectedOperationId) {
      throw new Error(
        "Candidate dequeue operation ID does not match its request",
      );
    }

    let challengers = await this.options.challengerRepository.load();
    if (!challengers || challengers.sessionId !== request.challengerSessionId) {
      throw new Error("Candidate dequeue challenger session is unavailable");
    }
    let importSession = await this.options.importSessionRepository.load();
    if (
      request.importSessionId !== null &&
      (!importSession || importSession.id !== request.importSessionId)
    ) {
      throw new Error("Candidate dequeue import session is unavailable");
    }
    if (request.importSessionId === null) importSession = null;

    const preparedReplay = challengers.preparedDequeues?.find(
      ({ dequeueOperationId }) =>
        dequeueOperationId === request.dequeueOperationId,
    );
    if (preparedReplay) {
      assertPreparedReplayMatches(preparedReplay, request);
      return {
        dequeueOperationId: preparedReplay.dequeueOperationId,
        candidate: preparedReplay.candidate,
        provenance: preparedReplay.provenance,
        importItemId: preparedReplay.importItemId,
        challengers,
        importSupply: preparedReplay.importSupply,
      };
    }

    const replay = importSession?.servedReceipts.find(
      (receipt): receipt is DequeueServedImportReceipt =>
        receipt.kind === "dequeue" &&
        receipt.dequeueOperationId === request.dequeueOperationId,
    );
    if (replay) {
      if (
        replay.replacementSlot !== request.replacementSlot ||
        !isDeepStrictEqual(replay.originalReceipt, request.originalReceipt)
      ) {
        throw new Error("Candidate dequeue replay evidence does not match");
      }
      challengers = ensureImportedReplayState(
        challengers,
        replay,
        this.options.initialRating,
      );
      importSession = await this.completeImportIfTerminal(importSession!);
      const importSupply = summarizeImportSupply(importSession);
      challengers = recordPreparedDequeue(challengers, request, {
        candidate: replay.candidate,
        provenance: "imported",
        importItemId: replay.importItemId,
        importSupply,
      });
      await this.options.challengerRepository.save(challengers);
      return {
        dequeueOperationId: request.dequeueOperationId,
        candidate: replay.candidate,
        provenance: "imported",
        importItemId: replay.importItemId,
        challengers,
        importSupply,
      };
    }

    const imported = challengers.importQueue[0];
    if (imported) {
      if (!importSession || !request.importSessionId) {
        throw new Error(
          "Imported challenger supply requires an import session",
        );
      }
      if (imported.source !== "imported" || !imported.importItemId) {
        throw new Error(
          "Imported challenger queue contains invalid provenance",
        );
      }
      const item = importSession.items.find(
        ({ id }) => id === imported.importItemId,
      );
      if (
        !item ||
        item.status !== "ready" ||
        item.candidateId !== imported.candidate.id
      ) {
        throw new Error(
          "Imported challenger queue does not match ready import state",
        );
      }
      const servedAt = this.now();
      const receipt: DequeueServedImportReceipt = {
        kind: "dequeue",
        dequeueOperationId: request.dequeueOperationId,
        importSessionId: importSession.id,
        originalReceipt: request.originalReceipt,
        replacementSlot: request.replacementSlot,
        importItemId: item.id,
        candidateId: imported.candidate.id,
        candidate: imported.candidate,
        provenance: "imported",
        roundNumber: request.roundNumber,
        servedAt,
      };
      importSession = {
        ...importSession,
        items: importSession.items.map((entry) =>
          entry.id === item.id
            ? { ...entry, status: "served" as const, servedAt }
            : entry,
        ),
        servedReceipts: [...importSession.servedReceipts, receipt],
      };
      importSession = completeImportIfTerminalValue(importSession);
      await this.options.importSessionRepository.save(importSession);

      const importSupply = summarizeImportSupply(importSession);
      challengers = recordPreparedDequeue(
        ensureRating(
          {
            ...challengers,
            importQueue: challengers.importQueue.slice(1),
            consecutiveFallbackDraws: 0,
            nextFallbackAt: null,
          },
          imported,
          this.options.initialRating,
        ),
        request,
        {
          candidate: imported.candidate,
          provenance: "imported",
          importItemId: imported.importItemId,
          importSupply,
        },
      );
      await this.options.challengerRepository.save(challengers);
      return {
        dequeueOperationId: request.dequeueOperationId,
        candidate: imported.candidate,
        provenance: "imported",
        importItemId: imported.importItemId,
        challengers,
        importSupply,
      };
    }

    const readyEntry = challengers.ready[0];
    const readyDraw = popReady(challengers);
    if (readyDraw.candidate && readyEntry) {
      if (readyEntry.source === "imported") {
        throw new Error(
          "Imported candidates must use the prioritized import queue",
        );
      }
      challengers = ensureRating(
        readyDraw.state,
        readyEntry,
        this.options.initialRating,
      );
      importSession = importSession
        ? await this.completeImportIfTerminal(importSession)
        : null;
      const importSupply = summarizeImportSupply(importSession);
      challengers = recordPreparedDequeue(challengers, request, {
        candidate: readyDraw.candidate,
        provenance: "ready",
        importItemId: null,
        importSupply,
      });
      await this.options.challengerRepository.save(challengers);
      return {
        dequeueOperationId: request.dequeueOperationId,
        candidate: readyDraw.candidate,
        provenance: "ready",
        importItemId: null,
        challengers,
        importSupply,
      };
    }

    const drawAt = this.now();
    const priorPairFallback =
      request.replacementSlot === "pair-right" &&
      challengers.preparedDequeues?.some(
        (prepared) =>
          prepared.replacementSlot === "pair-left" &&
          prepared.provenance === "pool-fallback" &&
          isDeepStrictEqual(prepared.originalReceipt, request.originalReceipt),
      );
    const fallback = drawFallback(
      priorPairFallback && challengers.nextFallbackAt === null
        ? { ...challengers, nextFallbackAt: drawAt }
        : challengers,
      {
        now: drawAt,
        currentCandidateIds: request.excludedCandidateIds,
        recentCandidateIds: [],
        random: this.random,
      },
    );
    importSession = importSession
      ? await this.completeImportIfTerminal(importSession)
      : null;
    const importSupply = summarizeImportSupply(importSession);
    challengers = fallback.candidate
      ? recordPreparedDequeue(fallback.state, request, {
          candidate: fallback.candidate,
          provenance: "pool-fallback",
          importItemId: null,
          importSupply,
        })
      : fallback.state;
    await this.options.challengerRepository.save(challengers);
    return {
      dequeueOperationId: request.dequeueOperationId,
      candidate: fallback.candidate,
      provenance: fallback.candidate ? "pool-fallback" : null,
      importItemId: null,
      challengers,
      importSupply,
    };
  }

  private async completeImportIfTerminal(
    session: ImportSession,
  ): Promise<ImportSession> {
    const completed = completeImportIfTerminalValue(session);
    if (completed !== session) {
      await this.options.importSessionRepository.save(completed);
    }
    return completed;
  }
}

function assertPreparedReplayMatches(
  prepared: PreparedCandidateDequeue,
  request: CandidateDequeueRequest,
): void {
  const expected = {
    dequeueOperationId: request.dequeueOperationId,
    importSessionId: request.importSessionId,
    originalReceipt: request.originalReceipt,
    replacementSlot: request.replacementSlot,
    reason: request.reason,
    roundNumber: request.roundNumber,
    excludedCandidateIds: request.excludedCandidateIds,
  };
  const actual = {
    dequeueOperationId: prepared.dequeueOperationId,
    importSessionId: prepared.importSessionId,
    originalReceipt: prepared.originalReceipt,
    replacementSlot: prepared.replacementSlot,
    reason: prepared.reason,
    roundNumber: prepared.roundNumber,
    excludedCandidateIds: prepared.excludedCandidateIds,
  };
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error("Prepared candidate dequeue evidence does not match");
  }
}

function recordPreparedDequeue(
  state: ChallengerState,
  request: CandidateDequeueRequest,
  result: Pick<
    PreparedCandidateDequeue,
    "candidate" | "provenance" | "importItemId" | "importSupply"
  >,
): ChallengerState {
  const existing = state.preparedDequeues?.find(
    ({ dequeueOperationId }) =>
      dequeueOperationId === request.dequeueOperationId,
  );
  if (existing) {
    assertPreparedReplayMatches(existing, request);
    if (
      !isDeepStrictEqual(
        {
          candidate: existing.candidate,
          provenance: existing.provenance,
          importItemId: existing.importItemId,
          importSupply: existing.importSupply,
        },
        result,
      )
    ) {
      throw new Error("Prepared candidate dequeue result does not match");
    }
    return state;
  }
  return {
    ...state,
    preparedDequeues: [
      ...(state.preparedDequeues ?? []),
      {
        dequeueOperationId: request.dequeueOperationId,
        importSessionId: request.importSessionId,
        originalReceipt: request.originalReceipt,
        replacementSlot: request.replacementSlot,
        reason: request.reason,
        roundNumber: request.roundNumber,
        excludedCandidateIds: request.excludedCandidateIds,
        ...result,
      },
    ],
  };
}

function ensureImportedReplayState(
  state: ChallengerState,
  receipt: DequeueServedImportReceipt,
  initialRating: number,
): ChallengerState {
  const withoutConsumed = {
    ...state,
    importQueue: state.importQueue.filter(
      ({ candidate }) => candidate.id !== receipt.candidateId,
    ),
    consecutiveFallbackDraws: 0,
    nextFallbackAt: null,
  };
  return ensureRating(
    withoutConsumed,
    {
      candidate: receipt.candidate,
      source: "imported",
      importItemId: receipt.importItemId,
      pinnedWinnerId: null,
      enqueuedAt: receipt.servedAt,
    },
    initialRating,
  );
}

function ensureRating(
  state: ChallengerState,
  buffered: BufferedCandidate,
  initialRating: number,
): ChallengerState {
  const existing = state.ratings.find(
    ({ candidate }) => candidate.id === buffered.candidate.id,
  );
  const source =
    buffered.source === "seed"
      ? "curated"
      : buffered.source === "imported"
        ? "imported"
        : "generated";
  if (existing) {
    if (
      existing.source !== source ||
      existing.importItemId !== buffered.importItemId
    ) {
      throw new Error(
        "Candidate rating provenance does not match its queue entry",
      );
    }
    return state;
  }
  return {
    ...state,
    ratings: [
      ...state.ratings,
      createCandidateRating(
        buffered.candidate,
        source,
        source === "curated",
        initialRating,
        buffered.importItemId,
      ),
    ],
  };
}

function completeImportIfTerminalValue(session: ImportSession): ImportSession {
  return session.status === "active" && summarizeImportSupply(session).terminal
    ? { ...session, status: "completed" }
    : session;
}

export function summarizeImportSupply(
  session: ImportSession | null,
): ImportSupplySnapshot {
  if (!session) {
    return {
      importSessionId: null,
      annotating: 0,
      failed: 0,
      readyUnserved: 0,
      servedImportedItemCount: 0,
      activationDisplayReceiptCount: 0,
      dequeueReceiptCount: 0,
      initialFillPending: 0,
      initialFillFailed: 0,
      terminal: true,
    };
  }
  const annotating = session.items.filter(
    ({ status }) => status === "annotating",
  ).length;
  const failed = session.items.filter(
    ({ status }) => status === "failed",
  ).length;
  const readyUnserved = session.items.filter(
    ({ status }) => status === "ready",
  ).length;
  const servedImportedItemCount = session.items.filter(
    ({ status }) => status === "served",
  ).length;
  const activationDisplayReceiptCount = session.servedReceipts.filter(
    ({ kind }) => kind === "activation-display",
  ).length;
  const dequeueReceiptCount = session.servedReceipts.filter(
    ({ kind }) => kind === "dequeue",
  ).length;
  const initialFillPending = session.initialFillJobs.filter(
    ({ status }) => status === "pending",
  ).length;
  const initialFillFailed = session.initialFillJobs.filter(
    ({ status }) => status === "failed",
  ).length;
  if (
    servedImportedItemCount !==
      activationDisplayReceiptCount + dequeueReceiptCount ||
    new Set(session.servedReceipts.map(({ importItemId }) => importItemId))
      .size !== session.servedReceipts.length
  ) {
    throw new Error("Import served items and receipt evidence do not match");
  }
  return {
    importSessionId: session.id,
    annotating,
    failed,
    readyUnserved,
    servedImportedItemCount,
    activationDisplayReceiptCount,
    dequeueReceiptCount,
    initialFillPending,
    initialFillFailed,
    terminal:
      annotating === 0 &&
      failed === 0 &&
      readyUnserved === 0 &&
      initialFillPending === 0 &&
      initialFillFailed === 0,
  };
}
