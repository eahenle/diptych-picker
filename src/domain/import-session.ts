import { createHash } from "node:crypto";
import { GENERATION_JOB_ID_PATTERN, type Candidate } from "./game";
import type { PendingComparisonReceipt } from "./challenger-state";
import { z } from "zod";

export type ImportSessionStatus =
  "editing" | "preparing" | "active" | "completed";
export type ImportItemStatus =
  "annotating" | "ready" | "failed" | "removed" | "served";

export interface ImportedAssetMetadata {
  digest: string;
  filename: string;
  url: string;
  contentType: "image/png";
  width: number;
  height: number;
  byteLength: number;
}

export interface ImportedCandidateAnnotation {
  concept: string;
  prompt: string;
  style: string[];
  reasoningSummary: string;
  source: "automated" | "manual";
}

export interface ImportItem {
  id: string;
  normalizedDigest: string;
  status: ImportItemStatus;
  asset: ImportedAssetMetadata;
  annotationJob: ImportAnnotationJobRecord | null;
  annotation: ImportedCandidateAnnotation | null;
  candidateId: string | null;
  failureMessage: string | null;
  approvedAt: string;
  servedAt: string | null;
}

export interface ImportAnnotationJobRecord {
  id: string;
  kind: "import-annotation";
  createdAt: string;
  importSessionId: string;
  importItemId: string;
  asset: ImportedAssetMetadata;
}

export interface InitialFillJobRecord {
  id: string;
  attemptId: string;
  status: "pending" | "ready" | "failed" | "superseded";
  candidate: Candidate | null;
  source: "generated";
  importItemId: null;
  failureMessage: string | null;
  completedAt: string | null;
}

export interface InitialFillRetryReceipt {
  failedAttemptId: string;
  requestId: string;
  replacementAttemptId: string;
  replacementJobIds: string[];
  createdAt: string;
}

export interface ActivationDisplayServedReceipt {
  kind: "activation-display";
  activationDisplayReceiptId: string;
  activationIntentId: string;
  importSessionId: string;
  replacementSlot: "initial-left" | "initial-right";
  importItemId: string;
  candidateId: string;
  candidate: Candidate;
  provenance: "imported";
  servedAt: string;
}

export interface DequeueServedImportReceipt {
  kind: "dequeue";
  dequeueOperationId: string;
  importSessionId: string;
  originalReceipt: PendingComparisonReceipt;
  replacementSlot: "single" | "pair-left" | "pair-right";
  importItemId: string;
  candidateId: string;
  candidate: Candidate;
  provenance: "imported";
  roundNumber: number;
  servedAt: string;
}

export type ImportServedReceipt =
  ActivationDisplayServedReceipt | DequeueServedImportReceipt;

export interface ImportSession {
  version: 1;
  id: string;
  status: ImportSessionStatus;
  createdAt: string;
  sealedAt: string | null;
  activatedAt: string | null;
  items: ImportItem[];
  initialFillJobs: InitialFillJobRecord[];
  initialFillRetry: InitialFillRetryReceipt | null;
  servedReceipts: ImportServedReceipt[];
}

export interface ImportSupplySnapshot {
  importSessionId: string | null;
  annotating: number;
  failed: number;
  readyUnserved: number;
  servedImportedItemCount: number;
  activationDisplayReceiptCount: number;
  dequeueReceiptCount: number;
  initialFillPending: number;
  initialFillFailed: number;
  terminal: boolean;
}

const nonBlank = z.string().trim().min(1);
const durableId = z
  .string()
  .regex(GENERATION_JOB_ID_PATTERN, "Invalid durable ID");
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });

const assetSchema = z
  .object({
    digest: digestSchema,
    filename: z.string().regex(/^[a-f0-9]{64}\.png$/),
    url: z.string().regex(/^\/api\/assets\/[a-f0-9]{64}\.png$/),
    contentType: z.literal("image/png"),
    width: z.literal(1024),
    height: z.literal(1024),
    byteLength: z.number().int().positive(),
  })
  .strict()
  .superRefine((asset, context) => {
    if (asset.filename !== `${asset.digest}.png`) {
      context.addIssue({
        code: "custom",
        path: ["filename"],
        message: "Imported asset filename must match its digest",
      });
    }
    if (asset.url !== `/api/assets/${asset.filename}`) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "Imported asset URL must match its filename",
      });
    }
  });

