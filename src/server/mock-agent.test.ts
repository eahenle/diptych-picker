import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileGenerationMailbox,
  type GenerationJob,
  type ImportAnnotationJob,
} from "./agent-mailbox";
import { LocalAssetStore } from "./asset-store";
import {
  MockAgentWorker,
  MockGenerationMailbox,
  MockImportAnnotationMailbox,
} from "./mock-agent";

const importAnnotationJob = (
  id = "import-annotation-1",
): ImportAnnotationJob => ({
  id,
  kind: "import-annotation",
  createdAt: "2026-08-09T18:00:00.000Z",
  importSessionId: "import-session-1",
  importItemId: "import-item-1",
  asset: {
    digest: "c".repeat(64),
    filename: `${"c".repeat(64)}.png`,
    url: `/api/assets/${"c".repeat(64)}.png`,
    contentType: "image/png",
    width: 1024,
    height: 1024,
    byteLength: 2048,
  },
});

const roots: string[] = [];

const job = (): GenerationJob => ({
  id: "job-1",
  kind: "challenger",
  createdAt: "2026-07-16T01:00:00.000Z",
  roundNumber: 1,
  winnerSide: "left",
  retainedWinner: {
    id: "left",
    imageUrl: "/left.png",
    prompt: "left prompt",
    concept: "Left concept",
    style: ["left style"],
    createdAt: "2026-07-16T00:00:00.000Z",
    winCount: 0,
  },
  rejectedCandidate: {
    id: "right",
    imageUrl: "/right.png",
    prompt: "right prompt",
    concept: "Right concept",
    style: ["right style"],
    createdAt: "2026-07-16T00:00:00.000Z",
    winCount: 0,
  },
  selectionHistory: [],
  recentConcepts: [],
  preferenceSeed: "Prefer novel, carefully fabricated scenes.",
});

const initialJob = (
  id: string,
  initialSide: "left" | "right",
): GenerationJob => ({
  ...job(),
  id,
  kind: "initial",
  batchId: "batch-1",
  initialSide,
  winnerSide: initialSide,
});

