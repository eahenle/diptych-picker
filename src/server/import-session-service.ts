import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  GenerationResult,
  InitialImportFillMailbox,
  InitialImportFillJob,
  ImportAnnotationJob,
  ImportAnnotationMailbox,
  ImportAnnotationResult,
} from "./agent-mailbox";
import {
  parseImportedCandidateAnnotation,
  type ImportedAssetMetadata,
  type ImportedCandidateAnnotation,
  type ImportItem,
  type ImportSession,
  type InitialFillJobRecord,
} from "@/domain/import-session";
import type { ImportSessionRepository } from "./import-session-repository";

const activationCandidateTarget = 5;
const annotationFailureMessage =
  "Automatic annotation failed. Retry, annotate manually, or remove this image.";
const initialFillFailureMessage =
  "One or more generated starter candidates failed. Retry the remaining initial fill.";

export class ImportSessionServiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

export class ImportSessionInputError extends ImportSessionServiceError {
  constructor(message: string) {
    super(message, 400);
  }
}

export class ImportSessionNotFoundError extends ImportSessionServiceError {
  constructor(message = "That image import is no longer available.") {
    super(message, 404);
  }
}

export class ImportSessionConflictError extends ImportSessionServiceError {
  constructor(message: string) {
    super(message, 409);
  }
}

export interface ManualImportAnnotationInput {
  concept: string;
  prompt: string;
  style: string[];
}

export interface ImportSessionItemStatus {
  id: string;
  status: ImportItem["status"];
  asset: {
    url: string;
    width: number;
    height: number;
  };
  annotation: ImportedCandidateAnnotation | null;
  candidateId: string | null;
  failureMessage: string | null;
  approvedAt: string;
}

export interface DisplaySafeImportSessionStatus {
  sessionId: string;
  status: ImportSession["status"];
  createdAt: string;
  sealedAt: string | null;
  activatedAt: string | null;
  activationTarget: number;
  activationReady: number;
  counts: {
    total: number;
    annotating: number;
    ready: number;
    failed: number;
    removed: number;
    served: number;
  };
  items: ImportSessionItemStatus[];
  initialFill: {
    pending: number;
    ready: number;
    failed: number;
    failedAttemptId: string | null;
    failureMessage: string | null;
  };
}

interface ImportSessionServiceOptions {
  repository: ImportSessionRepository;
  mailbox: ImportAnnotationMailbox;
  normalizeAsset(contents: Uint8Array): Promise<ImportedAssetMetadata>;
  verifyAsset(asset: ImportedAssetMetadata): Promise<void>;
  initialFillMailbox?: InitialImportFillMailbox;
  defaultPreferenceSeed?: string;
  verifyGeneratedAsset?: (
    asset: Extract<GenerationResult, { status: "completed" }>["asset"],
  ) => Promise<void>;
  publishInitialFillJobs?: (
    session: ImportSession,
    jobs: InitialFillJobRecord[],
  ) => Promise<void>;
  archiveInitialFillJob?: (jobId: string) => Promise<void>;
  createId?: () => string;
  now?: () => string;
}

interface AnnotationObservation {
  expected: ImportAnnotationJob;
  work: ImportAnnotationJob | null;
  result: ImportAnnotationResult | null;
}

interface InitialFillObservation {
  expected: InitialImportFillJob;
  work: InitialImportFillJob | null;
  result: GenerationResult | null;
}

export class ImportSessionService {
  private readonly createId: () => string;
  private readonly now: () => string;

