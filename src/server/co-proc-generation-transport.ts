import { constants } from "node:fs";
import { lstat, open, readFile, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
const leaseTokenSchema = z.string().uuid();
const timestampSchema = z.string().datetime({ offset: true });
const coProcLeaseSchema = z
  .object({
    version: z.literal(1),
    jobId: z.string().trim().min(1),
    channel: z.string().regex(channelNamePattern),
    token: leaseTokenSchema,
    claimedAt: timestampSchema,
    renewedAt: timestampSchema,
    expiresAt: timestampSchema,
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
      version: z.literal(2),
      type: z.literal("ack"),
      id: z.string().trim().min(1),
      lease_token: leaseTokenSchema,
      lease_expires_at: timestampSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(2),
      type: z.literal("result"),
      id: z.string().trim().min(1),
      lease_token: leaseTokenSchema,
      status: z.enum(["completed", "failed"]),
      result_path: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      version: z.union([z.literal(1), z.literal(2)]),
      type: z.literal("error"),
      id: z.string().trim().min(1),
      message: z.string().trim().min(1),
    })
    .strict(),
]);
type CoProcControlFrame = z.infer<typeof coProcControlFrameSchema>;

export interface GenerationTerminalSignal {
  channel: string;
  jobId: string;
  status: "completed" | "failed";
  resultPath: string;
}

export interface GenerationTransport {
  notify(job: GenerationJob, durableJobPath: string): Promise<void>;
  subscribeTerminalSignals?(
    listener: (signal: GenerationTerminalSignal) => void,
    onError?: (error: unknown) => void,
  ): () => void;
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
  leaseDurationMs?: number;
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
  private readonly leaseDurationMs: number;
  private outputBuffer = "";
  private serializedNotification: Promise<void> = Promise.resolve();
  private terminalObserver: Promise<void> | null = null;
  private readonly terminalListeners = new Set<
    (signal: GenerationTerminalSignal) => void
  >();
  private readonly terminalErrorListeners = new Set<(error: unknown) => void>();

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
    if (
      options.leaseDurationMs !== undefined &&
      (!Number.isInteger(options.leaseDurationMs) ||
        options.leaseDurationMs < 10_000 ||
        options.leaseDurationMs > 600_000)
    ) {
      throw new Error(
        "leaseDurationMs must be an integer from 10000 through 600000",
      );
    }
    this.channel = options.channel;
    this.runtimeRoot = resolve(
      /* turbopackIgnore: true */ options.runtimeRoot ??
        defaultCoProcRuntimeRoot(),
    );
    this.maximumFrameBytes = options.maximumFrameBytes ?? 4095;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 100;
    this.acknowledgementTimeoutMs = options.acknowledgementTimeoutMs ?? 500;
    this.leaseDurationMs = options.leaseDurationMs ?? 120_000;
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

  subscribeTerminalSignals(
    listener: (signal: GenerationTerminalSignal) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    this.terminalListeners.add(listener);
    if (onError) this.terminalErrorListeners.add(onError);
    return () => {
      this.terminalListeners.delete(listener);
      if (onError) this.terminalErrorListeners.delete(onError);
    };
  }

