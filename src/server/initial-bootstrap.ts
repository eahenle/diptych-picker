import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { GENERATION_JOB_ID_PATTERN, type Side } from "@/domain/game";
import { z } from "zod";

export interface InitialBootstrapJob {
  id: string;
  side: Side;
}

export interface InitialBootstrap {
  batchId: string;
  createdAt: string;
  preferenceSeed: string;
  jobs: [
    InitialBootstrapJob & { side: "left" },
    InitialBootstrapJob & { side: "right" },
  ];
}

export interface InitialBootstrapRepository {
  load(): Promise<InitialBootstrap | null>;
  save(bootstrap: InitialBootstrap): Promise<void>;
  clear(): Promise<void>;
  withLock<T>(operation: () => Promise<T>): Promise<T>;
}

interface InitialBootstrapRepositoryOptions {
  lockTimeoutMs?: number;
  staleLockMs?: number;
  retryDelayMs?: number;
}

interface LockOwner {
  pid: number;
  token: string;
  acquiredAt: string;
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

export class InitialBootstrapRepositoryLockTimeoutError extends Error {}

const idSchema = z.string().regex(GENERATION_JOB_ID_PATTERN);
const bootstrapSchema = z
  .object({
    batchId: idSchema,
    createdAt: z.string().datetime({ offset: true }),
    preferenceSeed: z.string().trim().min(1),
    jobs: z.tuple([
      z.object({ id: idSchema, side: z.literal("left") }).strict(),
      z.object({ id: idSchema, side: z.literal("right") }).strict(),
    ]),
  })
  .strict();

export class JsonInitialBootstrapRepository implements InitialBootstrapRepository {
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly retryDelayMs: number;
  private readonly processLockKey: string;

  constructor(
    private readonly filePath: string,
    options: InitialBootstrapRepositoryOptions = {},
  ) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.staleLockMs = options.staleLockMs ?? 30_000;
    this.retryDelayMs = options.retryDelayMs ?? 10;
    this.processLockKey = resolve(filePath);
  }

  async load(): Promise<InitialBootstrap | null> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      if (parsed === null) return null;
      return bootstrapSchema.parse(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(bootstrap: InitialBootstrap): Promise<void> {
    const validated = bootstrapSchema.parse(bootstrap);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(validated, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, this.filePath);
  }

  async clear(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, "null\n", "utf8");
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
        throw new InitialBootstrapRepositoryLockTimeoutError(
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
    if (pid === undefined) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "EPERM";
    }
  }
}

export class MemoryInitialBootstrapRepository implements InitialBootstrapRepository {
  private lockTail: Promise<void> = Promise.resolve();
  constructor(private bootstrap: InitialBootstrap | null = null) {}

  async load(): Promise<InitialBootstrap | null> {
    return this.bootstrap;
  }

  async save(bootstrap: InitialBootstrap): Promise<void> {
    this.bootstrap = bootstrap;
  }

  async clear(): Promise<void> {
    this.bootstrap = null;
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
