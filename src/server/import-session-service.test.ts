import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GenerationResult,
  InitialImportFillJob,
  InitialImportFillMailbox,
  ImportAnnotationJob,
  ImportAnnotationMailbox,
  ImportAnnotationResult,
} from "./agent-mailbox";
import type {
  ImportedAssetMetadata,
  InitialFillJobRecord,
  ImportItem,
  ImportSession,
} from "@/domain/import-session";
import { JsonImportSessionRepository } from "./import-session-repository";
import {
  ImportSessionConflictError,
  ImportSessionService,
} from "./import-session-service";

const timestamp = "2026-08-10T20:00:00.000Z";

function asset(character = "a"): ImportedAssetMetadata {
  const digest = character.repeat(64);
  return {
    digest,
    filename: `${digest}.png`,
    url: `/api/assets/${digest}.png`,
    contentType: "image/png",
    width: 1024,
    height: 1024,
    byteLength: 1024,
  };
}

class MemoryImportAnnotationMailbox implements ImportAnnotationMailbox {
  readonly work = new Map<string, ImportAnnotationJob>();
  readonly results = new Map<string, ImportAnnotationResult>();
  readonly enqueued: ImportAnnotationJob[] = [];
  readonly archived: string[] = [];

  async enqueueImportAnnotation(job: ImportAnnotationJob): Promise<void> {
    this.enqueued.push(job);
    this.work.set(job.id, job);
  }

  async readImportAnnotationWork(jobId: string) {
    return this.work.get(jobId) ?? null;
  }

  async readImportAnnotationResult(jobId: string) {
    return this.results.get(jobId) ?? null;
  }

  async archiveImportAnnotation(jobId: string): Promise<void> {
    this.archived.push(jobId);
    this.work.delete(jobId);
    this.results.delete(jobId);
  }
}

class MemoryInitialImportFillMailbox implements InitialImportFillMailbox {
  readonly work = new Map<string, InitialImportFillJob>();
  readonly results = new Map<string, GenerationResult>();
  readonly enqueued: InitialImportFillJob[] = [];
  readonly archived: string[] = [];

  async enqueueInitialImportFill(job: InitialImportFillJob): Promise<void> {
    this.enqueued.push(job);
    this.work.set(job.id, job);
  }

  async readInitialImportFillWork(jobId: string) {
    return this.work.get(jobId) ?? null;
  }

  async readInitialImportFillResult(jobId: string) {
    return this.results.get(jobId) ?? null;
  }

  async archiveInitialImportFill(jobId: string): Promise<void> {
    this.archived.push(jobId);
    this.work.delete(jobId);
    this.results.delete(jobId);
  }
}

async function harness(ids: string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "diptych-import-service-"));
  const repository = new JsonImportSessionRepository(
    join(directory, "import-session.json"),
  );
  const mailbox = new MemoryImportAnnotationMailbox();
  const normalizeAsset = vi.fn(async () => asset());
  const verifyAsset = vi.fn(async () => undefined);
  let nextId = 0;
  const service = new ImportSessionService({
    repository,
    mailbox,
    normalizeAsset,
    verifyAsset,
    createId: () => ids[nextId++] ?? `generated-id-${nextId}`,
    now: () => timestamp,
  });
  return { repository, mailbox, normalizeAsset, verifyAsset, service };
}

function completedResult(jobId: string): ImportAnnotationResult {
  return {
    jobId,
    kind: "import-annotation",
    status: "completed",
    completedAt: timestamp,
    annotation: {
      concept: "Copper studio portrait",
      prompt: "One subject against a restrained copper studio backdrop.",
      style: ["studio photography", "copper and violet"],
      reasoningSummary: "Describes visible composition and palette.",
      source: "automated",
    },
  };
}

function failedResult(jobId: string): ImportAnnotationResult {
  return {
    jobId,
    status: "failed",
    completedAt: timestamp,
    message: "/private/mailbox/path and raw worker detail",
    retryable: true,
    category: "operational",
  };
}

function completedInitialFillResult(jobId: string): GenerationResult {
  const digest = "f".repeat(64);
  return {
    jobId,
    status: "completed",
    completedAt: timestamp,
    proposal: {
      concept: `${jobId} concept`,
      visualPrompt: `${jobId} standalone square visual prompt`,
      styleTags: ["studio photography"],
      reasoningSummary: "Follows the clean session preference seed.",
    },
    asset: {
      candidateId: `challenger-${jobId}`,
      filename: `${digest}.png`,
      imageUrl: `/api/assets/${digest}.png`,
      contentType: "image/png",
      width: 1024,
      height: 1024,
      byteLength: 1024,
    },
  };
}

