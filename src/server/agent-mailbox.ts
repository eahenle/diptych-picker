import {
  access,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { GENERATION_JOB_ID_PATTERN } from "@/domain/game";
import type { LeaderboardPreferenceEvidence } from "@/domain/challenger-state";
import type {
  ImportedAssetMetadata,
  ImportedCandidateAnnotation,
} from "@/domain/import-session";
import { z } from "zod";
import {
  preferenceProfileSchema,
  preferenceRevisionSchema,
} from "./preference-profile-schema";

const timestampSchema = z.string().datetime({ offset: true });
const nonBlankStringSchema = z.string().trim().min(1);
const jobIdSchema = z
  .string()
  .min(1)
  .regex(GENERATION_JOB_ID_PATTERN, "Invalid generation job ID");

const variationSourceSchema = z
  .object({
    candidateId: nonBlankStringSchema,
    concept: nonBlankStringSchema,
  })
  .strict();

const candidateLineageSchema = z
  .object({
    kind: z.literal("variation"),
    parentCandidateId: nonBlankStringSchema,
    parentConcept: nonBlankStringSchema,
    preferenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const candidateSchema = z
  .object({
    id: nonBlankStringSchema,
    imageUrl: nonBlankStringSchema,
    prompt: nonBlankStringSchema,
    concept: nonBlankStringSchema,
    style: z.array(nonBlankStringSchema),
    createdAt: timestampSchema,
    winCount: z.number().int().nonnegative(),
    reasoningSummary: nonBlankStringSchema.optional(),
    preferenceRevision: preferenceRevisionSchema.optional(),
    promptCardId: nonBlankStringSchema.optional(),
    lineage: candidateLineageSchema.optional(),
  })
  .strict();

const selectionHistorySchema = z.union([
  z
    .object({
      outcome: z.literal("selection").optional(),
      winnerId: nonBlankStringSchema,
      loserId: nonBlankStringSchema,
      winnerPrompt: nonBlankStringSchema,
      loserPrompt: nonBlankStringSchema,
      winnerConcept: nonBlankStringSchema,
      loserConcept: nonBlankStringSchema,
      selectedAt: timestampSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.enum(["tie", "both-lose"]),
      leftId: nonBlankStringSchema,
      rightId: nonBlankStringSchema,
      leftPrompt: nonBlankStringSchema,
      rightPrompt: nonBlankStringSchema,
      leftConcept: nonBlankStringSchema,
      rightConcept: nonBlankStringSchema,
      selectedAt: timestampSchema,
    })
    .strict(),
]);

const leaderboardPreferenceEvidenceSchema = z
  .object({
    poolSize: z.number().int().nonnegative(),
    entries: z
      .array(
        z
          .object({
            rank: z.number().int().positive(),
            candidateId: nonBlankStringSchema.max(200),
            concept: nonBlankStringSchema.max(240),
            style: z.array(nonBlankStringSchema.max(80)).max(4),
            rating: z.number().int(),
            wins: z.number().int().nonnegative(),
            losses: z.number().int().nonnegative(),
            source: z.enum(["curated", "generated"]),
            favorite: z.boolean(),
          })
          .strict(),
      )
      .max(12),
  })
  .strict()
  .superRefine((evidence, context) => {
    const ranks = new Set<number>();
    for (const [index, entry] of evidence.entries.entries()) {
      if (entry.rank > evidence.poolSize || ranks.has(entry.rank)) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "rank"],
          message: "Leaderboard ranks must be unique and within poolSize",
        });
      }
      ranks.add(entry.rank);
    }
    if (evidence.poolSize === 0 && evidence.entries.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "An empty pool cannot include leaderboard entries",
      });
    }
  });

const leaderboardVisualProfileSchema = z
  .object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    sourceCandidateIds: z.array(nonBlankStringSchema.max(200)).min(2).max(4),
    profile: preferenceRevisionSchema,
    reasoningSummary: nonBlankStringSchema.max(2_000),
    analyzedAt: timestampSchema,
  })
  .strict();

const generationPromptCardSchema = z
  .object({
    id: nonBlankStringSchema,
    title: nonBlankStringSchema.max(80),
    prompt: nonBlankStringSchema.min(20).max(1_000),
    negativePrompt: z.string().max(500),
    tags: z.array(nonBlankStringSchema.max(40)).max(8),
  })
  .strict();

const generationJobFields = {
  id: jobIdSchema,
  createdAt: timestampSchema,
  roundNumber: z.number().int().positive(),
  winnerSide: z.enum(["left", "right"]),
  retainedWinner: candidateSchema,
  rejectedCandidate: candidateSchema,
  selectionHistory: z.array(selectionHistorySchema),
  recentConcepts: z.array(nonBlankStringSchema),
  leaderboardEvidence: leaderboardPreferenceEvidenceSchema.optional(),
  leaderboardVisualProfile: leaderboardVisualProfileSchema.optional(),
  preferenceSeed: nonBlankStringSchema,
  preferenceProfile: preferenceProfileSchema.optional(),
  promptCard: generationPromptCardSchema.optional(),
  variationSource: variationSourceSchema.optional(),
};

