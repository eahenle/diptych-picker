import { constants } from "node:fs";
import { lstat, open, readFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
const coProcControlFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      version: z.literal(1),
      type: z.literal("ready"),
      id: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal("busy"),
      id: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal("ack"),
      id: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal("result"),
      id: z.string().trim().min(1),
    })
    .passthrough(),
  z
    .object({
      version: z.literal(1),
      type: z.literal("error"),
      id: z.string().trim().min(1),
      message: z.string().trim().min(1),
    })
    .strict(),
]);
type CoProcControlFrame = z.infer<typeof coProcControlFrameSchema>;

export interface GenerationTransport {
  notify(job: GenerationJob, durableJobPath: string): Promise<void>;
}

export interface GenerationChannelTransport extends GenerationTransport {
  readonly channel: string;
}

interface CoProcGenerationTransportOptions {
  channel: string;
  runtimeRoot?: string;
  maximumFrameBytes?: number;
  readyTimeoutMs?: number;
  acknowledgementTimeoutMs?: number;
}

export class CoProcChannelUnavailableError extends Error {
  constructor(
    readonly channel: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`Co-proc channel ${channel} is unavailable: ${message}`, options);
    this.name = "CoProcChannelUnavailableError";
  }
}

export class CoProcDeliveryUnconfirmedError extends Error {
  constructor(
    readonly channel: string,
    readonly jobId: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(
      `Co-proc channel ${channel} did not confirm job ${jobId}: ${message}`,
      options,
    );
    this.name = "CoProcDeliveryUnconfirmedError";
  }
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

export class CoProcGenerationTransport implements GenerationChannelTransport {
  readonly channel: string;
  private readonly runtimeRoot: string;
  private readonly maximumFrameBytes: number;
  private readonly readyTimeoutMs: number;
  private readonly acknowledgementTimeoutMs: number;
  private outputBuffer = "";
  private serializedNotification: Promise<void> = Promise.resolve();

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
    for (const [name, value] of [
      ["readyTimeoutMs", options.readyTimeoutMs],
      ["acknowledgementTimeoutMs", options.acknowledgementTimeoutMs],
    ] as const) {
      if (
        value !== undefined &&
        (!Number.isInteger(value) || value < 1 || value > 30_000)
      ) {
        throw new Error(`${name} must be an integer from 1 through 30000`);
      }
    }
    this.channel = options.channel;
    this.runtimeRoot = resolve(
      /* turbopackIgnore: true */ options.runtimeRoot ??
        defaultCoProcRuntimeRoot(),
    );
    this.maximumFrameBytes = options.maximumFrameBytes ?? 4095;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 100;
    this.acknowledgementTimeoutMs = options.acknowledgementTimeoutMs ?? 500;
  }

  async notify(job: GenerationJob, durableJobPath: string): Promise<void> {
    let release!: () => void;
    const previousNotification = this.serializedNotification;
    this.serializedNotification = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previousNotification;
    try {
      await this.notifyExclusively(job, durableJobPath);
    } finally {
      release();
    }
  }

  private async notifyExclusively(
    job: GenerationJob,
    durableJobPath: string,
  ): Promise<void> {
    const validatedJob = generationJobSchema.parse(job);
    const resolvedJobPath = resolve(/* turbopackIgnore: true */ durableJobPath);
    if (!isAbsolute(durableJobPath) || resolvedJobPath !== durableJobPath) {
      throw new Error("Co-proc job paths must be absolute and normalized");
    }

    const channelDirectory = join(this.runtimeRoot, this.channel);
    const metadataPath = join(channelDirectory, "metadata.json");
    const inputPath = join(channelDirectory, "input");
    const outputPath = join(channelDirectory, "output");
    try {
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
      process.kill(metadata.pid, 0);
    } catch (error) {
      throw new CoProcChannelUnavailableError(
        this.channel,
        error instanceof Error ? error.message : "endpoint validation failed",
        { cause: error },
      );
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

    const output = await open(
      outputPath,
      constants.O_RDONLY | constants.O_NONBLOCK,
    ).catch((error: unknown) => {
      throw new CoProcChannelUnavailableError(
        this.channel,
        "cannot open worker output",
        { cause: error },
      );
    });
    try {
      await this.waitUntilReady(output);
      const input = await open(
        inputPath,
        constants.O_WRONLY | constants.O_NONBLOCK,
      ).catch((error: unknown) => {
        throw new CoProcChannelUnavailableError(
          this.channel,
          "cannot open worker input",
          { cause: error },
        );
      });
      try {
        const encodedFrame = Buffer.from(frame, "utf8");
        const { bytesWritten } = await input.write(
          encodedFrame,
          0,
          encodedFrame.length,
          null,
        );
        if (bytesWritten !== encodedFrame.length) {
          throw new Error(
            `wrote ${bytesWritten} of ${encodedFrame.length} bytes`,
          );
        }
      } catch (error) {
        throw new CoProcChannelUnavailableError(
          this.channel,
          "generation frame could not be written atomically",
          { cause: error },
        );
      } finally {
        await input.close();
      }
      await this.waitForAcknowledgement(output, validatedJob.id);
    } finally {
      await output.close();
    }
  }

  private async waitUntilReady(output: FileHandle): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    try {
      while (Date.now() < deadline) {
        const control = await this.readControlFrame(output, deadline);
        if (control.type === "ready") {
          return;
        }
        if (control.type === "busy") {
          throw new Error("worker reported busy");
        }
        if (control.type === "error") {
          throw new Error(control.message);
        }
      }
      throw new Error("readiness timed out");
    } catch (error) {
      if (error instanceof CoProcChannelUnavailableError) {
        throw error;
      }
      throw new CoProcChannelUnavailableError(
        this.channel,
        error instanceof Error ? error.message : "readiness failed",
        { cause: error },
      );
    }
  }

