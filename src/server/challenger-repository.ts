import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ChallengerState } from "@/domain/challenger-state";
import { GENERATION_JOB_ID_PATTERN } from "@/domain/game";
import { z } from "zod";

export interface ChallengerRepository {
  load(): Promise<ChallengerState | null>;
  save(state: ChallengerState): Promise<void>;
  clearSession(sessionId: string): Promise<void>;
  withLock<T>(operation: () => Promise<T>): Promise<T>;
}

interface RepositoryLockOptions {
  lockTimeoutMs?: number;
  staleLockMs?: number;
  retryDelayMs?: number;
}

interface LockOwner {
  pid: number;
  token: string;
  acquiredAt: string;
}

const preferenceRevisionSchema = z
  .object({
    themes: z
      .string()
      .max(2_000)
      .refine((value) => value.trim().length >= 20),
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
  adaptationSourceWinnerIds: z.array(z.string().trim().min(1).max(200)).max(12),
  adaptationSourceRejectedIds: z
    .array(z.string().trim().min(1).max(200))
    .max(12)
    .default([]),
});

const transitionalPreferenceProfileSchema = preferenceRevisionSchema
  .extend({
    inspirationBase: z.string().max(1_000).optional(),
    inspirationMode: z.enum(["static", "adaptive"]),
    inspirationSourceWinnerIds: z
      .array(z.string().trim().min(1).max(200))
      .max(12)
      .optional(),
    adaptationMode: z.enum(["static", "adaptive"]).optional(),
    adaptationSourceWinnerIds: z
      .array(z.string().trim().min(1).max(200))
      .max(12)
      .optional(),
    adaptationSourceRejectedIds: z
      .array(z.string().trim().min(1).max(200))
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
    id: z.string().min(1),
    imageUrl: z.string().min(1),
    prompt: z.string().min(1),
    concept: z.string().min(1),
    style: z.array(z.string().min(1)),
    createdAt: z.string().min(1),
    winCount: z.number().int().nonnegative(),
    reasoningSummary: z.string().optional(),
    preferenceRevision: preferenceRevisionSchema.optional(),
  })
  .strict();

const bufferedCandidateSchema = z
  .object({
    candidate: candidateSchema,
    source: z.enum(["seed", "generated"]),
    pinnedWinnerId: z.string().min(1).nullable(),
    enqueuedAt: z.string().min(1),
  })
  .strict();

const candidateRatingSchema = z
  .object({
    candidate: candidateSchema,
    rating: z.number().finite(),
    wins: z.number().int().nonnegative(),
    losses: z.number().int().nonnegative(),
    source: z.enum(["curated", "generated"]),
    poolMember: z.boolean(),
    lastServedAt: z.string().min(1).nullable(),
    favorite: z.boolean().optional(),
  })
  .strict();

const selectionHistorySchema = z
  .object({
    winnerId: z.string().min(1),
    loserId: z.string().min(1),
    winnerPrompt: z.string().min(1),
    loserPrompt: z.string().min(1),
    winnerConcept: z.string().min(1),
    loserConcept: z.string().min(1),
    selectedAt: z.string().min(1),
  })
  .strict();

const refillGenerationJobSnapshotSchema = z
  .object({
    id: z.string().regex(GENERATION_JOB_ID_PATTERN),
    kind: z.literal("refill"),
    createdAt: z.string().min(1),
    roundNumber: z.number().int().positive(),
    winnerSide: z.enum(["left", "right"]),
    retainedWinner: candidateSchema,
    rejectedCandidate: candidateSchema,
    selectionHistory: z.array(selectionHistorySchema),
    recentConcepts: z.array(z.string().min(1)),
    preferenceSeed: z.string().min(1),
    preferenceProfile: preferenceProfileSchema.optional(),
    sessionId: z.string().regex(GENERATION_JOB_ID_PATTERN),
    pinnedWinnerId: z.string().min(1),
  })
  .strict()
  .refine((job) => job.pinnedWinnerId === job.retainedWinner.id, {
    message: "pinnedWinnerId must equal retainedWinner.id",
    path: ["pinnedWinnerId"],
  });

const challengerStateSchema: z.ZodType<ChallengerState> = z
  .object({
    version: z.literal(1),
    sessionId: z.string().min(1),
    ready: z.array(bufferedCandidateSchema),
    refillJobs: z.array(
      z
        .object({
          jobId: z.string().regex(GENERATION_JOB_ID_PATTERN),
          pinnedWinnerId: z.string().min(1),
          enqueuedAt: z.string().min(1),
          expectedJob: refillGenerationJobSnapshotSchema,
        })
        .strict()
        .superRefine((record, context) => {
          if (record.jobId !== record.expectedJob.id) {
            context.addIssue({
              code: "custom",
              message: "jobId must equal expectedJob.id",
              path: ["jobId"],
            });
          }
          if (record.pinnedWinnerId !== record.expectedJob.pinnedWinnerId) {
            context.addIssue({
              code: "custom",
              message: "pinnedWinnerId must equal expectedJob.pinnedWinnerId",
              path: ["pinnedWinnerId"],
            });
          }
          if (record.enqueuedAt !== record.expectedJob.createdAt) {
            context.addIssue({
              code: "custom",
              message: "enqueuedAt must equal expectedJob.createdAt",
              path: ["enqueuedAt"],
            });
          }
        }),
    ),
    pendingComparison: z
      .object({
        selectedAt: z.string().min(1),
        roundNumber: z.number().int().positive(),
        winnerSide: z.enum(["left", "right"]),
        winnerId: z.string().min(1),
        loserId: z.string().min(1),
      })
      .strict()
      .nullable()
      .default(null),
    pendingSelectionBaseline: z
      .object({
        ready: z.array(bufferedCandidateSchema),
        ratings: z.array(candidateRatingSchema),
        generationTurnaroundEmaMs: z.number().finite().nonnegative(),
        consecutiveFallbackDraws: z.number().int().nonnegative(),
        nextFallbackAt: z.string().min(1).nullable(),
      })
      .strict()
      .nullable()
      .default(null),
    ratings: z.array(candidateRatingSchema),
    generationTurnaroundEmaMs: z.number().finite().nonnegative(),
    consecutiveFallbackDraws: z.number().int().nonnegative(),
    nextFallbackAt: z.string().min(1).nullable(),
  })
  .strict();

