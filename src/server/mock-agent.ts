import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { preferenceProfileFromSeed } from "@/domain/game";
import type {
  AgentJob,
  AgentResult,
  GenerationJob,
  GenerationMailbox,
  GenerationResult,
  LeaderboardProfileJob,
  LeaderboardProfileMailbox,
  LeaderboardProfileResult,
  PromptCardBlenderJob,
  PromptCardBlenderMailbox,
  PromptCardBlenderResult,
  PromptCardEditorJob,
  PromptCardEditorMailbox,
  PromptCardEditorResult,
  SourceProfileJob,
  SourceProfileMailbox,
  SourceProfileResult,
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

  schedule(job: AgentJob): void {
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

  private async complete(job: AgentJob): Promise<void> {
    if (job.kind === "source-profile") {
      await this.completeSourceProfile(job);
      return;
    }
    if (job.kind === "leaderboard-profile") {
      await this.completeLeaderboardProfile(job);
      return;
    }
    if (job.kind === "prompt-card-editor") {
      await this.completePromptCardEditor(job);
      return;
    }
    if (job.kind === "prompt-card-blender") {
      await this.completePromptCardBlender(job);
      return;
    }

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
      leaderboardEvidence: job.leaderboardEvidence,
      leaderboardVisualProfile: job.leaderboardVisualProfile,
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

  private async completeSourceProfile(job: SourceProfileJob): Promise<void> {
    const result: SourceProfileResult = {
      jobId: job.id,
      kind: "source-profile",
      status: "completed",
      completedAt: this.now(),
      profile: {
        themes:
          "Variations on the uploaded source image's subjects, setting, and visual relationships",
        inspiration: `Preserve the source's ${job.sourceImage.width} × ${job.sourceImage.height} composition while exploring new arrangements and lighting`,
        mediaTypes: "digital illustration and photography",
        visualStyle: "cohesive, detailed, and composition-led",
        colorPalette: "colors sampled from the uploaded source image",
        contentLevel: "family-friendly",
        avoid:
          "exact identity, facial likeness, logos, readable text, and pixel-for-pixel reproduction",
      },
      reasoningSummary:
        "The editable profile carries transferable subject, composition, medium, style, and palette cues without requesting a specific identity or exact likeness.",
    };
    await this.publish("completed", job.id, result);
  }

  private async completeLeaderboardProfile(
    job: LeaderboardProfileJob,
  ): Promise<void> {
    const leading = job.sources[0];
    const sharedStyles = [
      ...new Set(job.sources.flatMap(({ style }) => style)),
    ].slice(0, 6);
    const result: LeaderboardProfileResult = {
      jobId: job.id,
      kind: "leaderboard-profile",
      status: "completed",
      completedAt: this.now(),
      fingerprint: job.fingerprint,
      profile: {
        themes: `Transferable visual themes shared by ${job.sources.length} leading pool images, led by ${leading.concept}`,
        inspiration: `Favor recurring composition and lighting qualities from the top-ranked cohort without copying any one image`,
        mediaTypes: "media patterns visible across the leading pool cohort",
        visualStyle: sharedStyles.join(", ") || "cohesive and detailed",
        colorPalette:
          "recurring palette relationships across the leading images",
        contentLevel: "family-friendly",
        avoid:
          "exact identity, facial likeness, logos, readable text, and direct reproduction of any pool image",
      },
      reasoningSummary:
        "Synthesizes shared visual qualities across the ranked leaders while keeping each source image immutable.",
    };
    await this.publish("completed", job.id, result);
  }

  private async completePromptCardEditor(
    job: PromptCardEditorJob,
  ): Promise<void> {
    const result: PromptCardEditorResult = {
      jobId: job.id,
      kind: "prompt-card-editor",
      status: "completed",
      completedAt: this.now(),
      cardId: job.card.id,
      proposals: [
        {
          title: `${job.card.title} — focused`.slice(0, 80),
          prompt:
            `${job.card.prompt} Emphasize a clearer focal hierarchy and simpler supporting detail.`.slice(
              0,
              1_000,
            ),
          negativePrompt: job.card.negativePrompt,
          tags: job.card.tags,
          reasoningSummary:
            "Narrows the composition while preserving the original card's intended aesthetic.",
        },
        {
          title: `${job.card.title} — alternate`.slice(0, 80),
          prompt:
            `${job.card.prompt} Explore a distinct camera angle and more deliberate lighting rhythm.`.slice(
              0,
              1_000,
            ),
          negativePrompt: job.card.negativePrompt,
          tags: job.card.tags,
          reasoningSummary:
            "Introduces controlled visual variation in response to repeated rejection evidence.",
        },
      ],
    };
    await this.publish("completed", job.id, result);
  }

  private async completePromptCardBlender(
    job: PromptCardBlenderJob,
  ): Promise<void> {
    const [first, second] = job.cards;
    const firstPercent = Math.round(job.ratio * 100);
    const result: PromptCardBlenderResult = {
      jobId: job.id,
      kind: "prompt-card-blender",
      status: "completed",
      completedAt: this.now(),
      cardIds: [first.id, second.id],
      proposal: {
        title: `${first.title} + ${second.title}`.slice(0, 80),
        prompt:
          `${first.prompt} Blend this at roughly ${firstPercent}% influence with these complementary qualities: ${second.prompt}`.slice(
            0,
            1_000,
          ),
        negativePrompt: [first.negativePrompt, second.negativePrompt]
          .filter(Boolean)
          .join(", ")
          .slice(0, 500),
        tags: [...new Set([...first.tags, ...second.tags])].slice(0, 8),
        reasoningSummary:
          "Combines the strongest compatible qualities of both immutable source cards into one reviewable child.",
      },
    };
    await this.publish("completed", job.id, result);
  }

  private async fail(job: AgentJob, error: unknown): Promise<void> {
    const result: AgentResult = {
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
    result: AgentResult,
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

export class MockSourceProfileMailbox implements SourceProfileMailbox {
  constructor(
    private readonly mailbox: SourceProfileMailbox,
    private readonly worker: MockAgentWorker,
  ) {}

  async enqueueSourceProfile(job: SourceProfileJob): Promise<void> {
    await this.mailbox.enqueueSourceProfile(job);
    this.worker.schedule(job);
  }

  async readSourceProfileWork(jobId: string) {
    const job = await this.mailbox.readSourceProfileWork(jobId);
    await this.resume(job);
    return job;
  }

  readSourceProfileResult(jobId: string) {
    return this.mailbox.readSourceProfileResult(jobId);
  }

  archiveSourceProfile(jobId: string) {
    return this.mailbox.archiveSourceProfile(jobId);
  }

  private async resume(job: SourceProfileJob | null): Promise<void> {
    if (job && !(await this.mailbox.readSourceProfileResult(job.id))) {
      this.worker.schedule(job);
    }
  }
}

export class MockLeaderboardProfileMailbox implements LeaderboardProfileMailbox {
  constructor(
    private readonly mailbox: LeaderboardProfileMailbox,
    private readonly worker: MockAgentWorker,
  ) {}

  async enqueueLeaderboardProfile(job: LeaderboardProfileJob): Promise<void> {
    await this.mailbox.enqueueLeaderboardProfile(job);
    this.worker.schedule(job);
  }

  async readLeaderboardProfileWork(jobId: string) {
    const job = await this.mailbox.readLeaderboardProfileWork(jobId);
    await this.resume(job);
    return job;
  }

  readLeaderboardProfileResult(jobId: string) {
    return this.mailbox.readLeaderboardProfileResult(jobId);
  }

  archiveLeaderboardProfile(jobId: string) {
    return this.mailbox.archiveLeaderboardProfile(jobId);
  }

  private async resume(job: LeaderboardProfileJob | null): Promise<void> {
    if (job && !(await this.mailbox.readLeaderboardProfileResult(job.id))) {
      this.worker.schedule(job);
    }
  }
}

export class MockPromptCardEditorMailbox implements PromptCardEditorMailbox {
  constructor(
    private readonly mailbox: PromptCardEditorMailbox,
    private readonly worker: MockAgentWorker,
  ) {}

  async enqueuePromptCardEditor(job: PromptCardEditorJob): Promise<void> {
    await this.mailbox.enqueuePromptCardEditor(job);
    this.worker.schedule(job);
  }

  async readPromptCardEditorWork(jobId: string) {
    const job = await this.mailbox.readPromptCardEditorWork(jobId);
    await this.resume(job);
    return job;
  }

  readPromptCardEditorResult(jobId: string) {
    return this.mailbox.readPromptCardEditorResult(jobId);
  }

  archivePromptCardEditor(jobId: string) {
    return this.mailbox.archivePromptCardEditor(jobId);
  }

  private async resume(job: PromptCardEditorJob | null): Promise<void> {
    if (job && !(await this.mailbox.readPromptCardEditorResult(job.id))) {
      this.worker.schedule(job);
    }
  }
}

export class MockPromptCardBlenderMailbox implements PromptCardBlenderMailbox {
  constructor(
    private readonly mailbox: PromptCardBlenderMailbox,
    private readonly worker: MockAgentWorker,
  ) {}

  async enqueuePromptCardBlender(job: PromptCardBlenderJob): Promise<void> {
    await this.mailbox.enqueuePromptCardBlender(job);
    this.worker.schedule(job);
  }

  async readPromptCardBlenderWork(jobId: string) {
    const job = await this.mailbox.readPromptCardBlenderWork(jobId);
    await this.resume(job);
    return job;
  }

  readPromptCardBlenderResult(jobId: string) {
    return this.mailbox.readPromptCardBlenderResult(jobId);
  }

  archivePromptCardBlender(jobId: string) {
    return this.mailbox.archivePromptCardBlender(jobId);
  }

  private async resume(job: PromptCardBlenderJob | null): Promise<void> {
    if (job && !(await this.mailbox.readPromptCardBlenderResult(job.id))) {
      this.worker.schedule(job);
    }
  }
}