  private async waitForAcknowledgement(
    output: FileHandle,
    jobId: string,
  ): Promise<void> {
    const deadline = Date.now() + this.acknowledgementTimeoutMs;
    try {
      while (Date.now() < deadline) {
        const control = await this.readControlFrame(output, deadline);
        if (control.type === "ack" && control.id === jobId) {
          return;
        }
        if (
          (control.type === "busy" || control.type === "error") &&
          control.id === jobId
        ) {
          throw new Error(
            control.type === "error"
              ? control.message
              : "worker reported busy after dispatch",
          );
        }
      }
      throw new Error("acknowledgement timed out");
    } catch (error) {
      throw new CoProcDeliveryUnconfirmedError(
        this.channel,
        jobId,
        error instanceof Error ? error.message : "acknowledgement failed",
        { cause: error },
      );
    }
  }

  private async readControlFrame(
    output: FileHandle,
    deadline: number,
  ): Promise<CoProcControlFrame> {
    const buffer = Buffer.alloc(this.maximumFrameBytes + 2);
    while (Date.now() < deadline) {
      const newlineIndex = this.outputBuffer.indexOf("\n");
      if (newlineIndex >= 0) {
        const line = this.outputBuffer.slice(0, newlineIndex);
        this.outputBuffer = this.outputBuffer.slice(newlineIndex + 1);
        if (Buffer.byteLength(line, "utf8") > this.maximumFrameBytes) {
          throw new Error(
            `worker frame exceeds ${this.maximumFrameBytes} bytes`,
          );
        }
        return coProcControlFrameSchema.parse(JSON.parse(line));
      }

      try {
        const { bytesRead } = await output.read(buffer, 0, buffer.length, null);
        if (bytesRead > 0) {
          this.outputBuffer += buffer.subarray(0, bytesRead).toString("utf8");
          if (
            !this.outputBuffer.includes("\n") &&
            Buffer.byteLength(this.outputBuffer, "utf8") >
              this.maximumFrameBytes
          ) {
            throw new Error(
              `worker frame exceeds ${this.maximumFrameBytes} bytes`,
            );
          }
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EAGAIN") {
          throw error;
        }
      }
      await delay(Math.min(5, Math.max(1, deadline - Date.now())));
    }
    throw new Error("control frame timed out");
  }
}

export class CoProcGenerationChannelPool implements GenerationTransport {
  private readonly channels: readonly GenerationChannelTransport[];
  private readonly inUse = new Set<string>();
  private nextIndex = 0;

  constructor(channels: readonly GenerationChannelTransport[]) {
    if (channels.length === 0) {
      throw new Error("At least one co-proc generation channel is required");
    }
    if (channels.length > 3) {
      throw new Error("At most three co-proc generation channels are allowed");
    }
    const names = new Set<string>();
    for (const channel of channels) {
      if (names.has(channel.channel)) {
        throw new Error(`Duplicate co-proc channel: ${channel.channel}`);
      }
      names.add(channel.channel);
    }
    this.channels = [...channels];
  }

  async notify(job: GenerationJob, durableJobPath: string): Promise<void> {
    let lastUnavailable: CoProcChannelUnavailableError | undefined;
    const startIndex = this.nextIndex;
    for (let offset = 0; offset < this.channels.length; offset += 1) {
      const index = (startIndex + offset) % this.channels.length;
      const channel = this.channels[index];
      if (this.inUse.has(channel.channel)) {
        continue;
      }
      this.inUse.add(channel.channel);
      this.nextIndex = (index + 1) % this.channels.length;
      try {
        await channel.notify(job, durableJobPath);
        return;
      } catch (error) {
        if (!(error instanceof CoProcChannelUnavailableError)) {
          throw error;
        }
        lastUnavailable = error;
      } finally {
        this.inUse.delete(channel.channel);
      }
    }
    throw (
      lastUnavailable ??
      new CoProcChannelUnavailableError(
        "pool",
        "every configured worker is already dispatching",
      )
    );
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