  constructor(private readonly options: ImportSessionServiceOptions) {
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async createOrResume(): Promise<DisplaySafeImportSessionStatus> {
    const existing = await this.options.repository.load();
    if (existing && existing.status !== "completed") {
      return this.status(existing.id);
    }

    const session = await this.options.repository.withLock(async () => {
      const current = await this.options.repository.load();
      if (current && current.status !== "completed") return current;
      const created: ImportSession = {
        version: 1,
        id: this.createId(),
        status: "editing",
        createdAt: this.now(),
        sealedAt: null,
        activatedAt: null,
        items: [],
        initialFillJobs: [],
        initialFillRetry: null,
        servedReceipts: [],
      };
      await this.options.repository.save(created);
      return created;
    });
    return displaySafeStatus(session);
  }

  async status(sessionId?: string): Promise<DisplaySafeImportSessionStatus> {
    const current = await this.requireSession(sessionId);
    const reconciled = await this.reconcileAnnotations(current.id);
    return displaySafeStatus(reconciled);
  }

  async approve(
    sessionId: string,
    contents: Uint8Array,
  ): Promise<DisplaySafeImportSessionStatus> {
    if (contents.byteLength === 0) {
      throw new ImportSessionInputError("Choose one normalized PNG image.");
    }
    const asset = await this.options.normalizeAsset(contents);
    await this.options.verifyAsset(asset);
    const createdAt = this.now();
    const itemId = this.createId();
    const jobId = this.createId();

    return this.mutate(sessionId, (session, effects) => {
      if (session.status !== "editing") {
        throw new ImportSessionConflictError(
          "This image import is sealed and cannot accept more images.",
        );
      }
      const duplicate = session.items.find(
        (item) =>
          item.status !== "removed" && item.normalizedDigest === asset.digest,
      );
      if (duplicate) {
        throw new ImportSessionConflictError(
          `That normalized image already exists as import item ${duplicate.id}.`,
        );
      }

      const annotationJob: ImportAnnotationJob = {
        id: jobId,
        kind: "import-annotation",
        createdAt,
        importSessionId: session.id,
        importItemId: itemId,
        asset,
      };
      const item: ImportItem = {
        id: itemId,
        normalizedDigest: asset.digest,
        status: "annotating",
        asset,
        annotationJob,
        annotation: null,
        candidateId: null,
        failureMessage: null,
        approvedAt: createdAt,
        readyAt: null,
        servedAt: null,
      };
      const updated = { ...session, items: [...session.items, item] };
      effects.push(() => this.ensureAnnotationPublished(annotationJob));
      return updated;
    });
  }

  async seal(sessionId: string): Promise<DisplaySafeImportSessionStatus> {
    return this.mutate(sessionId, (session) => {
      if (session.status === "preparing") return session;
      if (session.status !== "editing") {
        throw new ImportSessionConflictError(
          "Only an editing image import can be sealed.",
        );
      }
      return {
        ...session,
        status: "preparing",
        sealedAt: this.now(),
      };
    });
  }

  async pause(sessionId: string): Promise<DisplaySafeImportSessionStatus> {
    const session = await this.requireSession(sessionId);
    if (session.status === "editing") {
      throw new ImportSessionConflictError(
        "Finish or remove every browser image before pausing this import.",
      );
    }
    return this.status(session.id);
  }

  async retry(
    sessionId: string,
    itemId: string,
  ): Promise<DisplaySafeImportSessionStatus> {
    const createdAt = this.now();
    const replacementJobId = this.createId();
    return this.mutate(sessionId, (session, effects) => {
      const item = requireItem(session, itemId);
      if (item.status !== "failed" || !item.annotationJob) {
        throw new ImportSessionConflictError(
          "Only a failed automatic annotation can be retried.",
        );
      }
      const oldJobId = item.annotationJob.id;
      const annotationJob: ImportAnnotationJob = {
        id: replacementJobId,
        kind: "import-annotation",
        createdAt,
        importSessionId: session.id,
        importItemId: item.id,
        asset: item.asset,
      };
      const updated = replaceItem(session, {
        ...item,
        status: "annotating",
        annotationJob,
        annotation: null,
        candidateId: null,
        failureMessage: null,
        readyAt: null,
        servedAt: null,
      });
      effects.push(
        () => this.options.mailbox.archiveImportAnnotation(oldJobId),
        () => this.ensureAnnotationPublished(annotationJob),
      );
      return updated;
    });
  }

  async annotateManually(
    sessionId: string,
    itemId: string,
    input: ManualImportAnnotationInput,
  ): Promise<DisplaySafeImportSessionStatus> {
    const readyAt = this.now();
    let annotation: ImportedCandidateAnnotation;
    try {
      annotation = parseImportedCandidateAnnotation({
        ...input,
        reasoningSummary: "Provided manually during image import.",
        source: "manual",
      });
    } catch {
      throw new ImportSessionInputError(
        "Manual annotation requires a concept, description, and one through eight unique style tags.",
      );
    }

    return this.mutate(sessionId, (session, effects) => {
      const item = requireItem(session, itemId);
      if (item.status !== "failed" || !item.annotationJob) {
        throw new ImportSessionConflictError(
          "Only a failed automatic annotation can be completed manually.",
        );
      }
      const oldJobId = item.annotationJob.id;
      const updated = replaceItem(session, {
        ...item,
        status: "ready",
        annotationJob: null,
        annotation,
        candidateId: importedCandidateId(session.id, item.id),
        failureMessage: null,
        readyAt,
        servedAt: null,
      });
      effects.push(() =>
        this.options.mailbox.archiveImportAnnotation(oldJobId),
      );
      return updated;
    });
  }

  async remove(
    sessionId: string,
    itemId: string,
  ): Promise<DisplaySafeImportSessionStatus> {
    return this.mutate(sessionId, (session, effects) => {
      const item = requireItem(session, itemId);
      if (item.status === "served") {
        throw new ImportSessionConflictError(
          "An imported candidate that has already been served cannot be removed.",
        );
      }
      if (item.status === "removed") return session;
      if (item.annotationJob) {
        effects.push(() =>
          this.options.mailbox.archiveImportAnnotation(item.annotationJob!.id),
        );
      }
      return replaceItem(session, {
        ...item,
        status: "removed",
        annotationJob: null,
        annotation: null,
        candidateId: null,
        failureMessage: null,
        readyAt: null,
        servedAt: null,
      });
    });
  }

  async retryInitialFill(
    sessionId: string,
    failedAttemptId: string,
    requestId: string,
  ): Promise<DisplaySafeImportSessionStatus> {
    if (!failedAttemptId || !requestId) {
      throw new ImportSessionInputError(
        "A failed attempt and retry request ID are required.",
      );
    }
    return this.mutate(sessionId, (session, effects) => {
      const existing = session.initialFillRetry;
      if (existing) {
        if (
          existing.failedAttemptId === failedAttemptId &&
          existing.requestId === requestId
        ) {
          return session;
        }
        throw new ImportSessionConflictError(
          "That initial-fill attempt is no longer current.",
        );
      }
      const failedJobs = session.initialFillJobs.filter(
        (job) => job.attemptId === failedAttemptId && job.status === "failed",
      );
      if (failedJobs.length === 0) {
        throw new ImportSessionConflictError(
          "That initial-fill attempt is no longer current.",
        );
      }
      const readyCount =
        session.items.filter((item) => item.status === "ready").length +
        session.initialFillJobs.filter((job) => job.status === "ready").length;
      const deficit = Math.max(0, activationCandidateTarget - readyCount);
      if (deficit === 0) {
        throw new ImportSessionConflictError(
          "The import already has enough candidates to activate.",
        );
      }
      const replacementAttemptId = this.createId();
      const createdAt = this.now();
      const replacements: InitialFillJobRecord[] = Array.from(
        { length: deficit },
        () => ({
          id: this.createId(),
          attemptId: replacementAttemptId,
          createdAt,
          preferenceSeed: this.defaultPreferenceSeed(),
          status: "pending" as const,
          candidate: null,
          source: "generated" as const,
          importItemId: null,
          failureMessage: null,
          completedAt: null,
        }),
      );
      const updated: ImportSession = {
        ...session,
        initialFillJobs: [
          ...session.initialFillJobs.map((job) =>
            job.attemptId === failedAttemptId && job.status === "failed"
              ? { ...job, status: "superseded" as const }
              : job,
          ),
          ...replacements,
        ],
        initialFillRetry: {
          failedAttemptId,
          requestId,
          replacementAttemptId,
          replacementJobIds: replacements.map(({ id }) => id),
          createdAt,
        },
      };
      for (const job of failedJobs) {
        if (this.options.archiveInitialFillJob) {
          effects.push(() => this.options.archiveInitialFillJob!(job.id));
        }
      }
      if (this.options.publishInitialFillJobs) {
        effects.push(() =>
          this.options.publishInitialFillJobs!(updated, replacements),
        );
      } else if (this.options.initialFillMailbox) {
        for (const job of replacements) {
          effects.push(() =>
            this.ensureInitialFillPublished(
              this.initialFillRequest(updated, job),
            ),
          );
        }
      }
      return updated;
    });
  }

  async abandon(sessionId: string): Promise<void> {
    const effects: Array<() => Promise<void>> = [];
    await this.options.repository.withLock(async () => {
      const session = await this.requireSessionInsideLock(sessionId);
      if (session.status === "active" || session.status === "completed") {
        throw new ImportSessionConflictError(
          "An activated image import cannot be abandoned.",
        );
      }
      for (const item of session.items) {
        if (item.annotationJob) {
          effects.push(() =>
            this.options.mailbox.archiveImportAnnotation(
              item.annotationJob!.id,
            ),
          );
        }
      }
      if (this.options.archiveInitialFillJob) {
        for (const job of session.initialFillJobs) {
          effects.push(() => this.options.archiveInitialFillJob!(job.id));
        }
      }
      await this.options.repository.clear();
    });
    await runEffects(effects);
  }

  async reconcileAnnotations(sessionId: string): Promise<ImportSession> {
    const preliminary = await this.requireSession(sessionId);
    const observations = new Map<string, AnnotationObservation>();
    for (const item of preliminary.items) {
      if (item.status !== "annotating" || !item.annotationJob) continue;
      const expected = item.annotationJob;
      const [work, result] = await Promise.all([
        this.options.mailbox.readImportAnnotationWork(expected.id),
        this.options.mailbox.readImportAnnotationResult(expected.id),
      ]);
      if (work && !isDeepStrictEqual(work, expected)) {
        throw new Error(
          `Import annotation job ${expected.id} does not match its durable request`,
        );
      }
      if (result?.status === "completed") {
        await this.options.verifyAsset(item.asset);
      }
      observations.set(expected.id, { expected, work, result });
    }

    const initialFillObservations = new Map<string, InitialFillObservation>();
    if (this.options.initialFillMailbox) {
      for (const job of preliminary.initialFillJobs) {
        if (job.status !== "pending") continue;
        const expected = this.initialFillRequest(preliminary, job);
        const [observedWork, result] = await Promise.all([
          this.options.initialFillMailbox.readInitialImportFillWork(job.id),
          this.options.initialFillMailbox.readInitialImportFillResult(job.id),
        ]);
        const work = observedWork;
        if (work && !isDeepStrictEqual(work, expected)) {
          throw new Error(
            `Initial import fill job ${expected.id} does not match its durable request`,
          );
        }
        if (result?.status === "completed") {
          await this.options.verifyGeneratedAsset?.(result.asset);
        }
        initialFillObservations.set(expected.id, { expected, work, result });
      }
    }

    const effects: Array<() => Promise<void>> = [];
    const updated = await this.options.repository.withLock(async () => {
      const current = await this.requireSessionInsideLock(sessionId);
      let changed = false;
      const items = current.items.map((item) => {
        if (item.status !== "annotating" || !item.annotationJob) return item;
        const observation = observations.get(item.annotationJob.id);
        if (
          !observation ||
          !isDeepStrictEqual(observation.expected, item.annotationJob)
        ) {
          return item;
        }
        if (!observation.result) {
          if (!observation.work) {
            effects.push(() =>
              this.ensureAnnotationPublished(item.annotationJob!),
            );
          }
          return item;
        }
        changed = true;
        effects.push(() =>
          this.options.mailbox.archiveImportAnnotation(item.annotationJob!.id),
        );
        if (observation.result.status === "failed") {
          return {
            ...item,
            status: "failed" as const,
            failureMessage: annotationFailureMessage,
          };
        }
        return {
          ...item,
          status: "ready" as const,
          annotationJob: null,
          annotation: observation.result.annotation,
          candidateId: importedCandidateId(current.id, item.id),
          failureMessage: null,
          readyAt: observation.result.completedAt,
          servedAt: null,
        };
      });

      const initialFillJobs = current.initialFillJobs.map((job) => {
        if (job.status !== "pending") return job;
        const observation = initialFillObservations.get(job.id);
        const expected = this.initialFillRequest(current, job);
        if (
          !observation ||
          !isDeepStrictEqual(observation.expected, expected)
        ) {
          return job;
        }
        if (!observation.result) {
          if (!observation.work) {
            effects.push(() => this.ensureInitialFillPublished(expected));
          }
          return job;
        }
        changed = true;
        effects.push(() => this.archiveInitialFillJob(job.id));
        if (
          observation.result.status === "failed" ||
          observation.result.proposal.preferenceRevision !== undefined
        ) {
          return {
            ...job,
            status: "failed" as const,
            candidate: null,
            failureMessage: initialFillFailureMessage,
            completedAt: observation.result.completedAt,
          };
        }
        return {
          ...job,
          status: "ready" as const,
          candidate: candidateFromInitialFill(observation.result),
          failureMessage: null,
          completedAt: observation.result.completedAt,
        };
      });

      let next: ImportSession = { ...current, items, initialFillJobs };
      const prepared = this.prepareInitialFill(next);
      if (prepared) {
        next = prepared.session;
        changed = true;
        if (this.options.publishInitialFillJobs) {
          effects.push(() =>
            this.options.publishInitialFillJobs!(next, prepared.jobs),
          );
        } else if (this.options.initialFillMailbox) {
          for (const job of prepared.jobs) {
            effects.push(() =>
              this.ensureInitialFillPublished(
                this.initialFillRequest(next, job),
              ),
            );
          }
        }
      }
      if (!changed) return current;
      await this.options.repository.save(next);
      return next;
    });
    await runEffects(effects);
    return updated;
  }

  private prepareInitialFill(
    session: ImportSession,
  ): { session: ImportSession; jobs: InitialFillJobRecord[] } | null {
    if (
      session.status !== "preparing" ||
      session.items.some(
        ({ status }) => status === "annotating" || status === "failed",
      ) ||
      session.initialFillJobs.length > 0
    ) {
      return null;
    }
    const readyCount = session.items.filter(
      ({ status }) => status === "ready",
    ).length;
    const deficit = Math.max(0, activationCandidateTarget - readyCount);
    if (deficit === 0) return null;

    const attemptId = this.createId();
    const createdAt = this.now();
    const preferenceSeed = this.defaultPreferenceSeed();
    const jobs: InitialFillJobRecord[] = Array.from(
      { length: deficit },
      () => ({
        id: this.createId(),
        attemptId,
        createdAt,
        preferenceSeed,
        status: "pending" as const,
        candidate: null,
        source: "generated" as const,
        importItemId: null,
        failureMessage: null,
        completedAt: null,
      }),
    );
    return {
      session: { ...session, initialFillJobs: jobs },
      jobs,
    };
  }

  private initialFillRequest(
    session: ImportSession,
    job: InitialFillJobRecord,
  ): InitialImportFillJob {
    return {
      id: job.id,
      kind: "initial-import-fill",
      createdAt: job.createdAt ?? session.sealedAt ?? session.createdAt,
      importSessionId: session.id,
      attemptId: job.attemptId,
      preferenceSeed: job.preferenceSeed ?? this.defaultPreferenceSeed(),
    };
  }

  private defaultPreferenceSeed(): string {
    const seed = this.options.defaultPreferenceSeed?.trim();
    if (!seed) {
      throw new Error(
        "Initial import fill requires a configured default preference seed",
      );
    }
    return seed;
  }

  private async ensureInitialFillPublished(
    job: InitialImportFillJob,
  ): Promise<void> {
    const mailbox = this.options.initialFillMailbox;
    if (!mailbox) return;
    const [work, result] = await Promise.all([
      mailbox.readInitialImportFillWork(job.id),
      mailbox.readInitialImportFillResult(job.id),
    ]);
    if (work) {
      if (!isDeepStrictEqual(work, job)) {
        throw new Error(
          `Initial import fill job ${job.id} does not match its durable request`,
        );
      }
      return;
    }
    if (result) return;
    await mailbox.enqueueInitialImportFill(job);
  }

  private async archiveInitialFillJob(jobId: string): Promise<void> {
    if (this.options.archiveInitialFillJob) {
      await this.options.archiveInitialFillJob(jobId);
      return;
    }
    await this.options.initialFillMailbox?.archiveInitialImportFill(jobId);
  }

  private async mutate(
    sessionId: string,
    operation: (
      session: ImportSession,
      effects: Array<() => Promise<void>>,
    ) => ImportSession,
  ): Promise<DisplaySafeImportSessionStatus> {
    const effects: Array<() => Promise<void>> = [];
    const updated = await this.options.repository.withLock(async () => {
      const session = await this.requireSessionInsideLock(sessionId);
      const next = operation(session, effects);
      if (next !== session) await this.options.repository.save(next);
      return next;
    });
    await runEffects(effects);
    return displaySafeStatus(updated);
  }

  private async ensureAnnotationPublished(
    job: ImportAnnotationJob,
  ): Promise<void> {
    const [work, result] = await Promise.all([
      this.options.mailbox.readImportAnnotationWork(job.id),
      this.options.mailbox.readImportAnnotationResult(job.id),
    ]);
    if (work) {
      if (!isDeepStrictEqual(work, job)) {
        throw new Error(
          `Import annotation job ${job.id} does not match its durable request`,
        );
      }
      return;
    }
    if (result) return;
    await this.options.mailbox.enqueueImportAnnotation(job);
  }

  private async requireSession(sessionId?: string): Promise<ImportSession> {
    const session = await this.options.repository.load();
    if (!session || (sessionId && session.id !== sessionId)) {
      throw new ImportSessionNotFoundError();
    }
    return session;
  }

  private async requireSessionInsideLock(
    sessionId: string,
  ): Promise<ImportSession> {
    return this.requireSession(sessionId);
  }
}

function requireItem(session: ImportSession, itemId: string): ImportItem {
  const item = session.items.find(({ id }) => id === itemId);
  if (!item) {
    throw new ImportSessionNotFoundError(
      "That imported image is no longer available.",
    );
  }
  return item;
}

function replaceItem(session: ImportSession, replacement: ImportItem) {
  return {
    ...session,
    items: session.items.map((item) =>
      item.id === replacement.id ? replacement : item,
    ),
  };
}

function importedCandidateId(sessionId: string, itemId: string): string {
  return `imported-${createHash("sha256")
    .update(JSON.stringify([sessionId, itemId]))
    .digest("hex")}`;
}

async function runEffects(effects: Array<() => Promise<void>>): Promise<void> {
  for (const effect of effects) await effect();
}

function candidateFromInitialFill(
  result: Extract<GenerationResult, { status: "completed" }>,
) {
  return {
    id: result.asset.candidateId,
    imageUrl: result.asset.imageUrl,
    prompt: result.proposal.visualPrompt,
    concept: result.proposal.concept,
    style: result.proposal.styleTags,
    createdAt: result.completedAt,
    winCount: 0,
    reasoningSummary: result.proposal.reasoningSummary,
  };
}

function displaySafeStatus(
  session: ImportSession,
): DisplaySafeImportSessionStatus {
  const counts = {
    total: session.items.length,
    annotating: 0,
    ready: 0,
    failed: 0,
    removed: 0,
    served: 0,
  };
  for (const item of session.items) counts[item.status] += 1;
  const initialFill = {
    pending: session.initialFillJobs.filter(
      ({ status }) => status === "pending",
    ).length,
    ready: session.initialFillJobs.filter(({ status }) => status === "ready")
      .length,
    failed: session.initialFillJobs.filter(({ status }) => status === "failed")
      .length,
    failedAttemptId:
      session.initialFillJobs.find(({ status }) => status === "failed")
        ?.attemptId ?? null,
    failureMessage: session.initialFillJobs.some(
      ({ status }) => status === "failed",
    )
      ? initialFillFailureMessage
      : null,
  };
  return {
    sessionId: session.id,
    status: session.status,
    createdAt: session.createdAt,
    sealedAt: session.sealedAt,
    activatedAt: session.activatedAt,
    activationTarget: activationCandidateTarget,
    activationReady: counts.ready + initialFill.ready,
    counts,
    items: session.items.map((item) => ({
      id: item.id,
      status: item.status,
      asset: {
        url: item.asset.url,
        width: item.asset.width,
        height: item.asset.height,
      },
      annotation: item.annotation,
      candidateId: item.candidateId,
      failureMessage: item.failureMessage,
      approvedAt: item.approvedAt,
    })),
    initialFill,
  };
}