const challengerGenerationJobSchema = z
  .object({
    ...generationJobFields,
    kind: z.literal("challenger"),
  })
  .strict();

const initialGenerationJobSchema = z
  .object({
    ...generationJobFields,
    kind: z.literal("initial"),
    batchId: jobIdSchema,
    initialSide: z.enum(["left", "right"]),
  })
  .strict();

const refillGenerationJobSchema = z
  .object({
    ...generationJobFields,
    kind: z.literal("refill"),
    sessionId: jobIdSchema,
    pinnedWinnerId: nonBlankStringSchema,
    comparisonOutcome: z.enum(["tie", "both-lose"]).optional(),
  })
  .strict()
  .refine((job) => job.pinnedWinnerId === job.retainedWinner.id, {
    message: "pinnedWinnerId must equal retainedWinner.id",
    path: ["pinnedWinnerId"],
  });

const profileSourceImageSchema = z
  .object({
    filename: z.string().regex(/^[a-f0-9]{64}\.png$/),
    path: z.string().regex(/^profile-sources\/[a-f0-9]{64}\.png$/),
    contentType: z.literal("image/png"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    byteLength: z.number().int().positive(),
  })
  .strict()
  .superRefine((image, context) => {
    if (image.width > 4096 || image.height > 4096) {
      context.addIssue({
        code: "custom",
        message: "Source image dimensions must not exceed 4096 pixels",
      });
    }
    if (image.path !== `profile-sources/${image.filename}`) {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: "Source image path must match its content-addressed filename",
      });
    }
  });

const sourceProfileJobSchema = z
  .object({
    id: jobIdSchema,
    kind: z.literal("source-profile"),
    createdAt: timestampSchema,
    sourceImage: profileSourceImageSchema,
  })
  .strict();

