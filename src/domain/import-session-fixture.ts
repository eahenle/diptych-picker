import type { Candidate } from "./game";
import {
  deriveActivationDisplayReceiptId,
  deriveDequeueOperationId,
  type ImportItem,
  type ImportSession,
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

const item = (
  id: string,
  assetDigest: string,
  status: ImportItem["status"],
): ImportItem => ({
  id,
  normalizedDigest: assetDigest,
  status,
  asset: {
    digest: assetDigest,
    filename: `${assetDigest}.png`,
    url: `/api/assets/${assetDigest}.png`,
    contentType: "image/png",
    width: 1024,
    height: 1024,
    byteLength: 1_024,
  },
  annotationJob:
    status === "annotating"
      ? {
          id: `${id}-annotation`,
          createdAt: "2026-08-09T20:00:00.000Z",
          importSessionId: "import-session-1",
          importItemId: id,
          asset: {
            digest: assetDigest,
            filename: `${assetDigest}.png`,
            url: `/api/assets/${assetDigest}.png`,
            contentType: "image/png",
            width: 1024,
            height: 1024,
            byteLength: 1_024,
          },
        }
      : null,
  annotation:
    status === "annotating"
      ? null
      : {
          concept: `${id} concept`,
          prompt: `${id} prompt`,
          style: ["cinematic"],
          reasoningSummary: "Visible composition and palette.",
          source: "automated",
        },
  candidateId: status === "served" ? `candidate-${id}` : null,
  failureMessage: null,
  approvedAt: "2026-08-09T20:00:00.000Z",
  servedAt:
    status === "served"
      ? id === "served-display"
        ? "2026-08-09T20:02:00.000Z"
        : "2026-08-09T20:03:00.000Z"
      : null,
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

export const importSessionFixture = (): ImportSession => ({
  version: 1,
  id: "import-session-1",
  status: "active",
  createdAt: "2026-08-09T20:00:00.000Z",
  sealedAt: "2026-08-09T20:01:00.000Z",
  activatedAt: "2026-08-09T20:04:00.000Z",
  items: [
    item("annotating", digest("a"), "annotating"),
    item("ready", digest("b"), "ready"),
    item("served-display", digest("c"), "served"),
    item("served-dequeue", digest("d"), "served"),
  ],
  initialFillJobs: [
    {
      id: "initial-fill-1",
      attemptId: "fill-attempt-2",
      status: "pending",
      candidate: null,
      source: "generated",
      importItemId: null,
      failureMessage: null,
      completedAt: null,
    },
  ],
  initialFillRetry: {
    requestId: "retry-request-1",
    failedAttemptId: "fill-attempt-1",
    replacementAttemptId: "fill-attempt-2",
    replacementJobIds: ["initial-fill-1"],
    createdAt: "2026-08-09T20:01:30.000Z",
  },
  servedReceipts: [
    {
      kind: "activation-display",
      activationDisplayReceiptId: deriveActivationDisplayReceiptId(
        "activation-intent-1",
        "import-session-1",
        "initial-left",
      ),
      activationIntentId: "activation-intent-1",
      importSessionId: "import-session-1",
      replacementSlot: "initial-left",
      importItemId: "served-display",
      candidateId: "candidate-served-display",
      candidate: candidate("candidate-served-display"),
      provenance: "imported",
      servedAt: "2026-08-09T20:02:00.000Z",
    },
    dequeueReceipt,
  ],
});
