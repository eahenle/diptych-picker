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
import {
  preferenceProfileSchema,
  preferenceRevisionSchema,
} from "./preference-profile-schema";

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

const variationSourceSchema = z
  .object({
    candidateId: z.string().min(1),
    concept: z.string().min(1),
  })
  .strict();

const candidateLineageSchema = z
  .object({
    kind: z.literal("variation"),
    parentCandidateId: z.string().min(1),
    parentConcept: z.string().min(1),
    preferenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

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
    lineage: candidateLineageSchema.optional(),
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
    poolEligible: z.boolean().optional(),
    lastServedAt: z.string().min(1).nullable(),
    favorite: z.boolean().optional(),
  })
  .strict();

const selectionHistorySchema = z.union([
  z
    .object({
      outcome: z.literal("selection").optional(),
      winnerId: z.string().min(1),
      loserId: z.string().min(1),
      winnerPrompt: z.string().min(1),
      loserPrompt: z.string().min(1),
      winnerConcept: z.string().min(1),
      loserConcept: z.string().min(1),
      selectedAt: z.string().min(1),
    })
    .strict(),
  z
    .object({
      outcome: z.enum(["tie", "both-lose"]),
      leftId: z.string().min(1),
      rightId: z.string().min(1),
      leftPrompt: z.string().min(1),
      rightPrompt: z.string().min(1),
      leftConcept: z.string().min(1),
      rightConcept: z.string().min(1),
      selectedAt: z.string().min(1),
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
            candidateId: z.string().trim().min(1).max(200),
            concept: z.string().trim().min(1).max(240),
            style: z.array(z.string().trim().min(1).max(80)).max(4),
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
    sourceCandidateIds: z.array(z.string().min(1).max(200)).min(2).max(4),
    profile: preferenceRevisionSchema,
    reasoningSummary: z.string().trim().min(1).max(2_000),
    analyzedAt: z.string().min(1),
  })
  .strict();

const profileSourceImageSchema = z
  .object({
    filename: z.string().regex(/^[a-f0-9]{64}\.png$/),
    path: z.string().regex(/^profile-sources\/[a-f0-9]{64}\.png$/),
    contentType: z.literal("image/png"),
    width: z.number().int().positive().max(4096),
    height: z.number().int().positive().max(4096),
    byteLength: z.number().int().positive(),
  })
  .strict();

const leaderboardProfileJobSnapshotSchema = z
  .object({
    id: z.string().regex(GENERATION_JOB_ID_PATTERN),
    kind: z.literal("leaderboard-profile"),
    createdAt: z.string().min(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    sources: z
      .array(
        z
          .object({
            candidateId: z.string().trim().min(1).max(200),
            rank: z.number().int().positive(),
            rating: z.number().int(),
            wins: z.number().int().nonnegative(),
            losses: z.number().int().nonnegative(),
            favorite: z.boolean(),
            source: z.enum(["curated", "generated"]),
            concept: z.string().trim().min(1).max(240),
            style: z.array(z.string().trim().min(1).max(80)).max(4),
            sourceImage: profileSourceImageSchema,
          })
          .strict(),
      )
      .min(2)
      .max(4),
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
    leaderboardEvidence: leaderboardPreferenceEvidenceSchema.optional(),
    leaderboardVisualProfile: leaderboardVisualProfileSchema.optional(),
    preferenceSeed: z.string().min(1),
    preferenceProfile: preferenceProfileSchema.optional(),
    variationSource: variationSourceSchema.optional(),
    sessionId: z.string().regex(GENERATION_JOB_ID_PATTERN),
    pinnedWinnerId: z.string().min(1),
    comparisonOutcome: z.enum(["tie", "both-lose"]).optional(),
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
    leaderboardProfileJob: z
      .object({
        jobId: z.string().regex(GENERATION_JOB_ID_PATTERN),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        enqueuedAt: z.string().min(1),
        expectedJob: leaderboardProfileJobSnapshotSchema,
      })
      .strict()
      .superRefine((record, context) => {
        if (record.jobId !== record.expectedJob.id) {
          context.addIssue({
            code: "custom",
            path: ["jobId"],
            message: "jobId must equal expectedJob.id",
          });
        }
        if (record.fingerprint !== record.expectedJob.fingerprint) {
          context.addIssue({
            code: "custom",
            path: ["fingerprint"],
            message: "fingerprint must equal expectedJob.fingerprint",
          });
        }
        if (record.enqueuedAt !== record.expectedJob.createdAt) {
          context.addIssue({
            code: "custom",
            path: ["enqueuedAt"],
            message: "enqueuedAt must equal expectedJob.createdAt",
          });
        }
      })
      .nullable()
      .default(null),
    leaderboardVisualProfile: leaderboardVisualProfileSchema
      .nullable()
      .default(null),
    leaderboardProfileAttemptedFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .default(null),
    pendingComparison: z
      .union([
        z
          .object({
            kind: z.literal("selection").optional(),
            selectedAt: z.string().min(1),
            roundNumber: z.number().int().positive(),
            winnerSide: z.enum(["left", "right"]),
            winnerId: z.string().min(1),
            loserId: z.string().min(1),
          })
          .strict(),
        z
          .object({
            kind: z.enum(["tie", "both-lose"]),
            selectedAt: z.string().min(1),
            roundNumber: z.number().int().positive(),
            leftId: z.string().min(1),
            rightId: z.string().min(1),
          })
          .strict(),
      ])
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
    leaderboardProfileJob: null,
    leaderboardVisualProfile: null,
    leaderboardProfileAttemptedFingerprint: null,
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