  private async notifyExclusively(
    job: GenerationJob,
    durableJobPath: string,
  ): Promise<void> {
    if (this.terminalObserver) {
      throw new CoProcChannelUnavailableError(
        this.channel,
        "worker is still processing an acknowledged job",
      );
    }
    const validatedJob = generationJobSchema.parse(job);
    const resolvedJobPath = resolve(/* turbopackIgnore: true */ durableJobPath);
    if (!isAbsolute(durableJobPath) || resolvedJobPath !== durableJobPath) {
      throw new Error("Co-proc job paths must be absolute and normalized");
    }
    if (
      basename(dirname(resolvedJobPath)) !== "pending" ||
      basename(resolvedJobPath) !== `${validatedJob.id}.json`
    ) {
      throw new Error(
        "Co-proc job paths must identify the matching pending mailbox job",
      );
    }
    const mailboxDirectory = dirname(dirname(resolvedJobPath));
    const leasePath = join(
      mailboxDirectory,
      "leases",
      `${validatedJob.id}.json`,
    );
    const leaseToken = randomUUID();

    const channelDirectory = join(this.runtimeRoot, this.channel);
    const metadataPath = join(channelDirectory, "metadata.json");
    const inputPath = join(channelDirectory, "input");
    const outputPath = join(channelDirectory, "output");
    let outputOwnedByObserver = false;
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
      version: 2,
      type: "gen",
      id: validatedJob.id,
      kind: validatedJob.kind,
      job_path: resolvedJobPath,
      lease_path: leasePath,
      lease_token: leaseToken,
      lease_duration_ms: this.leaseDurationMs,
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
      const acknowledgement = await this.waitForAcknowledgement(
        output,
        validatedJob.id,
        leaseToken,
      );
      await this.verifyDurableLease(
        leasePath,
        validatedJob.id,
        leaseToken,
        acknowledgement.lease_expires_at,
      );
      outputOwnedByObserver = true;
      const observer = this.observeTerminalResult(
        output,
        mailboxDirectory,
        leasePath,
        validatedJob.id,
        leaseToken,
        acknowledgement.lease_expires_at,
      );
      const trackedObserver = observer
        .catch((error: unknown) => {
          for (const listener of this.terminalErrorListeners) listener(error);
        })
        .finally(async () => {
          await output.close();
          if (this.terminalObserver === trackedObserver) {
            this.terminalObserver = null;
          }
        });
      this.terminalObserver = trackedObserver;
    } finally {
      if (!outputOwnedByObserver) await output.close();
    }
  }

  private async observeTerminalResult(
    output: FileHandle,
    mailboxDirectory: string,
    leasePath: string,
    jobId: string,
    leaseToken: string,
    initialExpiry: string,
  ): Promise<void> {
    let leaseExpiry = initialExpiry;
    while (true) {
      const deadline = Math.min(Date.parse(leaseExpiry), Date.now() + 30_000);
      let control: CoProcControlFrame;
      try {
        control = await this.readControlFrame(output, deadline);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "control frame timed out"
        ) {
          throw error;
        }
        const lease = await this.readDurableLease(leasePath).catch(() => null);
        if (
          lease?.jobId === jobId &&
          lease.channel === this.channel &&
          lease.token === leaseToken &&
          Date.parse(lease.expiresAt) > Date.now()
        ) {
          leaseExpiry = lease.expiresAt;
          continue;
        }
        return;
      }

      if (control.type === "result") {
        if (control.id !== jobId || control.lease_token !== leaseToken) {
          throw new Error(
            `Co-proc channel ${this.channel} returned a result for another lease`,
          );
        }
        const resultPath = resolve(
          /* turbopackIgnore: true */ control.result_path,
        );
        const expectedPath = join(
          mailboxDirectory,
          control.status,
          `${jobId}.json`,
        );
        if (
          !isAbsolute(control.result_path) ||
          resultPath !== control.result_path ||
          resultPath !== expectedPath
        ) {
          throw new Error(
            `Co-proc channel ${this.channel} returned an invalid terminal result path`,
          );
        }
        const signal: GenerationTerminalSignal = {
          channel: this.channel,
          jobId,
          status: control.status,
          resultPath,
        };
        for (const listener of this.terminalListeners) listener(signal);
        return;
      }
      if (control.type === "error" && control.id === jobId) {
        throw new Error(
          `Co-proc channel ${this.channel} failed job ${jobId}: ${control.message}`,
        );
      }
    }
  }

  private async readDurableLease(leasePath: string) {
    await assertOwnedPath(leasePath, 0o600, "file");
    return coProcLeaseSchema.parse(
      JSON.parse(await readFile(/* turbopackIgnore: true */ leasePath, "utf8")),
    );
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
    leaseToken: string,
  ): Promise<Extract<CoProcControlFrame, { type: "ack" }>> {
    const deadline = Date.now() + this.acknowledgementTimeoutMs;
    try {
      while (Date.now() < deadline) {
        const control = await this.readControlFrame(output, deadline);
        if (control.type === "ack" && control.id === jobId) {
          if (control.lease_token !== leaseToken) {
            throw new Error("acknowledgement used another lease token");
          }
          return control;
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

  private async verifyDurableLease(
    leasePath: string,
    jobId: string,
    leaseToken: string,
    acknowledgedExpiry: string,
  ): Promise<void> {
    try {
      await assertOwnedPath(leasePath, 0o600, "file");
      const lease = coProcLeaseSchema.parse(
        JSON.parse(
          await readFile(/* turbopackIgnore: true */ leasePath, "utf8"),
        ),
      );
      if (
        lease.jobId !== jobId ||
        lease.channel !== this.channel ||
        lease.token !== leaseToken ||
        lease.expiresAt !== acknowledgedExpiry ||
        Date.parse(lease.expiresAt) <= Date.now()
      ) {
        throw new Error("durable lease does not match acknowledgement");
      }
    } catch (error) {
      throw new CoProcDeliveryUnconfirmedError(
        this.channel,
        jobId,
        error instanceof Error
          ? `durable lease verification failed: ${error.message}`
          : "durable lease verification failed",
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
        throw new Error("worker output closed");
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

  subscribeTerminalSignals(
    listener: (signal: GenerationTerminalSignal) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    const unsubscribers = this.channels.flatMap((channel) => {
      const unsubscribe = channel.subscribeTerminalSignals?.(listener, onError);
      return unsubscribe ? [unsubscribe] : [];
    });
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }
}

interface TransportNotifyingMailboxOptions {
  durableJobPath(job: GenerationJob): string;
  onTransportError?: (error: unknown, job: GenerationJob) => void;
  onTerminalSignalError?: (
    error: unknown,
    signal?: GenerationTerminalSignal,
  ) => void;
}

export class TransportNotifyingGenerationMailbox implements GenerationMailbox {
  private readonly liveResults = new Map<
    string,
    Promise<GenerationResult | null>
  >();

  constructor(
    private readonly durableMailbox: GenerationMailbox,
    private readonly transport: GenerationTransport,
    private readonly options: TransportNotifyingMailboxOptions,
  ) {
    transport.subscribeTerminalSignals?.(
      (signal) => {
        this.liveResults.set(
          signal.jobId,
          this.ingestTerminalSignal(signal).catch((error: unknown) => {
            this.options.onTerminalSignalError?.(error, signal);
            return null;
          }),
        );
      },
      (error) => this.options.onTerminalSignalError?.(error),
    );
  }

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

  async readResult(jobId: string): Promise<GenerationResult | null> {
    const liveResult = this.liveResults.get(jobId);
    if (liveResult) {
      const result = await liveResult.catch(() => {
        this.liveResults.delete(jobId);
        return null;
      });
      if (result) return result;
    }
    return this.durableMailbox.readResult(jobId);
  }

  async archive(jobId: string): Promise<void> {
    this.liveResults.delete(jobId);
    await this.durableMailbox.archive(jobId);
  }

  private async ingestTerminalSignal(
    signal: GenerationTerminalSignal,
  ): Promise<GenerationResult> {
    const result = await this.durableMailbox.readResult(signal.jobId);
    if (!result) {
      throw new Error(
        `Live terminal signal for ${signal.jobId} arrived before its durable result`,
      );
    }
    if (result.status !== signal.status) {
      throw new Error(
        `Live terminal signal for ${signal.jobId} does not match its durable result`,
      );
    }
    return result;
  }
}
