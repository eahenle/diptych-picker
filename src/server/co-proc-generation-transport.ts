import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  generationJobSchema,
  type GenerationJob,
  type GenerationMailbox,
  type GenerationResult,
} from "./agent-mailbox";

const channelNamePattern = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const coProcMetadataSchema = z
  .object({
    version: z.literal(1),
    name: z.string().regex(channelNamePattern),
    pid: z.number().int().positive(),
    owner_uid: z.number().int().nonnegative(),
    started: z.number().int().nonnegative(),
    input: z.string().min(1),
    output: z.string().min(1),
  })
  .strict();

export interface GenerationTransport {
  notify(job: GenerationJob, durableJobPath: string): Promise<void>;
}

interface CoProcGenerationTransportOptions {
  channel: string;
  runtimeRoot?: string;
  maximumFrameBytes?: number;
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("Attachable co-proc transport requires a POSIX user ID");
  }
  return uid;
}

export function defaultCoProcRuntimeRoot(): string {
  return join(tmpdir(), `co-proc-${currentUid()}`);
}

async function assertOwnedPath(
  path: string,
  expectedMode: number,
  expectedKind: "directory" | "file" | "fifo",
): Promise<void> {
  const stats = await lstat(/* turbopackIgnore: true */ path);
  if (stats.isSymbolicLink()) {
    throw new Error(`Unsafe co-proc symlink: ${path}`);
  }
  const kindMatches =
    expectedKind === "directory"
      ? stats.isDirectory()
      : expectedKind === "file"
        ? stats.isFile()
        : stats.isFIFO();
  if (!kindMatches) {
    throw new Error(`Co-proc ${expectedKind} expected at ${path}`);
  }
  if (stats.uid !== currentUid() || (stats.mode & 0o777) !== expectedMode) {
    throw new Error(
      `Unsafe co-proc ownership or permissions at ${path}; expected uid ${currentUid()} mode ${expectedMode.toString(8)}`,
    );
  }
}

export class CoProcGenerationTransport implements GenerationTransport {
  private readonly channel: string;
  private readonly runtimeRoot: string;
  private readonly maximumFrameBytes: number;

  constructor(options: CoProcGenerationTransportOptions) {
    if (!channelNamePattern.test(options.channel)) {
      throw new Error(`Invalid co-proc channel name: ${options.channel}`);
    }
    if (
      options.maximumFrameBytes !== undefined &&
      (!Number.isInteger(options.maximumFrameBytes) ||
        options.maximumFrameBytes < 1)
    ) {
      throw new Error("maximumFrameBytes must be a positive integer");
    }
    this.channel = options.channel;
    this.runtimeRoot = resolve(
      /* turbopackIgnore: true */ options.runtimeRoot ??
        defaultCoProcRuntimeRoot(),
    );
    this.maximumFrameBytes = options.maximumFrameBytes ?? 4095;
  }

  async notify(job: GenerationJob, durableJobPath: string): Promise<void> {
    const validatedJob = generationJobSchema.parse(job);
    const resolvedJobPath = resolve(/* turbopackIgnore: true */ durableJobPath);
    if (!isAbsolute(durableJobPath) || resolvedJobPath !== durableJobPath) {
      throw new Error("Co-proc job paths must be absolute and normalized");
    }

    const channelDirectory = join(this.runtimeRoot, this.channel);
    const metadataPath = join(channelDirectory, "metadata.json");
    const inputPath = join(channelDirectory, "input");
    const outputPath = join(channelDirectory, "output");
    await assertOwnedPath(this.runtimeRoot, 0o700, "directory");
    await assertOwnedPath(channelDirectory, 0o700, "directory");
    await assertOwnedPath(metadataPath, 0o600, "file");
    await assertOwnedPath(inputPath, 0o600, "fifo");
    await assertOwnedPath(outputPath, 0o600, "fifo");

    const metadata = coProcMetadataSchema.parse(
      JSON.parse(
        await readFile(/* turbopackIgnore: true */ metadataPath, "utf8"),
      ),
    );
    if (
      metadata.name !== this.channel ||
      metadata.owner_uid !== currentUid() ||
      resolve(/* turbopackIgnore: true */ metadata.input) !== inputPath ||
      resolve(/* turbopackIgnore: true */ metadata.output) !== outputPath
    ) {
      throw new Error(
        `Co-proc metadata does not match channel ${this.channel}`,
      );
    }
    try {
      process.kill(metadata.pid, 0);
    } catch {
      throw new Error(`Co-proc channel ${this.channel} is not running`);
    }

    const frame = `${JSON.stringify({
      version: 1,
      type: "gen",
      id: validatedJob.id,
      kind: validatedJob.kind,
      job_path: resolvedJobPath,
    })}\n`;
    if (Buffer.byteLength(frame, "utf8") > this.maximumFrameBytes + 1) {
      throw new Error(`Co-proc frame exceeds ${this.maximumFrameBytes} bytes`);
    }

    const input = await open(
      inputPath,
      constants.O_WRONLY | constants.O_NONBLOCK,
    );
    try {
      await input.writeFile(frame, "utf8");
    } finally {
      await input.close();
    }
  }
}

interface TransportNotifyingMailboxOptions {
  durableJobPath(job: GenerationJob): string;
  onTransportError?: (error: unknown, job: GenerationJob) => void;
}

export class TransportNotifyingGenerationMailbox implements GenerationMailbox {
  constructor(
    private readonly durableMailbox: GenerationMailbox,
    private readonly transport: GenerationTransport,
    private readonly options: TransportNotifyingMailboxOptions,
  ) {}

  async enqueue(job: GenerationJob): Promise<void> {
    const validatedJob = generationJobSchema.parse(job);
    await this.durableMailbox.enqueue(validatedJob);
    try {
      await this.transport.notify(
        validatedJob,
        this.options.durableJobPath(validatedJob),
      );
    } catch (error) {
      this.options.onTransportError?.(error, validatedJob);
    }
  }

  readPending(jobId: string): Promise<GenerationJob | null> {
    return this.durableMailbox.readPending(jobId);
  }

  readWork(jobId: string): Promise<GenerationJob | null> {
    return this.durableMailbox.readWork(jobId);
  }

  readResult(jobId: string): Promise<GenerationResult | null> {
    return this.durableMailbox.readResult(jobId);
  }

  archive(jobId: string): Promise<void> {
    return this.durableMailbox.archive(jobId);
  }
}
