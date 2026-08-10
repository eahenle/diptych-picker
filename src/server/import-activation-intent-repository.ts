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
import type { GameState } from "@/domain/game";
import {
  parseImportSession,
  type ImportSession,
} from "@/domain/import-session";
import { z } from "zod";
import { parseChallengerState } from "./challenger-repository";
import type { InitialBootstrap } from "./initial-bootstrap";
import { parseGameState } from "./repository";

export type ImportActivationPhase =
  "prepared" | "writing" | "committed" | "cleaned";
export type ImportActivationOutcome = "undecided" | "commit" | "rollback";

export interface ImportActivationIntent {
  id: string;
  expectedOld: {
    importSessionId: string;
    gameRevisionId: string | null;
    challengerSessionId: string | null;
    bootstrapBatchId: string | null;
  };
  next: {
    game: GameState;
    challengers: ChallengerState;
    bootstrap: InitialBootstrap | null;
    importSession: ImportSession;
  };
  supersededJobIds: string[];
  archivedSupersededJobIds: string[];
  phase: ImportActivationPhase;
  outcome: ImportActivationOutcome;
  preparedAt: string;
  committedAt: string | null;
  cleanedAt: string | null;
}

export interface ImportActivationIntentRepository {
  load(): Promise<ImportActivationIntent | null>;
  save(intent: ImportActivationIntent): Promise<void>;
  clear(expectedIntentId: string): Promise<void>;
  withLock<T>(operation: () => Promise<T>): Promise<T>;
}

interface RepositoryLockOptions {
  lockTimeoutMs?: number;
  staleLockMs?: number;
  retryDelayMs?: number;
  renameFile?: typeof rename;
}

interface LockOwner {
  pid: number;
  token: string;
  acquiredAt: string;
}

const nonBlank = z.string().trim().min(1);
const timestampSchema = z.string().datetime({ offset: true });
const bootstrapSchema: z.ZodType<InitialBootstrap> = z
  .object({
    batchId: nonBlank,
    createdAt: timestampSchema,
    preferenceSeed: nonBlank,
    jobs: z.tuple([
      z.object({ id: nonBlank, side: z.literal("left") }).strict(),
      z.object({ id: nonBlank, side: z.literal("right") }).strict(),
    ]),
  })
  .strict();

const intentEnvelopeSchema = z
  .object({
    id: nonBlank,
    expectedOld: z
      .object({
        importSessionId: nonBlank,
        gameRevisionId: nonBlank.nullable(),
        challengerSessionId: nonBlank.nullable(),
        bootstrapBatchId: nonBlank.nullable(),
      })
      .strict(),
    next: z
      .object({
        game: z.unknown(),
        challengers: z.unknown(),
        bootstrap: bootstrapSchema.nullable(),
        importSession: z.unknown(),
      })
      .strict(),
    supersededJobIds: z.array(nonBlank),
    archivedSupersededJobIds: z.array(nonBlank),
    phase: z.enum(["prepared", "writing", "committed", "cleaned"]),
    outcome: z.enum(["undecided", "commit", "rollback"]),
    preparedAt: timestampSchema,
    committedAt: timestampSchema.nullable(),
    cleanedAt: timestampSchema.nullable(),
  })
  .strict()
  .superRefine((intent, context) => {
    const superseded = new Set(intent.supersededJobIds);
    if (superseded.size !== intent.supersededJobIds.length) {
      context.addIssue({
        code: "custom",
        path: ["supersededJobIds"],
        message: "Superseded job IDs must be unique",
      });
    }
    const archived = new Set(intent.archivedSupersededJobIds);
    if (archived.size !== intent.archivedSupersededJobIds.length) {
      context.addIssue({
        code: "custom",
        path: ["archivedSupersededJobIds"],
        message: "Archived superseded job IDs must be unique",
      });
    }
    if (intent.archivedSupersededJobIds.some((id) => !superseded.has(id))) {
      context.addIssue({
        code: "custom",
        path: ["archivedSupersededJobIds"],
        message: "Archived job IDs must belong to superseded jobs",
      });
    }
    if (
      intent.phase === "prepared" &&
      (intent.outcome !== "undecided" ||
        intent.committedAt !== null ||
        intent.cleanedAt !== null ||
        intent.archivedSupersededJobIds.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["phase"],
        message:
          "Prepared intents cannot contain commit, cleanup, or archive evidence",
      });
    }
    if (
      intent.phase === "writing" &&
      (intent.outcome !== "commit" ||
        intent.committedAt !== null ||
        intent.cleanedAt !== null ||
        intent.archivedSupersededJobIds.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["phase"],
        message:
          "Writing intents cannot contain commit, cleanup, or archive evidence",
      });
    }
    if (intent.outcome === "rollback") {
      if (
        intent.phase !== "cleaned" ||
        intent.committedAt ||
        !intent.cleanedAt ||
        intent.archivedSupersededJobIds.length > 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["outcome"],
          message: "Rollback intents cannot contain commit or archive evidence",
        });
      }
    }
    if (intent.phase === "cleaned" && intent.outcome === "commit") {
      if (
        intent.committedAt === null ||
        intent.cleanedAt === null ||
        intent.archivedSupersededJobIds.length !==
          intent.supersededJobIds.length
      ) {
        context.addIssue({
          code: "custom",
          path: ["archivedSupersededJobIds"],
          message: "Cleaned commit intents must archive every superseded job",
        });
      }
    }
    if (
      intent.phase === "committed" &&
      (intent.outcome !== "commit" ||
        intent.committedAt === null ||
        intent.cleanedAt !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["phase"],
        message: "Committed intents require a commit outcome and timestamp",
      });
    }
  });

