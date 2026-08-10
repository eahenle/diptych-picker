import { describe, expect, it } from "vitest";
import type { Candidate } from "./game";
import { importSessionFixture } from "./import-session-fixture";
import {
  deriveActivationDisplayReceiptId,
  deriveDequeueOperationId,
  parseImportSession,
} from "./import-session";

const digest = (character: string) => character.repeat(64);

const candidate = (id: string): Candidate => ({
  id,
  imageUrl: `/api/assets/${digest(id[0])}.png`,
  prompt: `${id} prompt`,
  concept: `${id} concept`,
  style: ["cinematic"],
  createdAt: "2026-08-09T20:00:00.000Z",
  winCount: 0,
});

const originalReceipt = {
  kind: "selection" as const,
  selectedAt: "2026-08-09T20:02:00.000Z",
  roundNumber: 1,
  winnerSide: "left" as const,
  winnerId: "left",
  loserId: "right",
};

const dequeueReceipt = {
  kind: "dequeue" as const,
  dequeueOperationId: deriveDequeueOperationId(
    "import-session-1",
    "",
    originalReceipt,
    "single",
  ),
  importSessionId: "import-session-1",
  originalReceipt,
  replacementSlot: "single" as const,
  importItemId: "served-dequeue",
  candidateId: "candidate-served-dequeue",
  candidate: candidate("candidate-served-dequeue"),
  provenance: "imported" as const,
  roundNumber: 2,
  servedAt: "2026-08-09T20:03:00.000Z",
};

const session = importSessionFixture;

