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
import { z } from "zod";

const timestampSchema = z.string().datetime({ offset: true });
const nonBlankStringSchema = z.string().trim().min(1);
const jobIdSchema = z
  .string()
  .min(1)
  .regex(GENERATION_JOB_ID_PATTERN, "Invalid generation job ID");

const preferenceRevisionSchema = z
  .object({
    themes: z
      .string()
      .refine((value) => value.trim().length >= 20)
      .max(2_000),
    inspiration: z.string().max(1_000),
    mediaTypes: z.string().max(500),
    visualStyle: z.string().max(500),
    colorPalette: z.string().max(500),
    contentLevel: z.enum(["family-friendly", "adult-allowed"]),
    avoid: z.string().max(800),
  })
  .strict();

const currentPreferenceProfileSchema = preferenceRevisionSchema.extend({
  adaptationMode: z.enum(["static", "adaptive"]),
  adaptationSourceWinnerIds: z.array(nonBlankStringSchema.max(200)).max(12),
  adaptationSourceRejectedIds: z
    .array(nonBlankStringSchema.max(200))
    .max(12)
    .default([]),
});

const transitionalPreferenceProfileSchema = preferenceRevisionSchema
  .extend({
    inspirationBase: z.string().optional(),
    inspirationMode: z.enum(["static", "adaptive"]),
    inspirationSourceWinnerIds: z
      .array(nonBlankStringSchema.max(200))
      .max(12)
      .optional(),
    adaptationMode: z.enum(["static", "adaptive"]).optional(),
    adaptationSourceWinnerIds: z
      .array(nonBlankStringSchema.max(200))
      .max(12)
      .optional(),
    adaptationSourceRejectedIds: z
      .array(nonBlankStringSchema.max(200))
      .max(12)
      .optional(),
  })
  .transform((profile) => ({
    themes: profile.themes,
    inspiration: profile.inspiration,
    mediaTypes: profile.mediaTypes,
    visualStyle: profile.visualStyle,
    colorPalette: profile.colorPalette,
    contentLevel: profile.contentLevel,
    avoid: profile.avoid,
    adaptationMode: profile.adaptationMode ?? profile.inspirationMode,
    adaptationSourceWinnerIds:
      profile.adaptationSourceWinnerIds ??
      profile.inspirationSourceWinnerIds ??
      [],
    adaptationSourceRejectedIds: profile.adaptationSourceRejectedIds ?? [],
  }));

const preferenceProfileSchema = z.union([
  currentPreferenceProfileSchema,
  transitionalPreferenceProfileSchema,
]);

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

const generationJobFields = {
  id: jobIdSchema,
  createdAt: timestampSchema,
  roundNumber: z.number().int().positive(),
  winnerSide: z.enum(["left", "right"]),
  retainedWinner: candidateSchema,
  rejectedCandidate: candidateSchema,
  selectionHistory: z.array(selectionHistorySchema),
  recentConcepts: z.array(nonBlankStringSchema),
  preferenceSeed: nonBlankStringSchema,
  preferenceProfile: preferenceProfileSchema.optional(),
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

const sourceProfileJobSchema = z
  .object({
    id: jobIdSchema,
    kind: z.literal("source-profile"),
    createdAt: timestampSchema,
    sourceImage: z
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
            message:
              "Source image path must match its content-addressed filename",
          });
        }
      }),
  })
  .strict();

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

const mailboxResultSchema = z.union([
  completedGenerationResultSchema,
  completedSourceProfileResultSchema,
  failedGenerationResultSchema,
]);

export type GenerationJob = z.infer<typeof generationJobSchema>;
export type GenerationResult = z.infer<typeof generationResultSchema>;
export type SourceProfileJob = z.infer<typeof sourceProfileJobSchema>;
export type SourceProfileResult = z.infer<typeof sourceProfileResultSchema>;
export type AgentJob = GenerationJob | SourceProfileJob;
export type AgentResult = GenerationResult | SourceProfileResult;

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

export class DuplicateGenerationJobError extends Error {}

export class FileGenerationMailbox
  implements GenerationMailbox, SourceProfileMailbox
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
      ].map((path) => rm(path, { force: true })),
    );
  }

  archiveSourceProfile(jobId: string): Promise<void> {
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