export const importedCandidateAnnotationSchema = z
  .object({
    concept: nonBlank.max(120),
    prompt: nonBlank.max(500),
    style: z.array(nonBlank.max(80)).min(1).max(8),
    reasoningSummary: nonBlank.max(1_000),
    source: z.enum(["automated", "manual"]),
  })
  .strict()
  .superRefine((annotation, context) => {
    if (new Set(annotation.style).size !== annotation.style.length) {
      context.addIssue({
        code: "custom",
        path: ["style"],
        message: "Imported annotation style tags must be unique",
      });
    }
  });

const itemSchema = z
  .object({
    id: durableId,
    normalizedDigest: digestSchema,
    status: z.enum(["annotating", "ready", "failed", "removed", "served"]),
    asset: assetSchema,
    annotationJob: z
      .object({
        id: durableId,
        kind: z.literal("import-annotation"),
        createdAt: timestampSchema,
        importSessionId: durableId,
        importItemId: durableId,
        asset: assetSchema,
      })
      .strict()
      .nullable(),
    annotation: importedCandidateAnnotationSchema.nullable(),
    candidateId: nonBlank.nullable(),
    failureMessage: nonBlank.nullable(),
    approvedAt: timestampSchema,
    servedAt: timestampSchema.nullable(),
  })
  .strict()
  .superRefine((item, context) => {
    if (
      item.normalizedDigest !== item.asset.digest ||
      (item.annotationJob &&
        (item.annotationJob.importItemId !== item.id ||
          item.annotationJob.asset.digest !== item.normalizedDigest))
    ) {
      context.addIssue({
        code: "custom",
        path: ["normalizedDigest"],
        message: "Import item metadata must match its normalized asset",
      });
    }
    if (item.status === "annotating" && !item.annotationJob) {
      context.addIssue({
        code: "custom",
        path: ["annotationJob"],
        message: "Annotating import items require an annotation job",
      });
    }
    if (
      item.status === "annotating" &&
      (item.annotation ||
        item.candidateId ||
        item.failureMessage ||
        item.servedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Annotating import items may retain only live annotation work",
      });
    }
    if (
      item.status === "ready" &&
      (!item.annotation ||
        !item.candidateId ||
        item.annotationJob ||
        item.failureMessage ||
        item.servedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "Ready import items require annotation and candidate evidence only",
      });
    }
    if (
      item.status === "failed" &&
      (!item.annotationJob ||
        !item.failureMessage ||
        item.annotation ||
        item.candidateId ||
        item.servedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "Failed import items require their annotation job and terminal failure evidence only",
      });
    }
    if (item.status === "removed" && (item.annotationJob || item.servedAt)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Removed import items cannot retain live or served evidence",
      });
    }
    if (
      item.status === "served" &&
      (!item.annotation ||
        !item.candidateId ||
        !item.servedAt ||
        item.annotationJob ||
        item.failureMessage)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "Served import items require annotation, candidate, and served evidence only",
      });
    }
  });