const refillJob = (id = "refill-job-1"): GenerationJob => {
  const baseJob = job();
  return {
    ...baseJob,
    id,
    kind: "refill",
    sessionId: "session-1",
    pinnedWinnerId: baseJob.retainedWinner.id,
  };
};

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("deterministic mock mailbox worker", () => {
  it("derives stable distinct annotation metadata per job without creating assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "diptych-mock-annotation-"));
    roots.push(root);
    const mailboxDirectory = join(root, "agent-mailbox");
    const fileMailbox = new FileGenerationMailbox(mailboxDirectory);
    const worker = new MockAgentWorker({
      mailboxDirectory,
      assetStore: new LocalAssetStore(join(root, "assets")),
      delayMs: 0,
      now: () => "2026-08-09T18:01:00.000Z",
    });
    const mailbox = new MockImportAnnotationMailbox(fileMailbox, worker);
    const firstJob = importAnnotationJob("import-annotation-1");
    const secondJob = importAnnotationJob("import-annotation-2");

    await mailbox.enqueueImportAnnotation(firstJob);
    await mailbox.enqueueImportAnnotation(secondJob);

    await vi.waitFor(async () => {
      expect(
        await fileMailbox.readImportAnnotationResult(firstJob.id),
      ).toMatchObject({
        jobId: firstJob.id,
        annotation: { source: "automated" },
      });
      expect(
        await fileMailbox.readImportAnnotationResult(secondJob.id),
      ).toMatchObject({
        jobId: secondJob.id,
        annotation: { source: "automated" },
      });
    });
    const first = await fileMailbox.readImportAnnotationResult(firstJob.id);
    const second = await fileMailbox.readImportAnnotationResult(secondJob.id);
    if (first?.status !== "completed" || second?.status !== "completed") {
      throw new Error("missing annotation result");
    }
    expect(first.annotation).not.toEqual(second.annotation);

    const replayWorker = new MockAgentWorker({
      mailboxDirectory,
      assetStore: new LocalAssetStore(join(root, "assets")),
      delayMs: 0,
      now: () => "2026-08-09T18:01:00.000Z",
    });
    replayWorker.schedule(firstJob);
    await vi.waitFor(async () => {
      expect(await fileMailbox.readImportAnnotationResult(firstJob.id)).toEqual(
        first,
      );
    });
    const assetNames = await readdir(join(root, "assets")).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    expect(assetNames).toEqual([]);
    replayWorker.dispose();
    worker.dispose();
  });

  it("schedules refill jobs through deterministic local providers", async () => {
    const root = await mkdtemp(join(tmpdir(), "diptych-mock-refill-"));
    roots.push(root);
    const mailboxDirectory = join(root, "agent-mailbox");
    const fileMailbox = new FileGenerationMailbox(mailboxDirectory);
    const worker = new MockAgentWorker({
      mailboxDirectory,
      assetStore: new LocalAssetStore(join(root, "assets")),
      delayMs: 0,
      now: () => "2026-07-16T01:00:01.000Z",
    });
    const mailbox = new MockGenerationMailbox(fileMailbox, worker);
    const refill = refillJob();

    await mailbox.enqueue(refill);

    let result = await fileMailbox.readResult(refill.id);
    await vi.waitFor(async () => {
      result = await fileMailbox.readResult(refill.id);
      expect(result).toMatchObject({
        jobId: refill.id,
        status: "completed",
        asset: { candidateId: `challenger-${refill.id}` },
      });
    });
    if (result?.status !== "completed") throw new Error("missing completion");
    expect(
      await readFile(join(root, "assets", result.asset.filename)),
    ).not.toHaveLength(0);
    worker.dispose();
  });

  it("publishes exactly one failed refill for the fail-once sentinel", async () => {
    const root = await mkdtemp(join(tmpdir(), "diptych-mock-refill-fail-"));
    roots.push(root);
    const mailboxDirectory = join(root, "agent-mailbox");
    const fileMailbox = new FileGenerationMailbox(mailboxDirectory);
    const worker = new MockAgentWorker({
      mailboxDirectory,
      assetStore: new LocalAssetStore(join(root, "assets")),
      delayMs: 0,
      now: () => "2026-07-16T01:00:01.000Z",
    });
    const mailbox = new MockGenerationMailbox(fileMailbox, worker);
    const first = {
      ...refillJob("refill-sentinel-1"),
      preferenceSeed:
        "Prefer novel, carefully fabricated scenes. [mock:fail-once]",
    };
    const second = { ...first, id: "refill-sentinel-2" };

    await mailbox.enqueue(first);
    await vi.waitFor(async () => {
      expect(await fileMailbox.readResult(first.id)).toMatchObject({
        status: "failed",
        message: expect.stringContaining("[mock:fail-once]"),
      });
    });

    await mailbox.enqueue(second);
    await vi.waitFor(async () => {
      expect(await fileMailbox.readResult(second.id)).toMatchObject({
        status: "completed",
        asset: { candidateId: `challenger-${second.id}` },
      });
    });
    worker.dispose();
  });

  it("publishes exactly one failed challenger for the fail-once sentinel", async () => {
    const root = await mkdtemp(join(tmpdir(), "diptych-mock-fail-once-"));
    roots.push(root);
    const mailboxDirectory = join(root, "agent-mailbox");
    const fileMailbox = new FileGenerationMailbox(mailboxDirectory);
    const worker = new MockAgentWorker({
      mailboxDirectory,
      assetStore: new LocalAssetStore(join(root, "assets")),
      delayMs: 0,
      now: () => "2026-07-16T01:00:01.000Z",
    });
    const mailbox = new MockGenerationMailbox(fileMailbox, worker);
    const first = {
      ...job(),
      id: "sentinel-job-1",
      preferenceSeed:
        "Prefer novel, carefully fabricated scenes. [mock:fail-once]",
    };
    const second = { ...first, id: "sentinel-job-2" };

    await mailbox.enqueue(first);
    await vi.waitFor(async () => {
      expect(await fileMailbox.readResult(first.id)).toMatchObject({
        status: "failed",
        message: expect.stringContaining("[mock:fail-once]"),
      });
    });

    await mailbox.enqueue(second);
    await vi.waitFor(async () => {
      expect(await fileMailbox.readResult(second.id)).toMatchObject({
        status: "completed",
        asset: { candidateId: `challenger-${second.id}` },
      });
    });
    worker.dispose();
  });

  it("publishes exactly one delayed completion and immutable local asset per job", async () => {
    const root = await mkdtemp(join(tmpdir(), "diptych-mock-agent-"));
    roots.push(root);
    const mailboxDirectory = join(root, "agent-mailbox");
    const fileMailbox = new FileGenerationMailbox(mailboxDirectory);
    const worker = new MockAgentWorker({
      mailboxDirectory,
      assetStore: new LocalAssetStore(join(root, "assets")),
      delayMs: 25,
      now: () => "2026-07-16T01:00:01.000Z",
    });
    const mailbox = new MockGenerationMailbox(fileMailbox, worker);

    await mailbox.enqueue(job());
    expect(await fileMailbox.readResult("job-1")).toBeNull();

    let result = await new FileGenerationMailbox(mailboxDirectory).readResult(
      "job-1",
    );
    await vi.waitFor(async () => {
      result = await new FileGenerationMailbox(mailboxDirectory).readResult(
        "job-1",
      );
      expect(result).not.toBeNull();
    });

    expect(result).toMatchObject({
      jobId: "job-1",
      status: "completed",
      completedAt: "2026-07-16T01:00:01.000Z",
      asset: {
        candidateId: "challenger-job-1",
        filename: expect.stringMatching(/^[a-f0-9]{64}\.png$/),
        imageUrl: expect.stringMatching(/^\/api\/assets\/[a-f0-9]{64}\.png$/),
        contentType: "image/png",
        width: 1024,
        height: 1024,
      },
    });
    if (result?.status !== "completed") throw new Error("missing completion");
    const firstBytes = await readFile(
      join(root, "assets", result.asset.filename),
    );

    worker.schedule(job());
    worker.schedule(job());

    expect(await readFile(join(root, "assets", result.asset.filename))).toEqual(
      firstBytes,
    );
    expect(await fileMailbox.readResult("job-1")).toEqual(result);
    worker.dispose();
  }, 15_000);

  it("completes both initial sides deterministically with distinct proposals", async () => {
    const root = await mkdtemp(join(tmpdir(), "diptych-mock-initial-"));
    roots.push(root);
    const mailboxDirectory = join(root, "agent-mailbox");
    const fileMailbox = new FileGenerationMailbox(mailboxDirectory);
    const worker = new MockAgentWorker({
      mailboxDirectory,
      assetStore: new LocalAssetStore(join(root, "assets")),
      delayMs: 0,
      now: () => "2026-07-16T01:00:01.000Z",
    });
    const mailbox = new MockGenerationMailbox(fileMailbox, worker);

    await mailbox.enqueue(initialJob("initial-left", "left"));
    await mailbox.enqueue(initialJob("initial-right", "right"));

    let left = await fileMailbox.readResult("initial-left");
    let right = await fileMailbox.readResult("initial-right");
    await vi.waitFor(async () => {
      left = await fileMailbox.readResult("initial-left");
      right = await fileMailbox.readResult("initial-right");
      expect(left?.status).toBe("completed");
      expect(right?.status).toBe("completed");
    });

    expect(left).toMatchObject({
      status: "completed",
      asset: { candidateId: "challenger-initial-left" },
    });
    expect(right).toMatchObject({
      status: "completed",
      asset: { candidateId: "challenger-initial-right" },
    });
    if (left?.status !== "completed" || right?.status !== "completed") {
      throw new Error("mock initial generation did not complete");
    }
    expect(left.proposal.concept).not.toBe(right.proposal.concept);
    expect(
      await readFile(join(root, "assets", left.asset.filename)),
    ).not.toEqual(await readFile(join(root, "assets", right.asset.filename)));
    worker.dispose();
  });

  it("resumes a persisted initial job after the mock worker restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "diptych-mock-restart-"));
    roots.push(root);
    const mailboxDirectory = join(root, "agent-mailbox");
    const fileMailbox = new FileGenerationMailbox(mailboxDirectory);
    await fileMailbox.enqueue(initialJob("initial-left", "left"));
    const worker = new MockAgentWorker({
      mailboxDirectory,
      assetStore: new LocalAssetStore(join(root, "assets")),
      delayMs: 0,
    });
    const restarted = new MockGenerationMailbox(fileMailbox, worker);

    await restarted.readWork("initial-left");

    await vi.waitFor(async () => {
      expect(await fileMailbox.readResult("initial-left")).toMatchObject({
        status: "completed",
      });
    });
    worker.dispose();
  });
});
