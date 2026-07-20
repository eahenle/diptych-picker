import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { preferenceProfileFromSeed } from "@/domain/game";
import type {
  GenerationJob,
  GenerationMailbox,
  GenerationResult,
} from "./agent-mailbox";
import {
  MockChallengerPromptProvider,
  MockImageProvider,
} from "./mock-providers";
import type {
  AssetStore,
  ChallengerPromptProvider,
  ImageProvider,
} from "./providers";

interface MockAgentWorkerOptions {
  mailboxDirectory: string;
  assetStore: AssetStore;
  delayMs: number;
  now?: () => string;
  promptProvider?: ChallengerPromptProvider;
  imageProvider?: ImageProvider;
}

/**
 * Test-only in-process stand-in for the persistent Codex coordinator. It
 * publishes through the filesystem protocol so GameService reconciliation is
 * exercised exactly as it is with the real runner.
 */
export class MockAgentWorker {
  private readonly scheduled = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private failOnceSentinelConsumed = false;
  private readonly now: () => string;
  private readonly promptProvider: ChallengerPromptProvider;
  private readonly imageProvider: ImageProvider;

  constructor(private readonly options: MockAgentWorkerOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.promptProvider =
      options.promptProvider ?? new MockChallengerPromptProvider();
    this.imageProvider = options.imageProvider ?? new MockImageProvider();
  }

  schedule(job: GenerationJob): void {
    if (this.scheduled.has(job.id)) return;
    this.scheduled.add(job.id);
    const timer = setTimeout(async () => {
      this.timers.delete(job.id);
      try {
        await this.complete(job);
      } catch (error) {
        await this.fail(job, error).catch(() => undefined);
      }
    }, this.options.delayMs);
    this.timers.set(job.id, timer);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private async complete(job: GenerationJob): Promise<void> {
    // Playwright-only deterministic failure hook. A worker consumes this
    // sentinel once for challenger or refill jobs; no external provider runs.
    if (
      (job.kind === "challenger" || job.kind === "refill") &&
      job.preferenceSeed.includes("[mock:fail-once]") &&
      !this.failOnceSentinelConsumed
    ) {
      this.failOnceSentinelConsumed = true;
      throw new Error(
        "Deterministic mock failure requested by [mock:fail-once]",
      );
    }

    const recentConcepts =
      job.kind === "initial" && job.initialSide === "right"
        ? [...job.recentConcepts, "Kinetic paper aviary"]
        : job.recentConcepts;
    const proposal = await this.promptProvider.propose({
      retainedWinner: job.retainedWinner,
      rejectedCandidate: job.rejectedCandidate,
      selectionHistory: job.selectionHistory,
      recentConcepts,
      preferenceSeed: job.preferenceSeed,
      preferenceProfile:
        job.preferenceProfile ?? preferenceProfileFromSeed(job.preferenceSeed),
    });
    const image = await this.imageProvider.generate(proposal.visualPrompt);
    if (
      image.extension !== "png" ||
      image.contentType !== "image/png" ||
      image.width !== image.height
    ) {
      throw new Error("Mock generation must produce one square PNG");
    }

    const candidateId = `challenger-${job.id}`;
    const stored = await this.options.assetStore.save({
      ...image,
      id: candidateId,
    });
    const result: GenerationResult = {
      jobId: job.id,
      status: "completed",
      completedAt: this.now(),
      proposal,
      asset: {
        candidateId,
        filename: stored.filename,
        imageUrl: stored.url,
        contentType: "image/png",
        width: image.width,
        height: image.height,
        byteLength: stored.byteLength,
      },
    };
    await this.publish("completed", job.id, result);
  }

  private async fail(job: GenerationJob, error: unknown): Promise<void> {
    const result: GenerationResult = {
      jobId: job.id,
      status: "failed",
      completedAt: this.now(),
      message:
        error instanceof Error ? error.message : "Mock generation failed",
      retryable: true,
    };
    await this.publish("failed", job.id, result);
  }

  private async publish(
    directoryName: "completed" | "failed",
    jobId: string,
    result: GenerationResult,
  ): Promise<void> {
    const directory = join(this.options.mailboxDirectory, directoryName);
    await mkdir(directory, { recursive: true });
    const destination = join(directory, `${jobId}.json`);
    const temporary = join(
      directory,
      `.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    try {
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

/** A mailbox decorator that schedules the mock worker only after enqueue. */
export class MockGenerationMailbox implements GenerationMailbox {
  constructor(
    private readonly mailbox: GenerationMailbox,
    private readonly worker: MockAgentWorker,
  ) {}

  async enqueue(job: GenerationJob): Promise<void> {
    await this.mailbox.enqueue(job);
    this.worker.schedule(job);
  }

  async readPending(jobId: string) {
    const job = await this.mailbox.readPending(jobId);
    await this.resume(job);
    return job;
  }

  async readWork(jobId: string) {
    const job = await this.mailbox.readWork(jobId);
    await this.resume(job);
    return job;
  }

  readResult(jobId: string) {
    return this.mailbox.readResult(jobId);
  }

  archive(jobId: string) {
    return this.mailbox.archive(jobId);
  }

  private async resume(job: GenerationJob | null): Promise<void> {
    if (job && !(await this.mailbox.readResult(job.id))) {
      this.worker.schedule(job);
    }
  }
}
