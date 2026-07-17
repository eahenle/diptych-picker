import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
}

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
  constructor(private readonly filePath: string) {}

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
}

export class MemoryInitialBootstrapRepository implements InitialBootstrapRepository {
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
}