function readyItem(id: string, character: string): ImportItem {
  return {
    id,
    normalizedDigest: character.repeat(64),
    status: "ready",
    asset: asset(character),
    annotationJob: null,
    annotation: {
      concept: `${id} concept`,
      prompt: `${id} prompt`,
      style: ["photography"],
      reasoningSummary: "Visible transferable qualities.",
      source: "automated",
    },
    candidateId: `candidate-${id}`,
    failureMessage: null,
    approvedAt: timestamp,
    servedAt: null,
  };
}

describe("ImportSessionService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("creates one editing session and resumes it", async () => {
    const { service } = await harness(["import-session-1"]);

    const created = await service.createOrResume();
    const resumed = await service.createOrResume();

    expect(created).toMatchObject({
      sessionId: "import-session-1",
      status: "editing",
      activationReady: 0,
      counts: { total: 0 },
    });
    expect(resumed).toEqual(created);
  });

  it("persists approval before publishing one exact annotation job", async () => {
    const { service, repository, mailbox, normalizeAsset, verifyAsset } =
      await harness(["import-session-1", "item-1", "annotation-1"]);
    await service.createOrResume();

    const status = await service.approve(
      "import-session-1",
      Uint8Array.of(1, 2, 3),
    );

    expect(normalizeAsset).toHaveBeenCalledOnce();
    expect(verifyAsset).toHaveBeenCalledWith(asset());
    expect(mailbox.enqueued).toEqual([
      expect.objectContaining({
        id: "annotation-1",
        importSessionId: "import-session-1",
        importItemId: "item-1",
        asset: asset(),
      }),
    ]);
    expect(await repository.load()).toMatchObject({
      items: [
        {
          id: "item-1",
          status: "annotating",
          annotationJob: { id: "annotation-1" },
        },
      ],
    });
    expect(status.items[0]).not.toHaveProperty("annotationJob");
    expect(status.items[0].asset).toEqual({
      url: asset().url,
      width: 1024,
      height: 1024,
    });
  });

  it("rejects a duplicate canonical digest without publishing another job", async () => {
    const { service, mailbox } = await harness([
      "import-session-1",
      "item-1",
      "annotation-1",
      "item-2",
      "annotation-2",
    ]);
    await service.createOrResume();
    await service.approve("import-session-1", Uint8Array.of(1));

    await expect(
      service.approve("import-session-1", Uint8Array.of(2)),
    ).rejects.toBeInstanceOf(ImportSessionConflictError);
    expect(mailbox.enqueued).toHaveLength(1);
  });

  it("accepts only the expected completed result and creates a stable candidate", async () => {
    const { service, repository, mailbox, verifyAsset } = await harness([
      "import-session-1",
      "item-1",
      "annotation-1",
    ]);
    await service.createOrResume();
    await service.approve("import-session-1", Uint8Array.of(1));
    mailbox.results.set("annotation-1", completedResult("annotation-1"));

    const first = await service.status("import-session-1");
    const candidateId = first.items[0].candidateId;
    const second = await service.status("import-session-1");

    expect(first.items[0]).toMatchObject({
      status: "ready",
      annotation: { source: "automated" },
      failureMessage: null,
    });
    expect(candidateId).toMatch(/^imported-[a-f0-9]{64}$/);
    expect(second.items[0].candidateId).toBe(candidateId);
    expect(verifyAsset).toHaveBeenCalledWith(asset());
    expect(mailbox.archived).toEqual(["annotation-1"]);
    expect(await repository.load()).toMatchObject({
      items: [{ annotationJob: null, candidateId }],
    });
  });

  it("keeps annotation failures display-safe and supports a fresh retry", async () => {
    const { service, repository, mailbox } = await harness([
      "import-session-1",
      "item-1",
      "annotation-1",
      "annotation-2",
    ]);
    await service.createOrResume();
    await service.approve("import-session-1", Uint8Array.of(1));
    mailbox.results.set("annotation-1", failedResult("annotation-1"));

    const failed = await service.status("import-session-1");
    const retried = await service.retry("import-session-1", "item-1");

    expect(failed.items[0].failureMessage).not.toContain("/private");
    expect(retried.items[0]).toMatchObject({
      status: "annotating",
      failureMessage: null,
    });
    expect(mailbox.enqueued.map(({ id }) => id)).toEqual([
      "annotation-1",
      "annotation-2",
    ]);
    expect(mailbox.archived).toEqual(["annotation-1", "annotation-1"]);
    expect(await repository.load()).toMatchObject({
      items: [{ annotationJob: { id: "annotation-2" } }],
    });
  });

  it("manually resolves a failed item and suppresses its late worker result", async () => {
    const { service, repository, mailbox } = await harness([
      "import-session-1",
      "item-1",
      "annotation-1",
    ]);
    await service.createOrResume();
    await service.approve("import-session-1", Uint8Array.of(1));
    mailbox.results.set("annotation-1", failedResult("annotation-1"));
    await service.status("import-session-1");

    const resolved = await service.annotateManually(
      "import-session-1",
      "item-1",
      {
        concept: "Manual concept",
        prompt: "Factual visible description.",
        style: ["editorial", "low-key light"],
      },
    );
    mailbox.results.set("annotation-1", completedResult("annotation-1"));
    const afterLateResult = await service.status("import-session-1");

    expect(resolved.items[0]).toMatchObject({
      status: "ready",
      annotation: {
        concept: "Manual concept",
        source: "manual",
        reasoningSummary: "Provided manually during image import.",
      },
    });
    expect(afterLateResult.items[0].annotation?.concept).toBe("Manual concept");
    expect(await repository.load()).toMatchObject({
      items: [{ annotationJob: null, annotation: { source: "manual" } }],
    });
  });

  it("seals idempotently, blocks premature pause, and abandons without deleting assets", async () => {
    const { service, repository, mailbox } = await harness([
      "import-session-1",
      "item-1",
      "annotation-1",
    ]);
    await service.createOrResume();
    await service.approve("import-session-1", Uint8Array.of(1));

    await expect(service.pause("import-session-1")).rejects.toBeInstanceOf(
      ImportSessionConflictError,
    );
    const sealed = await service.seal("import-session-1");
    expect((await service.seal("import-session-1")).sealedAt).toBe(
      sealed.sealedAt,
    );
    await expect(service.pause("import-session-1")).resolves.toMatchObject({
      status: "preparing",
    });

    await service.abandon("import-session-1");
    await expect(repository.load()).resolves.toBeNull();
    expect(mailbox.archived).toContain("annotation-1");
  });

  it("publishes the exact initial shortfall once and reconciles each result independently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-import-fill-"));
    const repository = new JsonImportSessionRepository(
      join(directory, "import-session.json"),
    );
    await repository.save({
      version: 1,
      id: "import-session-1",
      status: "preparing",
      createdAt: timestamp,
      sealedAt: timestamp,
      activatedAt: null,
      items: [readyItem("item-1", "a"), readyItem("item-2", "b")],
      initialFillJobs: [],
      initialFillRetry: null,
      servedReceipts: [],
    });
    const annotationMailbox = new MemoryImportAnnotationMailbox();
    const initialFillMailbox = new MemoryInitialImportFillMailbox();
    const ids = ["fill-attempt-1", "fill-job-1", "fill-job-2", "fill-job-3"];
    let index = 0;
    const verifyGeneratedAsset = vi.fn(async () => undefined);
    const service = new ImportSessionService({
      repository,
      mailbox: annotationMailbox,
      initialFillMailbox,
      defaultPreferenceSeed: "Clean-session default image preferences",
      verifyGeneratedAsset,
      normalizeAsset: async () => asset(),
      verifyAsset: async () => undefined,
      createId: () => ids[index++],
      now: () => timestamp,
    });

    const pending = await service.status("import-session-1");
    await service.status("import-session-1");

    expect(pending.initialFill.pending).toBe(3);
    expect(initialFillMailbox.enqueued).toEqual([
      {
        id: "fill-job-1",
        kind: "initial-import-fill",
        createdAt: timestamp,
        importSessionId: "import-session-1",
        attemptId: "fill-attempt-1",
        preferenceSeed: "Clean-session default image preferences",
      },
      expect.objectContaining({ id: "fill-job-2" }),
      expect.objectContaining({ id: "fill-job-3" }),
    ]);

    initialFillMailbox.results.set(
      "fill-job-1",
      completedInitialFillResult("fill-job-1"),
    );
    initialFillMailbox.results.set("fill-job-2", {
      jobId: "fill-job-2",
      status: "failed",
      completedAt: timestamp,
      message: "/private/raw worker failure",
      retryable: true,
      category: "operational",
    });
    initialFillMailbox.results.set(
      "fill-job-3",
      completedInitialFillResult("fill-job-3"),
    );

    const reconciled = await service.status("import-session-1");

    expect(reconciled.initialFill).toMatchObject({
      pending: 0,
      ready: 2,
      failed: 1,
      failedAttemptId: "fill-attempt-1",
      failureMessage:
        "One or more generated starter candidates failed. Retry the remaining initial fill.",
    });
    expect(JSON.stringify(reconciled)).not.toContain("/private/raw");
    expect(initialFillMailbox.archived).toEqual([
      "fill-job-1",
      "fill-job-2",
      "fill-job-3",
    ]);
    expect(verifyGeneratedAsset).toHaveBeenCalledTimes(2);
    expect((await repository.load())?.initialFillJobs).toEqual([
      expect.objectContaining({
        id: "fill-job-1",
        status: "ready",
        candidate: expect.objectContaining({ id: "challenger-fill-job-1" }),
      }),
      expect.objectContaining({
        id: "fill-job-2",
        status: "failed",
        failureMessage:
          "One or more generated starter candidates failed. Retry the remaining initial fill.",
      }),
      expect.objectContaining({
        id: "fill-job-3",
        status: "ready",
        candidate: expect.objectContaining({ id: "challenger-fill-job-3" }),
      }),
    ]);
  });

  it("persists an idempotent initial-fill retry before publishing only the deficit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-import-retry-"));
    const repository = new JsonImportSessionRepository(
      join(directory, "import-session.json"),
    );
    const mailbox = new MemoryImportAnnotationMailbox();
    const initial: ImportSession = {
      version: 1,
      id: "import-session-1",
      status: "preparing",
      createdAt: timestamp,
      sealedAt: timestamp,
      activatedAt: null,
      items: [readyItem("item-1", "a"), readyItem("item-2", "b")],
      initialFillJobs: [
        {
          id: "failed-job-1",
          attemptId: "failed-attempt-1",
          status: "failed",
          candidate: null,
          source: "generated",
          importItemId: null,
          failureMessage: "private worker failure",
          completedAt: timestamp,
        },
      ],
      initialFillRetry: null,
      servedReceipts: [],
    };
    await repository.save(initial);
    const ids = [
      "replacement-attempt-1",
      "replacement-job-1",
      "replacement-job-2",
      "replacement-job-3",
    ];
    let index = 0;
    const publishedJobs: InitialFillJobRecord[][] = [];
    const publishInitialFillJobs = vi.fn(
      async (_session: ImportSession, jobs: InitialFillJobRecord[]) => {
        publishedJobs.push(jobs);
      },
    );
    const archiveInitialFillJob = vi.fn(async () => undefined);
    const service = new ImportSessionService({
      repository,
      mailbox,
      normalizeAsset: async () => asset(),
      verifyAsset: async () => undefined,
      defaultPreferenceSeed: "Clean-session default image preferences",
      publishInitialFillJobs,
      archiveInitialFillJob,
      createId: () => ids[index++],
      now: () => timestamp,
    });

    const first = await service.retryInitialFill(
      "import-session-1",
      "failed-attempt-1",
      "retry-request-1",
    );
    const duplicate = await service.retryInitialFill(
      "import-session-1",
      "failed-attempt-1",
      "retry-request-1",
    );

    expect(first.initialFill.pending).toBe(3);
    expect(duplicate).toEqual(first);
    expect(publishInitialFillJobs).toHaveBeenCalledOnce();
    expect(publishedJobs[0]?.map(({ id }) => id)).toEqual([
      "replacement-job-1",
      "replacement-job-2",
      "replacement-job-3",
    ]);
    expect(archiveInitialFillJob).toHaveBeenCalledWith("failed-job-1");
    const saved = await repository.load();
    expect(saved?.initialFillRetry).toMatchObject({
      failedAttemptId: "failed-attempt-1",
      requestId: "retry-request-1",
      replacementAttemptId: "replacement-attempt-1",
    });
    await expect(
      service.retryInitialFill(
        "import-session-1",
        "failed-attempt-1",
        "another-request",
      ),
    ).rejects.toBeInstanceOf(ImportSessionConflictError);
  });
});
