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
import {
  parseImportSession,
  type ImportSession,
} from "@/domain/import-session";

export interface ImportSessionRepository {
  load(): Promise<ImportSession | null>;
  save(session: ImportSession): Promise<void>;
  clear(): Promise<void>;
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

export class ImportSessionRepositoryLockTimeoutError extends Error {}

export class JsonImportSessionRepository implements ImportSessionRepository {
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

  async load(): Promise<ImportSession | null> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      return value === null ? null : parseImportSession(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(session: ImportSession): Promise<void> {
    const validated = parseImportSession(session);
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

  async clear(): Promise<void> {
    await this.writeAtomically("null\n");
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
        throw new ImportSessionRepositoryLockTimeoutError(
          `Timed out waiting for repository lock ${lockDirectory}`,
        );
      }
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, this.retryDelayMs),
      );
    }
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

export class MemoryImportSessionRepository implements ImportSessionRepository {
  private lockTail: Promise<void> = Promise.resolve();
  private session: ImportSession | null;

  constructor(session: ImportSession | null = null) {
    this.session = session ? parseImportSession(session) : null;
  }

  async load(): Promise<ImportSession | null> {
    return this.session ? parseImportSession(this.session) : null;
  }

  async save(session: ImportSession): Promise<void> {
    this.session = parseImportSession(session);
  }

  async clear(): Promise<void> {
    this.session = null;
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