export function parseImportActivationIntent(
  value: unknown,
): ImportActivationIntent {
  const parsed = intentEnvelopeSchema.parse(value);
  const importSession = parseImportSession(parsed.next.importSession);
  const challengers = parseChallengerState(parsed.next.challengers);
  const game = parseGameState(parsed.next.game);
  if (importSession.id !== parsed.expectedOld.importSessionId) {
    throw new Error(
      "Expected import session must match the intended import session",
    );
  }
  for (const receipt of importSession.servedReceipts) {
    if (
      receipt.kind === "activation-display" &&
      receipt.activationIntentId !== parsed.id
    ) {
      throw new Error(
        "Activation-display receipt must reference its activation intent",
      );
    }
  }
  return {
    ...parsed,
    next: {
      ...parsed.next,
      game,
      challengers,
      importSession,
    },
  };
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

export class ImportActivationIntentRepositoryLockTimeoutError extends Error {}

export class JsonImportActivationIntentRepository implements ImportActivationIntentRepository {
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly retryDelayMs: number;
  private readonly processLockKey: string;
  private readonly renameFile: typeof rename;

  constructor(
    private readonly filePath: string,
    options: RepositoryLockOptions = {},
  ) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.staleLockMs = options.staleLockMs ?? 30_000;
    this.retryDelayMs = options.retryDelayMs ?? 10;
    this.renameFile = options.renameFile ?? rename;
    this.processLockKey = resolve(filePath);
  }

  async load(): Promise<ImportActivationIntent | null> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      return value === null ? null : parseImportActivationIntent(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(intent: ImportActivationIntent): Promise<void> {
    const validated = parseImportActivationIntent(intent);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporaryPath, "wx");
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.renameFile(temporaryPath, this.filePath);
    } finally {
      await handle?.close();
      await rm(temporaryPath, { force: true });
    }
  }

  async clear(expectedIntentId: string): Promise<void> {
    const current = await this.load();
    if (current && current.id !== expectedIntentId) {
      throw new Error(
        `Expected activation intent ${expectedIntentId}, found ${current.id}`,
      );
    }
    if (current) await this.writeNull();
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

  private async writeNull(): Promise<void> {
    await this.writeAtomically("null\n");
  }

  private async writeAtomically(contents: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporaryPath, "wx");
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.renameFile(temporaryPath, this.filePath);
    } finally {
      await handle?.close();
      await rm(temporaryPath, { force: true });
    }
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
        throw new ImportActivationIntentRepositoryLockTimeoutError(
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
      if (owner.token === token)
        await rm(lockDirectory, { recursive: true, force: true });
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
        if ((statError as NodeJS.ErrnoException).code === "ENOENT")
          return false;
        throw statError;
      }
    }
    if (
      !Number.isFinite(acquiredAt) ||
      Date.now() - acquiredAt < this.staleLockMs
    )
      return false;
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