export function parseChallengerState(value: unknown): ChallengerState {
  return challengerStateSchema.parse(value);
}

const processLockTails = new Map<string, Promise<void>>();

async function withProcessLock<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  let release!: () => void;
  const previous = processLockTails.get(key) ?? Promise.resolve();
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  processLockTails.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (processLockTails.get(key) === current) processLockTails.delete(key);
  }
}

function resetSession(
  state: ChallengerState,
  sessionId: string,
): ChallengerState {
  return challengerStateSchema.parse({
    ...state,
    sessionId,
    ready: [],
    refillJobs: [],
    pendingComparison: null,
    pendingSelectionBaseline: null,
    consecutiveFallbackDraws: 0,
    nextFallbackAt: null,
  });
}

export class ChallengerRepositoryLockTimeoutError extends Error {}

export class JsonChallengerRepository implements ChallengerRepository {
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly retryDelayMs: number;
  private readonly processLockKey: string;

  constructor(
    private readonly filePath: string,
    options: RepositoryLockOptions = {},
  ) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.staleLockMs = options.staleLockMs ?? 30_000;
    this.retryDelayMs = options.retryDelayMs ?? 10;
    this.processLockKey = resolve(filePath);
  }

  async load(): Promise<ChallengerState | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      return challengerStateSchema.parse(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(state: ChallengerState): Promise<void> {
    const validated = challengerStateSchema.parse(state);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporaryPath, "wx");
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.filePath);
    } finally {
      await handle?.close();
      await rm(temporaryPath, { force: true });
    }
  }

  async clearSession(sessionId: string): Promise<void> {
    const state = await this.load();
    if (state) await this.save(resetSession(state, sessionId));
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    return withProcessLock(this.processLockKey, async () => {
      const token = crypto.randomUUID();
      await this.acquireFilesystemLock(token);
      try {
        return await operation();
      } finally {
        await this.releaseFilesystemLock(token);
      }
    });
  }

  private async acquireFilesystemLock(token: string): Promise<void> {
    const lockDirectory = `${this.filePath}.lock`;
    const deadline = Date.now() + this.lockTimeoutMs;
    await mkdir(dirname(this.filePath), { recursive: true });

    while (true) {
      try {
        await mkdir(lockDirectory);
        const owner: LockOwner = {
          pid: process.pid,
          token,
          acquiredAt: new Date().toISOString(),
        };
        await writeFile(
          join(lockDirectory, "owner.json"),
          `${JSON.stringify(owner)}\n`,
          "utf8",
        );
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      if (await this.lockIsStale(lockDirectory)) {
        const staleDirectory = `${lockDirectory}.stale.${token}`;
        try {
          await rename(lockDirectory, staleDirectory);
          await rm(staleDirectory, { recursive: true, force: true });
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }

      if (Date.now() >= deadline) {
        throw new ChallengerRepositoryLockTimeoutError(
          `Timed out waiting for repository lock ${lockDirectory}`,
        );
      }
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, this.retryDelayMs),
      );
    }
  }

  private async releaseFilesystemLock(token: string): Promise<void> {
    const lockDirectory = `${this.filePath}.lock`;
    try {
      const owner = JSON.parse(
        await readFile(join(lockDirectory, "owner.json"), "utf8"),
      ) as LockOwner;
      if (owner.token === token) {
        await rm(lockDirectory, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async lockIsStale(lockDirectory: string): Promise<boolean> {
    let acquiredAt: number;
    let pid: number | undefined;
    try {
      const owner = JSON.parse(
        await readFile(join(lockDirectory, "owner.json"), "utf8"),
      ) as Partial<LockOwner>;
      acquiredAt = Date.parse(owner.acquiredAt ?? "");
      pid = owner.pid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      try {
        acquiredAt = (await stat(lockDirectory)).mtimeMs;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }
        throw statError;
      }
    }

    if (!Number.isFinite(acquiredAt)) return false;
    if (Date.now() - acquiredAt < this.staleLockMs) return false;
    return pid === undefined || !this.processIsAlive(pid);
  }

  private processIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }
}

export class MemoryChallengerRepository implements ChallengerRepository {
  private lockTail: Promise<void> = Promise.resolve();
  private state: ChallengerState | null;

  constructor(state: ChallengerState | null = null) {
    this.state = state ? challengerStateSchema.parse(state) : null;
  }

  async load(): Promise<ChallengerState | null> {
    return this.state ? challengerStateSchema.parse(this.state) : null;
  }

  async save(state: ChallengerState): Promise<void> {
    this.state = challengerStateSchema.parse(state);
  }

  async clearSession(sessionId: string): Promise<void> {
    if (this.state) this.state = resetSession(this.state, sessionId);
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.lockTail;
    this.lockTail = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