const candidateSchema = z
  .object({
    id: nonBlank,
    imageUrl: nonBlank,
    prompt: nonBlank,
    concept: nonBlank,
    style: z.array(nonBlank),
    createdAt: timestampSchema,
    winCount: z.number().int().nonnegative(),
    reasoningSummary: nonBlank.optional(),
    preferenceRevision: z
      .object({
        themes: nonBlank,
        inspiration: nonBlank,
        mediaTypes: nonBlank,
        visualStyle: nonBlank,
        colorPalette: nonBlank,
        contentLevel: z.enum(["family-friendly", "adult-allowed"]),
        avoid: nonBlank,
      })
      .strict()
      .optional(),
    promptCardId: nonBlank.optional(),
    lineage: z
      .object({
        kind: z.literal("variation"),
        parentCandidateId: nonBlank,
        parentConcept: nonBlank,
        preferenceFingerprint: digestSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

const pendingComparisonReceiptSchema = z.union([
  z
    .object({
      kind: z.literal("selection").optional(),
      selectedAt: timestampSchema,
      roundNumber: z.number().int().positive(),
      winnerSide: z.enum(["left", "right"]),
      winnerId: nonBlank,
      loserId: nonBlank,
    })
    .strict(),
  z
    .object({
      kind: z.enum(["tie", "both-lose"]),
      selectedAt: timestampSchema,
      roundNumber: z.number().int().positive(),
      leftId: nonBlank,
      rightId: nonBlank,
    })
    .strict(),
]);

const activationDisplayReceiptSchema = z
  .object({
    kind: z.literal("activation-display"),
    activationDisplayReceiptId: durableId,
    activationIntentId: durableId,
    importSessionId: durableId,
    replacementSlot: z.enum(["initial-left", "initial-right"]),
    importItemId: durableId,
    candidateId: nonBlank,
    candidate: candidateSchema,
    provenance: z.literal("imported"),
    servedAt: timestampSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      receipt.activationDisplayReceiptId !==
      deriveActivationDisplayReceiptId(
        receipt.activationIntentId,
        receipt.importSessionId,
        receipt.replacementSlot,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["activationDisplayReceiptId"],
        message: "Activation display receipt ID does not match its evidence",
      });
    }
  });

const dequeueReceiptSchema = z
  .object({
    kind: z.literal("dequeue"),
    dequeueOperationId: durableId,
    importSessionId: durableId,
    originalReceipt: pendingComparisonReceiptSchema,
    replacementSlot: z.enum(["single", "pair-left", "pair-right"]),
    importItemId: durableId,
    candidateId: nonBlank,
    candidate: candidateSchema,
    provenance: z.literal("imported"),
    roundNumber: z.number().int().positive(),
    servedAt: timestampSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      receipt.dequeueOperationId !==
      deriveDequeueOperationId(
        receipt.importSessionId,
        "",
        receipt.originalReceipt,
        receipt.replacementSlot,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["dequeueOperationId"],
        message: "Dequeue operation ID does not match its evidence",
      });
    }
  });

const initialFillJobSchema = z
  .object({
    id: durableId,
    attemptId: durableId,
    status: z.enum(["pending", "ready", "failed", "superseded"]),
    candidate: candidateSchema.nullable(),
    source: z.literal("generated"),
    importItemId: z.null(),
    failureMessage: nonBlank.nullable(),
    completedAt: timestampSchema.nullable(),
  })
  .strict()
  .superRefine((job, context) => {
    if (
      job.status === "pending" &&
      (job.candidate || job.failureMessage || job.completedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Pending initial-fill jobs cannot retain terminal evidence",
      });
    }
    if (
      job.status === "ready" &&
      (!job.candidate || !job.completedAt || job.failureMessage)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "Ready initial-fill jobs require candidate and completion evidence only",
      });
    }
    if (
      (job.status === "failed" || job.status === "superseded") &&
      (job.candidate || !job.failureMessage || !job.completedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "Terminal initial-fill jobs require failure and completion evidence only",
      });
    }
  });

const initialFillRetrySchema = z
  .object({
    failedAttemptId: durableId,
    requestId: durableId,
    replacementAttemptId: durableId,
    replacementJobIds: z.array(durableId).min(1),
    createdAt: timestampSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      new Set(receipt.replacementJobIds).size !==
      receipt.replacementJobIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["replacementJobIds"],
        message: "Initial fill retry request job IDs must be unique",
      });
    }
  });