const importedAssetMetadataSchema = z
  .object({
    digest: z.string().regex(/^[a-f0-9]{64}$/),
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

const importAnnotationJobSchema = z
  .object({
    id: jobIdSchema,
    kind: z.literal("import-annotation"),
    createdAt: timestampSchema,
    importSessionId: jobIdSchema,
    importItemId: jobIdSchema,
    asset: importedAssetMetadataSchema,
  })
  .strict();

const leaderboardProfileJobSchema = z
  .object({
    id: jobIdSchema,
    kind: z.literal("leaderboard-profile"),
    createdAt: timestampSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    sources: z
      .array(
        z
          .object({
            candidateId: nonBlankStringSchema.max(200),
            rank: z.number().int().positive(),
            rating: z.number().int(),
            wins: z.number().int().nonnegative(),
            losses: z.number().int().nonnegative(),
            favorite: z.boolean(),
            source: z.enum(["curated", "generated"]),
            concept: nonBlankStringSchema.max(240),
            style: z.array(nonBlankStringSchema.max(80)).max(4),
            sourceImage: profileSourceImageSchema,
          })
          .strict(),
      )
      .min(2)
      .max(4),
  })
  .strict()
  .superRefine((job, context) => {
    const candidateIds = new Set(
      job.sources.map(({ candidateId }) => candidateId),
    );
    const ranks = new Set(job.sources.map(({ rank }) => rank));
    if (candidateIds.size !== job.sources.length) {
      context.addIssue({
        code: "custom",
        path: ["sources"],
        message: "Leaderboard profile sources must use unique candidate IDs",
      });
    }
    if (ranks.size !== job.sources.length) {
      context.addIssue({
        code: "custom",
        path: ["sources"],
        message: "Leaderboard profile sources must use unique ranks",
      });
    }
  });

const promptCardEditorJobSchema = z
  .object({
    id: jobIdSchema,
    kind: z.literal("prompt-card-editor"),
    createdAt: timestampSchema,
    card: generationPromptCardSchema,
    recentRejections: z
      .array(
        z
          .object({
            resultId: nonBlankStringSchema.max(200),
            reason: nonBlankStringSchema.max(240),
            recordedAt: timestampSchema,
          })
          .strict(),
      )
      .min(4)
      .max(12),
  })
  .strict();

const promptCardBlenderJobSchema = z
  .object({
    id: jobIdSchema,
    kind: z.literal("prompt-card-blender"),
    createdAt: timestampSchema,
    cards: z.tuple([generationPromptCardSchema, generationPromptCardSchema]),
    ratio: z.number().min(0.1).max(0.9),
  })
  .strict()
  .refine((job) => job.cards[0].id !== job.cards[1].id, {
    message: "Prompt-card blender inputs must be distinct",
    path: ["cards"],
  });

const promptCardWriterJobSchema = z
  .object({
    id: jobIdSchema,
    kind: z.literal("prompt-card-writer"),
    createdAt: timestampSchema,
    sources: z
      .array(
        z
          .object({
            candidateId: nonBlankStringSchema.max(200),
            concept: nonBlankStringSchema.max(240),
            style: z.array(nonBlankStringSchema.max(80)).max(4),
            sourceImage: profileSourceImageSchema,
          })
          .strict(),
      )
      .min(3)
      .max(5),
  })
  .strict()
  .superRefine((job, context) => {
    const candidateIds = new Set(
      job.sources.map(({ candidateId }) => candidateId),
    );
    if (candidateIds.size !== job.sources.length) {
      context.addIssue({
        code: "custom",
        path: ["sources"],
        message: "Prompt-card writer sources must use unique candidate IDs",
      });
    }
  });

const discriminatedGenerationJobSchema = z.discriminatedUnion("kind", [
  challengerGenerationJobSchema,
  initialGenerationJobSchema,
  refillGenerationJobSchema,
]);

export const generationJobSchema = z.preprocess((value) => {
  if (value !== null && typeof value === "object" && !("kind" in value)) {
    return { ...value, kind: "challenger" };
  }
  return value;
}, discriminatedGenerationJobSchema);

const mailboxJobSchema = z.preprocess(
  (value) => {
    if (value !== null && typeof value === "object" && !("kind" in value)) {
      return { ...value, kind: "challenger" };
    }
    return value;
  },
  z.discriminatedUnion("kind", [
    challengerGenerationJobSchema,
    initialGenerationJobSchema,
    refillGenerationJobSchema,
    sourceProfileJobSchema,
    leaderboardProfileJobSchema,
    promptCardEditorJobSchema,
    promptCardBlenderJobSchema,
    promptCardWriterJobSchema,
    importAnnotationJobSchema,
  ]),
);

const proposedChallengerSchema = z
  .object({
    concept: nonBlankStringSchema,
    visualPrompt: nonBlankStringSchema,
    styleTags: z.array(nonBlankStringSchema),
    reasoningSummary: nonBlankStringSchema,
    preferenceRevision: preferenceRevisionSchema.optional(),
  })
  .strict();

const completedAssetSchema = z
  .object({
    candidateId: z
      .string()
      .min(1)
      .regex(GENERATION_JOB_ID_PATTERN, "Invalid candidate ID"),
    filename: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*\.png$/, "Invalid asset filename"),
    imageUrl: nonBlankStringSchema,
    contentType: z.literal("image/png"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    byteLength: z.number().int().positive(),
  })
  .strict()
  .superRefine((asset, context) => {
    const legacyFilename = `${asset.candidateId}.png`;
    if (
      asset.filename !== legacyFilename &&
      !/^[a-f0-9]{64}\.png$/.test(asset.filename)
    ) {
      context.addIssue({
        code: "custom",
        path: ["filename"],
        message: `Asset filename must be a SHA-256 digest or equal legacy name ${legacyFilename}`,
      });
    }
    if (asset.imageUrl !== `/api/assets/${asset.filename}`) {
      context.addIssue({
        code: "custom",
        path: ["imageUrl"],
        message: `Asset imageUrl must equal /api/assets/${asset.filename}`,
      });
    }
  });

const completedGenerationResultSchema = z
  .object({
    jobId: jobIdSchema,
    status: z.literal("completed"),
    completedAt: timestampSchema,
    proposal: proposedChallengerSchema,
    asset: completedAssetSchema,
  })
  .strict()
  .refine((result) => result.asset.width === result.asset.height, {
    message: "Completed generation assets must be square",
    path: ["asset", "height"],
  });

const completedSourceProfileResultSchema = z
  .object({
    jobId: jobIdSchema,
    kind: z.literal("source-profile"),
    status: z.literal("completed"),
    completedAt: timestampSchema,
    profile: preferenceRevisionSchema,
    reasoningSummary: nonBlankStringSchema.max(2_000),
  })
  .strict();

const completedLeaderboardProfileResultSchema = z
  .object({
    jobId: jobIdSchema,
    kind: z.literal("leaderboard-profile"),
    status: z.literal("completed"),
    completedAt: timestampSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    profile: preferenceRevisionSchema,
    reasoningSummary: nonBlankStringSchema.max(2_000),
  })
  .strict();

const promptCardEditorProposalSchema = z
  .object({
    title: nonBlankStringSchema.max(80),
    prompt: nonBlankStringSchema.min(20).max(1_000),
    negativePrompt: z.string().max(500),
    tags: z.array(nonBlankStringSchema.max(40)).max(8),
    reasoningSummary: nonBlankStringSchema.max(1_000),
  })
  .strict();
const promptCardEditorProposalsSchema = z
  .array(promptCardEditorProposalSchema)
  .length(2)
  .superRefine((proposals, context) => {
    if (proposals[0]?.prompt === proposals[1]?.prompt) {
      context.addIssue({
        code: "custom",
        message: "Prompt-card editor proposals must be distinct",
      });
    }
  });

const completedPromptCardEditorResultSchema = z
  .object({
    jobId: jobIdSchema,
    kind: z.literal("prompt-card-editor"),
    status: z.literal("completed"),
    completedAt: timestampSchema,
    cardId: nonBlankStringSchema,
    proposals: promptCardEditorProposalsSchema,
  })
  .strict();

const completedPromptCardBlenderResultSchema = z
  .object({
    jobId: jobIdSchema,
    kind: z.literal("prompt-card-blender"),
    status: z.literal("completed"),
    completedAt: timestampSchema,
    cardIds: z.tuple([nonBlankStringSchema, nonBlankStringSchema]),
    proposal: promptCardEditorProposalSchema,
  })
  .strict();

const completedPromptCardWriterResultSchema = z
  .object({
    jobId: jobIdSchema,
    kind: z.literal("prompt-card-writer"),
    status: z.literal("completed"),
    completedAt: timestampSchema,
    sourceCandidateIds: z
      .array(nonBlankStringSchema.max(200))
      .min(3)
      .max(5)
      .superRefine((ids, context) => {
        if (new Set(ids).size !== ids.length) {
          context.addIssue({
            code: "custom",
            message: "Prompt-card writer source IDs must be unique",
          });
        }
      }),
    proposal: promptCardEditorProposalSchema,
  })
  .strict();

const importedCandidateAnnotationSchema = z
  .object({
    concept: nonBlankStringSchema.max(240),
    prompt: nonBlankStringSchema.max(1_000),
    style: z
      .array(nonBlankStringSchema.max(80))
      .min(1)
      .max(8)
      .superRefine((style, context) => {
        if (new Set(style).size !== style.length) {
          context.addIssue({
            code: "custom",
            message: "Imported annotation style tags must be unique",
          });
        }
      }),
    reasoningSummary: nonBlankStringSchema.max(2_000),
    source: z.literal("automated"),
  })
  .strict();

const completedImportAnnotationResultSchema = z
  .object({
    jobId: jobIdSchema,
    kind: z.literal("import-annotation"),
    status: z.literal("completed"),
    completedAt: timestampSchema,
    annotation: importedCandidateAnnotationSchema,
  })
  .strict();

const failedGenerationResultSchema = z
  .object({
    jobId: jobIdSchema,
    status: z.literal("failed"),
    completedAt: timestampSchema,
    message: nonBlankStringSchema,
    retryable: z.boolean(),
    category: z
      .enum(["operational", "moderation", "invalid-output"])
      .optional(),
  })
  .strict();

export const generationResultSchema = z.union([
  completedGenerationResultSchema,
  failedGenerationResultSchema,
]);

const sourceProfileResultSchema = z.union([
  completedSourceProfileResultSchema,
  failedGenerationResultSchema,
]);

const leaderboardProfileResultSchema = z.union([
  completedLeaderboardProfileResultSchema,
  failedGenerationResultSchema,
]);

const promptCardEditorResultSchema = z.union([
  completedPromptCardEditorResultSchema,
  failedGenerationResultSchema,
]);

const promptCardBlenderResultSchema = z.union([
  completedPromptCardBlenderResultSchema,
  failedGenerationResultSchema,
]);

const promptCardWriterResultSchema = z.union([
  completedPromptCardWriterResultSchema,
  failedGenerationResultSchema,
]);

const importAnnotationResultSchema = z.union([
  completedImportAnnotationResultSchema,
  failedGenerationResultSchema,
]);

const mailboxResultSchema = z.union([
  completedGenerationResultSchema,
  completedSourceProfileResultSchema,
  completedLeaderboardProfileResultSchema,
  completedPromptCardEditorResultSchema,
  completedPromptCardBlenderResultSchema,
  completedPromptCardWriterResultSchema,
  completedImportAnnotationResultSchema,
  failedGenerationResultSchema,
]);

export type GenerationJob = z.infer<typeof generationJobSchema>;
export type { LeaderboardPreferenceEvidence };
export type GenerationResult = z.infer<typeof generationResultSchema>;
export type SourceProfileJob = z.infer<typeof sourceProfileJobSchema>;
export type SourceProfileResult = z.infer<typeof sourceProfileResultSchema>;
export type LeaderboardProfileJob = z.infer<typeof leaderboardProfileJobSchema>;
export type LeaderboardProfileResult = z.infer<
  typeof leaderboardProfileResultSchema
>;
export type PromptCardEditorJob = z.infer<typeof promptCardEditorJobSchema>;
export type PromptCardEditorResult = z.infer<
  typeof promptCardEditorResultSchema
>;
export type PromptCardBlenderJob = z.infer<typeof promptCardBlenderJobSchema>;
export type PromptCardBlenderResult = z.infer<
  typeof promptCardBlenderResultSchema
>;
export type PromptCardWriterJob = z.infer<typeof promptCardWriterJobSchema>;
export type PromptCardWriterResult = z.infer<
  typeof promptCardWriterResultSchema
>;
export type ImportAnnotationRequest = z.infer<
  typeof importAnnotationJobSchema
> & {
  asset: ImportedAssetMetadata;
};
export type ImportAnnotationJob = ImportAnnotationRequest;
export type ImportAnnotationResult =
  | (z.infer<typeof completedImportAnnotationResultSchema> & {
      annotation: ImportedCandidateAnnotation & { source: "automated" };
    })
  | z.infer<typeof failedGenerationResultSchema>;
export type AgentJob =
  | GenerationJob
  | SourceProfileJob
  | LeaderboardProfileJob
  | PromptCardEditorJob
  | PromptCardBlenderJob
  | PromptCardWriterJob
  | ImportAnnotationJob;
export type AgentResult =
  | GenerationResult
  | SourceProfileResult
  | LeaderboardProfileResult
  | PromptCardEditorResult
  | PromptCardBlenderResult
  | PromptCardWriterResult
  | ImportAnnotationResult;

const reservedJobRecordSchema = z
  .object({
    state: z.literal("reserved"),
    job: mailboxJobSchema,
    reservedBy: z
      .object({
        pid: z.number().int().positive(),
        token: nonBlankStringSchema,
        reservedAt: timestampSchema,
      })
      .strict(),
  })
  .strict();

const archivedJobRecordSchema = z
  .object({
    state: z.literal("archived"),
    jobId: jobIdSchema,
    job: mailboxJobSchema.optional(),
    archivedAt: timestampSchema,
  })
  .strict();

const generationJobRecordSchema = z.discriminatedUnion("state", [
  reservedJobRecordSchema,
  archivedJobRecordSchema,
]);

type GenerationJobRecord = z.infer<typeof generationJobRecordSchema>;

export interface GenerationMailbox {
  enqueue(job: GenerationJob): Promise<void>;
  readPending(jobId: string): Promise<GenerationJob | null>;
  readWork(jobId: string): Promise<GenerationJob | null>;
  readResult(jobId: string): Promise<GenerationResult | null>;
  archive(jobId: string): Promise<void>;
}

export interface SourceProfileMailbox {
  enqueueSourceProfile(job: SourceProfileJob): Promise<void>;
  readSourceProfileWork(jobId: string): Promise<SourceProfileJob | null>;
  readSourceProfileResult(jobId: string): Promise<SourceProfileResult | null>;
  archiveSourceProfile(jobId: string): Promise<void>;
}

export interface LeaderboardProfileMailbox {
  enqueueLeaderboardProfile(job: LeaderboardProfileJob): Promise<void>;
  readLeaderboardProfileWork(
    jobId: string,
  ): Promise<LeaderboardProfileJob | null>;
  readLeaderboardProfileResult(
    jobId: string,
  ): Promise<LeaderboardProfileResult | null>;
  archiveLeaderboardProfile(jobId: string): Promise<void>;
}

export interface PromptCardEditorMailbox {
  enqueuePromptCardEditor(job: PromptCardEditorJob): Promise<void>;
  readPromptCardEditorWork(jobId: string): Promise<PromptCardEditorJob | null>;
  readPromptCardEditorResult(
    jobId: string,
  ): Promise<PromptCardEditorResult | null>;
  archivePromptCardEditor(jobId: string): Promise<void>;
}

export interface PromptCardBlenderMailbox {
  enqueuePromptCardBlender(job: PromptCardBlenderJob): Promise<void>;
  readPromptCardBlenderWork(
    jobId: string,
  ): Promise<PromptCardBlenderJob | null>;
  readPromptCardBlenderResult(
    jobId: string,
  ): Promise<PromptCardBlenderResult | null>;
  archivePromptCardBlender(jobId: string): Promise<void>;
}

export interface PromptCardWriterMailbox {
  enqueuePromptCardWriter(job: PromptCardWriterJob): Promise<void>;
  readPromptCardWriterWork(jobId: string): Promise<PromptCardWriterJob | null>;
  readPromptCardWriterResult(
    jobId: string,
  ): Promise<PromptCardWriterResult | null>;
  archivePromptCardWriter(jobId: string): Promise<void>;
}

export interface ImportAnnotationMailbox {
  enqueueImportAnnotation(job: ImportAnnotationJob): Promise<void>;
  readImportAnnotationWork(jobId: string): Promise<ImportAnnotationJob | null>;
  readImportAnnotationResult(
    jobId: string,
  ): Promise<ImportAnnotationResult | null>;
  archiveImportAnnotation(jobId: string): Promise<void>;
}

export class DuplicateGenerationJobError extends Error {}

export class FileGenerationMailbox
  implements
    GenerationMailbox,
    SourceProfileMailbox,
    LeaderboardProfileMailbox,
    PromptCardEditorMailbox,
    PromptCardBlenderMailbox,
    PromptCardWriterMailbox,
    ImportAnnotationMailbox
{
  private static readonly inFlightEnqueues = new Map<string, string>();

  constructor(
    private readonly rootDirectory = join(
      process.cwd(),
      process.env.LOCAL_DATA_DIR ?? ".local-data",
      "agent-mailbox",
    ),
  ) {}

  async enqueue(job: GenerationJob): Promise<void> {
    const validated = generationJobSchema.parse(job);
    await this.enqueueValidated(validated);
  }

  async enqueueSourceProfile(job: SourceProfileJob): Promise<void> {
    const validated = sourceProfileJobSchema.parse(job);
    await this.enqueueValidated(validated);
  }

  async enqueueLeaderboardProfile(job: LeaderboardProfileJob): Promise<void> {
    const validated = leaderboardProfileJobSchema.parse(job);
    await this.enqueueValidated(validated);
  }

  async enqueuePromptCardEditor(job: PromptCardEditorJob): Promise<void> {
    const validated = promptCardEditorJobSchema.parse(job);
    await this.enqueueValidated(validated);
  }

  async enqueuePromptCardBlender(job: PromptCardBlenderJob): Promise<void> {
    const validated = promptCardBlenderJobSchema.parse(job);
    await this.enqueueValidated(validated);
  }

  async enqueuePromptCardWriter(job: PromptCardWriterJob): Promise<void> {
    const validated = promptCardWriterJobSchema.parse(job);
    await this.enqueueValidated(validated);
  }

  async enqueueImportAnnotation(job: ImportAnnotationJob): Promise<void> {
    const validated = importAnnotationJobSchema.parse(job);
    await this.enqueueValidated(validated);
  }

  private async enqueueValidated(validated: AgentJob): Promise<void> {
    const operationKey = `${resolve(this.rootDirectory)}\0${validated.id}`;
    const operationToken = crypto.randomUUID();
    if (FileGenerationMailbox.inFlightEnqueues.has(operationKey)) {
      throw new DuplicateGenerationJobError(
        `Generation job ${validated.id} already exists`,
      );
    }
    FileGenerationMailbox.inFlightEnqueues.set(operationKey, operationToken);

    try {
      const idsDirectory = join(this.rootDirectory, "ids");
      const pendingDirectory = join(this.rootDirectory, "pending");
      const recordPath = join(idsDirectory, `${validated.id}.json`);
      const pendingPath = join(pendingDirectory, `${validated.id}.json`);
      const reservation: GenerationJobRecord = {
        state: "reserved",
        job: validated,
        reservedBy: {
          pid: process.pid,
          token: operationToken,
          reservedAt: new Date().toISOString(),
        },
      };

      const reserved = await this.publishJsonNoReplace(
        idsDirectory,
        recordPath,
        reservation,
      );
      if (!reserved) {
        const existing = await this.readValidated(
          recordPath,
          generationJobRecordSchema,
        );
        if (!existing) {
          throw new Error(`Generation job record ${validated.id} disappeared`);
        }
        if (existing.state === "archived") {
          throw new DuplicateGenerationJobError(
            `Generation job ID ${validated.id} was already used`,
          );
        }
        if (!this.sameJob(existing.job, validated)) {
          throw new DuplicateGenerationJobError(
            `Generation job ID ${validated.id} was already used`,
          );
        }
        if (await this.hasPublishedArtifact(validated.id)) {
          throw new DuplicateGenerationJobError(
            `Generation job ${validated.id} already exists`,
          );
        }
        if (this.reservationOwnerIsActive(existing)) {
          throw new DuplicateGenerationJobError(
            `Generation job ${validated.id} is being enqueued`,
          );
        }
      }

      const published = await this.publishJsonNoReplace(
        pendingDirectory,
        pendingPath,
        validated,
      );
      if (!published) {
        throw new DuplicateGenerationJobError(
          `Generation job ${validated.id} already exists`,
        );
      }
    } finally {
      if (
        FileGenerationMailbox.inFlightEnqueues.get(operationKey) ===
        operationToken
      ) {
        FileGenerationMailbox.inFlightEnqueues.delete(operationKey);
      }
    }
  }

  async readPending(jobId: string): Promise<GenerationJob | null> {
    const validatedJobId = jobIdSchema.parse(jobId);
    const job = await this.readJobAt(
      join(this.rootDirectory, "pending", `${validatedJobId}.json`),
      validatedJobId,
    );
    if (!job) return null;
    return generationJobSchema.parse(job);
  }

  async readWork(jobId: string): Promise<GenerationJob | null> {
    const validatedJobId = jobIdSchema.parse(jobId);
    const pending = await this.readPending(validatedJobId);
    if (pending) return pending;

    const active = await this.readJobAt(
      join(this.rootDirectory, "active", `${validatedJobId}.json`),
      validatedJobId,
    );
    if (active) return generationJobSchema.parse(active);

    const record = await this.readValidated(
      join(this.rootDirectory, "ids", `${validatedJobId}.json`),
      generationJobRecordSchema,
    );
    return record?.state === "reserved"
      ? generationJobSchema.parse(record.job)
      : null;
  }

  async readResult(jobId: string): Promise<GenerationResult | null> {
    const result = await this.readMailboxResult(jobId);
    return result ? generationResultSchema.parse(result) : null;
  }

  async readSourceProfileWork(jobId: string): Promise<SourceProfileJob | null> {
    const validatedJobId = jobIdSchema.parse(jobId);
    const pending = await this.readJobAt(
      join(this.rootDirectory, "pending", `${validatedJobId}.json`),
      validatedJobId,
    );
    if (pending) return sourceProfileJobSchema.parse(pending);
    const active = await this.readJobAt(
      join(this.rootDirectory, "active", `${validatedJobId}.json`),
      validatedJobId,
    );
    if (active) return sourceProfileJobSchema.parse(active);
    const record = await this.readValidated(
      join(this.rootDirectory, "ids", `${validatedJobId}.json`),
      generationJobRecordSchema,
    );
    return record?.state === "reserved"
      ? sourceProfileJobSchema.parse(record.job)
      : null;
  }

  async readSourceProfileResult(
    jobId: string,
  ): Promise<SourceProfileResult | null> {
    const result = await this.readMailboxResult(jobId);
    return result ? sourceProfileResultSchema.parse(result) : null;
  }

  async readLeaderboardProfileWork(
    jobId: string,
  ): Promise<LeaderboardProfileJob | null> {
    const validatedJobId = jobIdSchema.parse(jobId);
    const pending = await this.readJobAt(
      join(this.rootDirectory, "pending", `${validatedJobId}.json`),
      validatedJobId,
    );
    if (pending) return leaderboardProfileJobSchema.parse(pending);
    const active = await this.readJobAt(
      join(this.rootDirectory, "active", `${validatedJobId}.json`),
      validatedJobId,
    );
    if (active) return leaderboardProfileJobSchema.parse(active);
    const record = await this.readValidated(
      join(this.rootDirectory, "ids", `${validatedJobId}.json`),
      generationJobRecordSchema,
    );
    return record?.state === "reserved"
      ? leaderboardProfileJobSchema.parse(record.job)
      : null;
  }

  async readLeaderboardProfileResult(
    jobId: string,
  ): Promise<LeaderboardProfileResult | null> {
    const result = await this.readMailboxResult(jobId);
    return result ? leaderboardProfileResultSchema.parse(result) : null;
  }

  async readPromptCardEditorWork(
    jobId: string,
  ): Promise<PromptCardEditorJob | null> {
    const validatedJobId = jobIdSchema.parse(jobId);
    const pending = await this.readJobAt(
      join(this.rootDirectory, "pending", `${validatedJobId}.json`),
      validatedJobId,
    );
    if (pending) return promptCardEditorJobSchema.parse(pending);
    const active = await this.readJobAt(
      join(this.rootDirectory, "active", `${validatedJobId}.json`),
      validatedJobId,
    );
    if (active) return promptCardEditorJobSchema.parse(active);
    const record = await this.readValidated(
      join(this.rootDirectory, "ids", `${validatedJobId}.json`),
      generationJobRecordSchema,
    );
    return record?.state === "reserved"
      ? promptCardEditorJobSchema.parse(record.job)
      : null;
  }

  async readPromptCardEditorResult(
    jobId: string,
  ): Promise<PromptCardEditorResult | null> {
    const result = await this.readMailboxResult(jobId);
    return result ? promptCardEditorResultSchema.parse(result) : null;
  }

  async readPromptCardBlenderWork(
    jobId: string,
  ): Promise<PromptCardBlenderJob | null> {
    const validatedJobId = jobIdSchema.parse(jobId);
    const pending = await this.readJobAt(
      join(this.rootDirectory, "pending", `${validatedJobId}.json`),
      validatedJobId,
    );
    if (pending) return promptCardBlenderJobSchema.parse(pending);
    const active = await this.readJobAt(
      join(this.rootDirectory, "active", `${validatedJobId}.json`),
      validatedJobId,
    );
    if (active) return promptCardBlenderJobSchema.parse(active);
    const record = await this.readValidated(
      join(this.rootDirectory, "ids", `${validatedJobId}.json`),
      generationJobRecordSchema,
    );
    return record?.state === "reserved"
      ? promptCardBlenderJobSchema.parse(record.job)
      : null;
  }

  async readPromptCardBlenderResult(
    jobId: string,
  ): Promise<PromptCardBlenderResult | null> {
    const result = await this.readMailboxResult(jobId);
    return result ? promptCardBlenderResultSchema.parse(result) : null;
  }

  async readPromptCardWriterWork(
    jobId: string,
  ): Promise<PromptCardWriterJob | null> {
    const validatedJobId = jobIdSchema.parse(jobId);
    const pending = await this.readJobAt(
      join(this.rootDirectory, "pending", `${validatedJobId}.json`),
      validatedJobId,
    );
    if (pending) return promptCardWriterJobSchema.parse(pending);
    const active = await this.readJobAt(
      join(this.rootDirectory, "active", `${validatedJobId}.json`),
      validatedJobId,
    );
    if (active) return promptCardWriterJobSchema.parse(active);
    const record = await this.readValidated(
      join(this.rootDirectory, "ids", `${validatedJobId}.json`),
      generationJobRecordSchema,
    );
    return record?.state === "reserved"
      ? promptCardWriterJobSchema.parse(record.job)
      : null;
  }

  async readPromptCardWriterResult(
    jobId: string,
  ): Promise<PromptCardWriterResult | null> {
    const result = await this.readMailboxResult(jobId);
    return result ? promptCardWriterResultSchema.parse(result) : null;
  }

  async readImportAnnotationWork(
    jobId: string,
  ): Promise<ImportAnnotationJob | null> {
    const validatedJobId = jobIdSchema.parse(jobId);
    const pending = await this.readJobAt(
      join(this.rootDirectory, "pending", `${validatedJobId}.json`),
      validatedJobId,
    );
    if (pending) return importAnnotationJobSchema.parse(pending);
    const active = await this.readJobAt(
      join(this.rootDirectory, "active", `${validatedJobId}.json`),
      validatedJobId,
    );
    if (active) return importAnnotationJobSchema.parse(active);
    const record = await this.readValidated(
      join(this.rootDirectory, "ids", `${validatedJobId}.json`),
      generationJobRecordSchema,
    );
    return record?.state === "reserved"
      ? importAnnotationJobSchema.parse(record.job)
      : null;
  }

  async readImportAnnotationResult(
    jobId: string,
  ): Promise<ImportAnnotationResult | null> {
    const result = await this.readMailboxResult(jobId);
    return result ? importAnnotationResultSchema.parse(result) : null;
  }

  private async readMailboxResult(jobId: string): Promise<AgentResult | null> {
    const validatedJobId = jobIdSchema.parse(jobId);
    const [completed, failed] = await Promise.all([
      this.readValidated(
        join(this.rootDirectory, "completed", `${validatedJobId}.json`),
        mailboxResultSchema,
      ),
      this.readValidated(
        join(this.rootDirectory, "failed", `${validatedJobId}.json`),
        mailboxResultSchema,
      ),
    ]);

    if (completed && failed) {
      throw new Error(
        `Generation job ${validatedJobId} has two terminal results`,
      );
    }
    const result = completed ?? failed;
    if (result && result.jobId !== validatedJobId) {
      throw new Error(`Result for ${validatedJobId} contains another job ID`);
    }
    if (completed && completed.status !== "completed") {
      throw new Error(
        `Completed job ${validatedJobId} has a non-completed result`,
      );
    }
    if (failed && failed.status !== "failed") {
      throw new Error(`Failed job ${validatedJobId} has a non-failed result`);
    }
    return result;
  }

  async archive(jobId: string): Promise<void> {
    const validatedJobId = jobIdSchema.parse(jobId);
    const idsDirectory = join(this.rootDirectory, "ids");
    const recordPath = join(idsDirectory, `${validatedJobId}.json`);
    const existing = await this.readValidated(
      recordPath,
      generationJobRecordSchema,
    );

    if (existing?.state !== "archived") {
      const archived: GenerationJobRecord = {
        state: "archived",
        jobId: validatedJobId,
        ...(existing?.state === "reserved" ? { job: existing.job } : {}),
        archivedAt: new Date().toISOString(),
      };
      await this.writeJsonAtomic(idsDirectory, recordPath, archived);
    }

    await Promise.all(
      [
        join(this.rootDirectory, "pending", `${validatedJobId}.json`),
        join(this.rootDirectory, "active", `${validatedJobId}.json`),
        join(this.rootDirectory, "completed", `${validatedJobId}.json`),
        join(this.rootDirectory, "failed", `${validatedJobId}.json`),
        join(this.rootDirectory, "outcomes", `${validatedJobId}.json`),
        join(this.rootDirectory, "leases", `${validatedJobId}.json`),
      ].map((path) => rm(path, { force: true })),
    );
  }

  archiveSourceProfile(jobId: string): Promise<void> {
    return this.archive(jobId);
  }

  archiveLeaderboardProfile(jobId: string): Promise<void> {
    return this.archive(jobId);
  }

  archivePromptCardEditor(jobId: string): Promise<void> {
    return this.archive(jobId);
  }

  archivePromptCardBlender(jobId: string): Promise<void> {
    return this.archive(jobId);
  }

  archivePromptCardWriter(jobId: string): Promise<void> {
    return this.archive(jobId);
  }

  archiveImportAnnotation(jobId: string): Promise<void> {
    return this.archive(jobId);
  }

  private async readJobAt(
    path: string,
    jobId: string,
  ): Promise<AgentJob | null> {
    const job = await this.readValidated(path, mailboxJobSchema);
    if (job && job.id !== jobId) {
      throw new Error(`Work for ${jobId} contains another job ID`);
    }
    return job;
  }

  private async readValidated<T>(
    path: string,
    schema: z.ZodType<T>,
  ): Promise<T | null> {
    try {
      return schema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async publishJsonNoReplace(
    directory: string,
    destinationPath: string,
    value: unknown,
  ): Promise<boolean> {
    await mkdir(directory, { recursive: true });
    const temporaryPath = join(
      directory,
      `.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    try {
      await link(temporaryPath, destinationPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private async writeJsonAtomic(
    directory: string,
    destinationPath: string,
    value: unknown,
  ): Promise<void> {
    await mkdir(directory, { recursive: true });
    const temporaryPath = join(
      directory,
      `.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporaryPath, destinationPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private async hasPublishedArtifact(jobId: string): Promise<boolean> {
    for (const directory of ["pending", "active", "completed", "failed"]) {
      try {
        await access(join(this.rootDirectory, directory, `${jobId}.json`));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return false;
  }

  private reservationOwnerIsActive(
    record: z.infer<typeof reservedJobRecordSchema>,
  ): boolean {
    if (record.reservedBy.pid === process.pid) return false;
    try {
      process.kill(record.reservedBy.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  private sameJob(left: AgentJob, right: AgentJob): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }
}