describe("import session schema", () => {
  it("round-trips durable annotations, retry evidence, and both served receipt kinds", () => {
    expect(parseImportSession(session())).toEqual(session());
  });

  it("requires the complete merged item, annotation-job, initial-fill, and retry evidence", () => {
    const value = session() as unknown as Record<string, unknown>;
    const items = value.items as Array<Record<string, unknown>>;
    value.status = "preparing";
    value.items = items.map((entry, index) => ({
      ...entry,
      normalizedDigest: (entry.asset as { digest: string }).digest,
      annotationJob:
        index === 0
          ? {
              id: "annotating-job",
              createdAt: "2026-08-09T20:00:00.000Z",
              importSessionId: "import-session-1",
              importItemId: "annotating",
              asset: entry.asset,
            }
          : null,
      candidateId:
        index === 2
          ? "candidate-served-display"
          : index === 3
            ? "candidate-served-dequeue"
            : null,
      approvedAt: "2026-08-09T20:00:00.000Z",
      servedAt:
        index === 2
          ? "2026-08-09T20:02:00.000Z"
          : index === 3
            ? "2026-08-09T20:03:00.000Z"
            : null,
    }));
    value.initialFillJobs = [
      {
        id: "initial-fill-1",
        attemptId: "attempt-1",
        status: "ready",
        candidate: candidate("initial-fill-candidate"),
        source: "generated",
        importItemId: null,
        failureMessage: null,
        completedAt: "2026-08-09T20:02:30.000Z",
      },
    ];
    value.initialFillRetry = {
      requestId: "retry-request-1",
      failedAttemptId: "attempt-0",
      replacementAttemptId: "attempt-1",
      replacementJobIds: ["initial-fill-1"],
      createdAt: "2026-08-09T20:01:30.000Z",
    };
    const parsed = parseImportSession(value);
    expect(parsed.status).toBe("preparing");
    expect(parsed.items[0]).toMatchObject({
      normalizedDigest: "a".repeat(64),
      annotationJob: { importItemId: "annotating" },
    });
    expect(parsed.initialFillRetry?.replacementAttemptId).toBe("attempt-1");
  });

  it("rejects an activation journal embedded in the import aggregate", () => {
    expect(() =>
      parseImportSession({ ...session(), activation: { id: "not-allowed" } }),
    ).toThrow(/unrecognized|activation/i);
  });

  it("accepts activation-display receipts without comparison evidence", () => {
    const value = session();
    const receipt = value.servedReceipts[0];
    expect(receipt.kind).toBe("activation-display");
    expect(parseImportSession(value).servedReceipts[0]).toEqual(receipt);
  });

  it("rejects comparison evidence on activation-display receipts", () => {
    const value = session();
    value.servedReceipts[0] = {
      ...value.servedReceipts[0],
      originalReceipt: dequeueReceipt.originalReceipt,
    } as (typeof value.servedReceipts)[number];

    expect(() => parseImportSession(value)).toThrow(/unrecognized|original/i);
  });

  it("requires comparison evidence on dequeue receipts", () => {
    const value = session();
    const receipt = { ...dequeueReceipt } as Record<string, unknown>;
    delete receipt.originalReceipt;
    value.servedReceipts[1] =
      receipt as unknown as (typeof value.servedReceipts)[number];

    expect(() => parseImportSession(value)).toThrow(/original/i);
  });

  it("rejects duplicate item IDs and nonremoved asset digests", () => {
    const duplicateId = session();
    duplicateId.items[1] = { ...duplicateId.items[1], id: "annotating" };
    expect(() => parseImportSession(duplicateId)).toThrow(
      /item.*unique|unique.*item/i,
    );

    const duplicateDigest = session();
    duplicateDigest.items[1] = {
      ...duplicateDigest.items[1],
      asset: duplicateDigest.items[0].asset,
    };
    expect(() => parseImportSession(duplicateDigest)).toThrow(/digest/i);
  });

  it("rejects reused served IDs and duplicate served import items across receipt kinds", () => {
    const duplicateReceiptId = session();
    const activationReceipt = duplicateReceiptId.servedReceipts[0];
    if (activationReceipt.kind !== "activation-display") {
      throw new Error("Expected activation-display fixture");
    }
    duplicateReceiptId.servedReceipts[1] = {
      ...dequeueReceipt,
      dequeueOperationId: activationReceipt.activationDisplayReceiptId,
    };
    expect(() => parseImportSession(duplicateReceiptId)).toThrow(
      /receipt.*unique|unique.*receipt/i,
    );

    const duplicateItem = session();
    duplicateItem.servedReceipts[1] = {
      ...dequeueReceipt,
      importItemId: "served-display",
      candidateId: "served-display",
      candidate: candidate("served-display"),
    };
    expect(() => parseImportSession(duplicateItem)).toThrow(
      /served.*item|item.*served/i,
    );
  });

  it("rejects annotations without a style tag", () => {
    const value = session();
    value.items[1] = {
      ...value.items[1],
      annotation: { ...value.items[1].annotation!, style: [] },
    };

    expect(() => parseImportSession(value)).toThrow(/style/i);
  });

  it("derives stable slot-sensitive receipt IDs", () => {
    const left = deriveActivationDisplayReceiptId(
      "activation-intent-1",
      "import-session-1",
      "initial-left",
    );
    const right = deriveActivationDisplayReceiptId(
      "activation-intent-1",
      "import-session-1",
      "initial-right",
    );
    const single = deriveDequeueOperationId(
      "import-session-1",
      "challenger-session-1",
      dequeueReceipt.originalReceipt,
      "single",
    );
    const pair = deriveDequeueOperationId(
      "import-session-1",
      "challenger-session-1",
      dequeueReceipt.originalReceipt,
      "pair-left",
    );

    expect(left).not.toBe(right);
    expect(left).toBe(
      deriveActivationDisplayReceiptId(
        "activation-intent-1",
        "import-session-1",
        "initial-left",
      ),
    );
    expect(single).not.toBe(pair);
    expect(single).toBe(
      deriveDequeueOperationId(
        "import-session-1",
        "challenger-session-1",
        dequeueReceipt.originalReceipt,
        "single",
      ),
    );
  });

  it("canonicalizes an omitted selection kind before deriving dequeue IDs", () => {
    const omittedKind = {
      selectedAt: "2026-08-09T20:02:00.000Z",
      roundNumber: 1,
      winnerSide: "left" as const,
      winnerId: "left",
      loserId: "right",
    };

    expect(
      deriveDequeueOperationId("import-session-1", "", omittedKind, "single"),
    ).toBe(
      deriveDequeueOperationId(
        "import-session-1",
        "",
        { ...omittedKind, kind: "selection" },
        "single",
      ),
    );
  });
});