const importSessionSchema: z.ZodType<ImportSession> = z
  .object({
    version: z.literal(1),
    id: durableId,
    status: z.enum(["editing", "preparing", "active", "completed"]),
    createdAt: timestampSchema,
    sealedAt: timestampSchema.nullable(),
    activatedAt: timestampSchema.nullable(),
    items: z.array(itemSchema),
    initialFillJobs: z.array(initialFillJobSchema),
    initialFillRetry: initialFillRetrySchema.nullable(),
    servedReceipts: z.array(
      z.discriminatedUnion("kind", [
        activationDisplayReceiptSchema,
        dequeueReceiptSchema,
      ]),
    ),
  })
  .strict()
  .superRefine((session, context) => {
    const itemIds = new Set<string>();
    const activeDigests = new Set<string>();
    for (const [index, item] of session.items.entries()) {
      if (itemIds.has(item.id)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "id"],
          message: "Import item IDs must be unique",
        });
      }
      itemIds.add(item.id);
      if (
        item.annotationJob &&
        item.annotationJob.importSessionId !== session.id
      ) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "annotationJob", "importSessionId"],
          message: "Annotation job must reference this import session",
        });
      }
      if (item.status !== "removed") {
        if (activeDigests.has(item.asset.digest)) {
          context.addIssue({
            code: "custom",
            path: ["items", index, "asset", "digest"],
            message: "Nonremoved import asset digests must be unique",
          });
        }
        activeDigests.add(item.asset.digest);
      }
    }

    const receiptIds = new Set<string>();
    const servedItemIds = new Set<string>();
    for (const [index, receipt] of session.servedReceipts.entries()) {
      const receiptId =
        receipt.kind === "activation-display"
          ? receipt.activationDisplayReceiptId
          : receipt.dequeueOperationId;
      if (receipt.importSessionId !== session.id) {
        context.addIssue({
          code: "custom",
          path: ["servedReceipts", index, "importSessionId"],
          message: "Served receipt must reference this import session",
        });
      }
      if (receiptIds.has(receiptId)) {
        context.addIssue({
          code: "custom",
          path: ["servedReceipts", index],
          message: "Served receipt IDs must be unique",
        });
      }
      receiptIds.add(receiptId);
      if (servedItemIds.has(receipt.importItemId)) {
        context.addIssue({
          code: "custom",
          path: ["servedReceipts", index, "importItemId"],
          message: "Served import item IDs must be unique",
        });
      }
      servedItemIds.add(receipt.importItemId);
      const item = session.items.find(({ id }) => id === receipt.importItemId);
      if (
        !item ||
        item.status !== "served" ||
        receipt.candidateId !== item.candidateId ||
        receipt.candidate.id !== item.candidateId ||
        receipt.servedAt !== item.servedAt
      ) {
        context.addIssue({
          code: "custom",
          path: ["servedReceipts", index],
          message:
            "Served receipt candidate and item IDs must match a served import item",
        });
      }
    }

    const hasServedEvidence =
      session.servedReceipts.length > 0 ||
      session.items.some((item) => item.status === "served");
    const hasPendingInitialFill = session.initialFillJobs.some(
      (job) => job.status === "pending",
    );

    if (
      session.status === "editing" &&
      (session.sealedAt ||
        session.activatedAt ||
        session.initialFillJobs.length > 0 ||
        session.initialFillRetry ||
        hasServedEvidence)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "Editing import sessions are unsealed and contain no fill or served evidence",
      });
    }
    if (
      session.status === "preparing" &&
      (!session.sealedAt || session.activatedAt || hasServedEvidence)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "Preparing import sessions are sealed, unactivated, and unserved",
      });
    }
    if (
      (session.status === "active" || session.status === "completed") &&
      (!session.sealedAt || !session.activatedAt || hasPendingInitialFill)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "Active and completed import sessions require activation and terminal initial-fill work",
      });
    }

    if (session.status === "completed") {
      if (!session.sealedAt) {
        context.addIssue({
          code: "custom",
          path: ["sealedAt"],
          message: "Completed import sessions must be sealed",
        });
      }
      if (!session.activatedAt) {
        context.addIssue({
          code: "custom",
          path: ["activatedAt"],
          message: "Completed import sessions must be activated",
        });
      }
      for (const [index, item] of session.items.entries()) {
        if (item.annotationJob) {
          context.addIssue({
            code: "custom",
            path: ["items", index, "annotationJob"],
            message: "Completed import sessions cannot retain annotation work",
          });
        }
        if (item.status === "removed") continue;
        if (item.status !== "served") {
          context.addIssue({
            code: "custom",
            path: ["items", index, "status"],
            message:
              "Completed import sessions require every retained item to be served",
          });
        }
        if (!servedItemIds.has(item.id)) {
          context.addIssue({
            code: "custom",
            path: ["items", index],
            message:
              "Completed import sessions require served receipt evidence",
          });
        }
      }
      for (const [index, job] of session.initialFillJobs.entries()) {
        if (job.status === "pending") {
          context.addIssue({
            code: "custom",
            path: ["initialFillJobs", index, "status"],
            message:
              "Completed import sessions require terminal initial-fill work",
          });
        }
      }
    }

    const jobIds = new Set<string>();
    const attemptIds = new Set<string>();
    const jobsById = new Map<string, InitialFillJobRecord>();
    for (const [index, job] of session.initialFillJobs.entries()) {
      if (jobIds.has(job.id)) {
        context.addIssue({
          code: "custom",
          path: ["initialFillJobs", index, "id"],
          message: "Initial fill job IDs must be unique",
        });
      }
      jobIds.add(job.id);
      attemptIds.add(job.attemptId);
      jobsById.set(job.id, job);
    }
    if (
      session.initialFillRetry &&
      new Set(session.initialFillRetry.replacementJobIds).size !==
        session.initialFillRetry.replacementJobIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["initialFillRetry", "replacementJobIds"],
        message: "Initial fill retry request IDs must be unique",
      });
    }
    if (
      session.initialFillRetry &&
      !attemptIds.has(session.initialFillRetry.replacementAttemptId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["initialFillRetry", "replacementAttemptId"],
        message: "Initial fill retry must reference its replacement attempt",
      });
    }
    if (session.initialFillRetry) {
      if (
        !session.initialFillJobs.some(
          (job) =>
            job.attemptId === session.initialFillRetry!.failedAttemptId &&
            (job.status === "failed" || job.status === "superseded"),
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["initialFillRetry", "failedAttemptId"],
          message:
            "Initial fill retry must reference an attempt with failed or superseded work",
        });
      }
      for (const [
        index,
        jobId,
      ] of session.initialFillRetry.replacementJobIds.entries()) {
        const job = jobsById.get(jobId);
        if (
          !job ||
          job.attemptId !== session.initialFillRetry.replacementAttemptId
        ) {
          context.addIssue({
            code: "custom",
            path: ["initialFillRetry", "replacementJobIds", index],
            message:
              "Retry replacement jobs must exist in the replacement attempt",
          });
        }
      }
    }
  });

export function parseImportSession(value: unknown): ImportSession {
  return importSessionSchema.parse(value);
}

export function parseImportedCandidateAnnotation(
  value: unknown,
): ImportedCandidateAnnotation {
  return importedCandidateAnnotationSchema.parse(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`,
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function deriveActivationDisplayReceiptId(
  activationIntentId: string,
  importSessionId: string,
  replacementSlot: ActivationDisplayServedReceipt["replacementSlot"],
): string {
  return `activation-display-${sha256(canonicalJson([activationIntentId, importSessionId, replacementSlot]))}`;
}

export function deriveDequeueOperationId(
  importSessionId: string | null,
  challengerSessionId: string,
  originalReceipt: PendingComparisonReceipt,
  replacementSlot: DequeueServedImportReceipt["replacementSlot"],
): string {
  const canonicalReceipt =
    originalReceipt.kind === undefined
      ? { ...originalReceipt, kind: "selection" as const }
      : originalReceipt;
  return `dequeue-${sha256(
    canonicalJson([
      importSessionId ?? `game:${challengerSessionId}`,
      canonicalReceipt,
      replacementSlot,
    ]),
  )}`;
}
