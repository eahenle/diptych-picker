#!/usr/bin/env node

import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  atomicCreateJson,
  claimUnleasedJob,
  dataDirectory,
  JOB_ID,
  leaseRecoveryState,
  parseArgs,
  readJsonIfExists,
  releaseExpiredJobLease,
  validateJobKind,
} from "./protocol-utils.mjs";

const args = parseArgs(process.argv.slice(2), ["resume"]);
const waitMs = Number(args["wait-ms"] ?? 0);
const batchId = args.batch;
const ownerToken = args["owner-token"];
const resume = args.resume === true;
const maxRefills = Number(args["max-refills"] ?? 1);
if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30_000) {
  throw new Error("--wait-ms must be an integer from 0 through 30000");
}
if (batchId !== undefined && !JOB_ID.test(batchId)) {
  throw new Error("--batch must be a valid initial batch ID");
}
if (batchId !== undefined && !JOB_ID.test(ownerToken ?? "")) {
  throw new Error("--owner-token is required with --batch");
}
if (ownerToken !== undefined && batchId === undefined) {
  throw new Error("--owner-token may only be used with --batch");
}
if (!Number.isInteger(maxRefills) || maxRefills < 1 || maxRefills > 3) {
  throw new Error("--max-refills must be an integer from 1 through 3");
}
if (batchId !== undefined && args["max-refills"] !== undefined) {
  throw new Error("--max-refills may not be used with --batch");
}

const mailbox = join(dataDirectory(), "agent-mailbox");
const pending = join(mailbox, "pending");
const active = join(mailbox, "active");
const batches = join(mailbox, "batches");
await Promise.all(
  [
    pending,
    active,
    batches,
    join(mailbox, "completed"),
    join(mailbox, "failed"),
  ].map((directory) => mkdir(directory, { recursive: true })),
);

if (batchId) await assertBatchOwner(batchId, ownerToken);

const deadline = Date.now() + waitMs;
while (true) {
  const claimed = await findNextJob();
  if (claimed) {
    process.stdout.write(`${JSON.stringify(claimed)}\n`);
    break;
  }
  if (Date.now() >= deadline) break;
  await new Promise((resolve) =>
    setTimeout(resolve, Math.min(100, deadline - Date.now())),
  );
}

async function findNextJob() {
  const pendingJobs = await listJobs(pending);

  if (batchId) {
    const activeJobs = await withTerminalResults(await listJobs(active));
    return findBatchPartner(
      await prepareBatchEntries(activeJobs),
      pendingJobs,
      batchId,
      ownerToken,
    );
  }

  if (resume) {
    const activeJobs = await withTerminalResults(await listJobs(active));
    const unterminatedActive = recoverableEntries(activeJobs, true).sort(
      compareJobs,
    );
    const activePriority = unterminatedActive.find(({ job }) =>
      isInteractiveSingle(job),
    );
    if (activePriority) {
      const [prepared] = await prepareRecoverableEntries([activePriority], 1);
      if (prepared) return presentForOwner(prepared);
    }
    const activeAnnotations = await prepareRecoverableEntries(
      unterminatedActive.filter(({ job }) => isImportAnnotation(job)),
      maxRefills,
    );
    if (activeAnnotations.length > 0) {
      return presentImportAnnotationBatch(activeAnnotations);
    }
    const activeInitialImportFill = await prepareRecoverableEntries(
      unterminatedActive.filter(({ job }) => isInitialImportFill(job)),
      maxRefills,
    );
    if (activeInitialImportFill.length > 0) {
      return presentInitialImportFillBatch(activeInitialImportFill);
    }
    const activeCachedAnalysis = unterminatedActive.find(({ job }) =>
      isCachedAnalysis(job),
    );
    if (activeCachedAnalysis) {
      const [prepared] = await prepareRecoverableEntries(
        [activeCachedAnalysis],
        1,
      );
      if (prepared) return presentForOwner(prepared);
    }
    const activeRefills = await prepareRecoverableEntries(
      unterminatedActive.filter(({ job }) => isRefill(job)),
      maxRefills,
    );
    if (activeRefills.length > 0) {
      return presentRefillBatch(activeRefills);
    }

    for (const entry of pendingJobs.sort(compareJobs)) {
      if (!isInitial(entry.job)) continue;
      const ownership = await readBatchOwnership(entry.job.batchId);
      if (!ownership) continue;
      const claimed = await claim(entry);
      if (claimed) return present(claimed, ownership.ownerToken);
    }
  } else {
    const activeJobs = await withTerminalResults(await listJobs(active));
    const expiredActive = recoverableEntries(activeJobs, false).sort(
      compareJobs,
    );
    const expiredPriority = expiredActive.find(({ job }) =>
      isInteractiveSingle(job),
    );
    if (expiredPriority) {
      const [prepared] = await prepareRecoverableEntries([expiredPriority], 1);
      if (prepared) return presentForOwner(prepared);
    }
    const expiredAnnotations = await prepareRecoverableEntries(
      expiredActive.filter(({ job }) => isImportAnnotation(job)),
      maxRefills,
    );
    if (expiredAnnotations.length > 0) {
      return presentImportAnnotationBatch(expiredAnnotations);
    }
    const expiredInitialImportFill = await prepareRecoverableEntries(
      expiredActive.filter(({ job }) => isInitialImportFill(job)),
      maxRefills,
    );
    if (expiredInitialImportFill.length > 0) {
      return presentInitialImportFillBatch(expiredInitialImportFill);
    }
    const expiredCachedAnalysis = expiredActive.find(({ job }) =>
      isCachedAnalysis(job),
    );
    if (expiredCachedAnalysis) {
      const [prepared] = await prepareRecoverableEntries(
        [expiredCachedAnalysis],
        1,
      );
      if (prepared) return presentForOwner(prepared);
    }
    const expiredRefills = await prepareRecoverableEntries(
      expiredActive.filter(({ job }) => isRefill(job)),
      maxRefills,
    );
    if (expiredRefills.length > 0) {
      return presentRefillBatch(expiredRefills);
    }
  }
  const orderedPending = pendingJobs.sort(compareJobs);
  for (const entry of orderedPending.filter(({ job }) =>
    isInteractiveSingle(job),
  )) {
    if (isInitial(entry.job)) {
      const ownership = await acquireBatchOwnership(entry.job.batchId);
      if (!ownership) continue;
      const claimed = await claim(entry);
      if (claimed) return present(claimed, ownership.ownerToken);
      continue;
    }
    const claimed = await claim(entry);
    if (claimed) return present(claimed);
  }
  const annotations = await claimImportAnnotationBatch(
    orderedPending.filter(({ job }) => isImportAnnotation(job)),
  );
  if (annotations) return annotations;
  const initialImportFill = await claimInitialImportFillBatch(
    orderedPending.filter(({ job }) => isInitialImportFill(job)),
  );
  if (initialImportFill) return initialImportFill;
  for (const entry of orderedPending.filter(({ job }) =>
    isCachedAnalysis(job),
  )) {
    const claimed = await claim(entry);
    if (claimed) return present(claimed);
  }
  return claimRefillBatch(orderedPending.filter(({ job }) => isRefill(job)));
}

async function claimImportAnnotationBatch(entries) {
  const claimed = [];
  for (const entry of entries) {
    if (claimed.length === maxRefills) break;
    const annotation = await claim(entry);
    if (annotation) claimed.push(annotation);
  }
  return claimed.length > 0 ? presentImportAnnotationBatch(claimed) : null;
}

async function claimRefillBatch(entries) {
  const claimed = [];
  for (const entry of entries) {
    if (claimed.length === maxRefills) break;
    const refill = await claim(entry);
    if (refill) claimed.push(refill);
  }
  return claimed.length > 0 ? presentRefillBatch(claimed) : null;
}

async function claimInitialImportFillBatch(entries) {
  const claimed = [];
  for (const entry of entries) {
    if (claimed.length === maxRefills) break;
    const fill = await claim(entry);
    if (fill) claimed.push(fill);
  }
  return claimed.length > 0 ? presentInitialImportFillBatch(claimed) : null;
}

async function findBatchPartner(
  activeJobs,
  pendingJobs,
  batch,
  batchOwnerToken,
) {
  const activeBatch = activeJobs
    .filter((entry) => isInitialBatch(entry.job, batch))
    .sort(compareJobs);
  const pendingBatch = pendingJobs
    .filter((entry) => isInitialBatch(entry.job, batch))
    .sort(compareJobs);

  const terminalPartner = activeBatch.find(
    ({ terminalResult }) => terminalResult !== null,
  );
  const unfinishedActive = activeBatch.filter(
    ({ terminalResult }) => terminalResult === null,
  );

  if (terminalPartner && unfinishedActive.length > 0) {
    return present(
      terminalPartner,
      batchOwnerToken,
      terminalPartner.terminalResult.status,
    );
  }
  if (unfinishedActive.length >= 2) {
    const partner =
      unfinishedActive.find((entry) => entry.job.initialSide === "right") ??
      unfinishedActive[1];
    return present(partner, batchOwnerToken);
  }
  if (activeBatch.length === 1) {
    const partnerSide =
      activeBatch[0].job.initialSide === "left" ? "right" : "left";
    const partner = pendingBatch.find(
      (entry) => entry.job.initialSide === partnerSide,
    );
    const claimed = partner ? await claim(partner) : null;
    if (claimed) return present(claimed, batchOwnerToken);
    if (terminalPartner) {
      return present(
        terminalPartner,
        batchOwnerToken,
        terminalPartner.terminalResult.status,
      );
    }
    return null;
  }
  for (const entry of pendingBatch) {
    const claimed = await claim(entry);
    if (claimed) return present(claimed, batchOwnerToken);
  }
  return null;
}

async function withTerminalResults(entries) {
  return Promise.all(
    entries.map(async (entry) => {
      const terminal = await terminalResult(entry.job.id);
      const outcomeReservation =
        terminal === null
          ? await readJsonIfExists(
              join(mailbox, "outcomes", `${entry.job.id}.json`),
            )
          : null;
      return {
        ...entry,
        terminalResult: terminal,
        outcomeReservation,
        leaseState:
          terminal === null
            ? await leaseRecoveryState(mailbox, entry.job.id)
            : "terminal",
      };
    }),
  );
}

function recoverableEntries(entries, includeUnleased) {
  return entries.filter(
    (entry) =>
      entry.terminalResult === null &&
      entry.outcomeReservation === null &&
      (entry.leaseState === "expired" ||
        (includeUnleased && entry.leaseState === "unleased")),
  );
}

async function prepareRecoverableEntries(entries, limit) {
  const prepared = [];
  for (const entry of entries) {
    if (prepared.length === limit) break;
    if (
      entry.leaseState === "expired" &&
      !(await releaseExpiredJobLease(mailbox, entry.job.id))
    ) {
      continue;
    }
    prepared.push({ ...entry, leaseState: "unleased" });
  }
  return prepared;
}

async function prepareBatchEntries(entries) {
  const prepared = entries.filter(
    (entry) =>
      entry.terminalResult !== null ||
      (entry.outcomeReservation === null && entry.leaseState === "unleased"),
  );
  const expired = entries.filter(
    (entry) =>
      entry.terminalResult === null &&
      entry.outcomeReservation === null &&
      entry.leaseState === "expired",
  );
  return [
    ...prepared,
    ...(await prepareRecoverableEntries(expired, Number.POSITIVE_INFINITY)),
  ];
}

async function terminalResult(jobId) {
  const [completed, failed] = await Promise.all([
    readJsonIfExists(join(mailbox, "completed", `${jobId}.json`)),
    readJsonIfExists(join(mailbox, "failed", `${jobId}.json`)),
  ]);
  if (completed && failed) {
    throw new Error(`Job ${jobId} has both completed and failed results`);
  }
  return completed ?? failed;
}

async function listJobs(directory) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  return Promise.all(
    entries.map(async (filename) => {
      const id = filename.slice(0, -".json".length);
      if (!JOB_ID.test(id)) throw new Error(`Invalid job filename ${filename}`);
      let contents;
      try {
        contents = await readFile(join(directory, filename), "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
      const parsed = JSON.parse(contents);
      if (!parsed || parsed.id !== id) {
        throw new Error(`Job ${id} contains another job ID`);
      }
      validateJobKind(parsed);
      return { filename, contents, job: parsed };
    }),
  ).then((jobs) => jobs.filter(Boolean));
}

async function claim(entry) {
  return (await claimUnleasedJob(
    mailbox,
    join(pending, entry.filename),
    join(active, entry.filename),
    entry.job.id,
  ))
    ? entry
    : null;
}

function compareJobs(left, right) {
  const leftRank = priorityRank(left.job);
  const rightRank = priorityRank(right.job);
  const leftCreatedAt = Date.parse(left.job.createdAt ?? "");
  const rightCreatedAt = Date.parse(right.job.createdAt ?? "");
  const ageOrder =
    (Number.isFinite(leftCreatedAt)
      ? leftCreatedAt
      : Number.POSITIVE_INFINITY) -
    (Number.isFinite(rightCreatedAt)
      ? rightCreatedAt
      : Number.POSITIVE_INFINITY);
  return (
    leftRank - rightRank ||
    ageOrder ||
    left.filename.localeCompare(right.filename)
  );
}

function priorityRank(job) {
  if (job.kind === "initial" && job.initialSide === "left") return 0;
  if (job.kind === "source-profile") return 1;
  if (job.kind === "prompt-card-editor") return 3;
  if (job.kind === "prompt-card-blender") return 3;
  if (job.kind === "prompt-card-writer") return 3;
  if (job.kind === "import-annotation") return 4;
  if (job.kind === "initial-import-fill") return 5;
  if (job.kind === "leaderboard-profile") return 6;
  if (job.kind === "refill") return 7;
  return 2;
}

function isInteractiveSingle(job) {
  return (
    !isImportAnnotation(job) &&
    !isInitialImportFill(job) &&
    !isCachedAnalysis(job) &&
    !isRefill(job)
  );
}

function isImportAnnotation(job) {
  return job.kind === "import-annotation";
}

function isInitialImportFill(job) {
  return job.kind === "initial-import-fill";
}

function isCachedAnalysis(job) {
  return job.kind === "leaderboard-profile";
}

function isInitialBatch(job, batch) {
  return job.kind === "initial" && job.batchId === batch;
}

function isInitial(job) {
  return job.kind === "initial";
}

function isRefill(job) {
  return job.kind === "refill";
}

function present(entry, batchOwnerToken, terminalStatus) {
  return {
    ...entry.job,
    ...(batchOwnerToken ? { batchOwnerToken } : {}),
    ...(terminalStatus ? { terminalStatus } : {}),
  };
}

function presentRefillBatch(entries) {
  return { kind: "refill-batch", jobs: entries.map((entry) => present(entry)) };
}

function presentImportAnnotationBatch(entries) {
  return {
    kind: "import-annotation-batch",
    jobs: entries.map((entry) => present(entry)),
  };
}

function presentInitialImportFillBatch(entries) {
  return {
    kind: "initial-import-fill-batch",
    jobs: entries.map((entry) => present(entry)),
  };
}

async function presentForOwner(entry) {
  if (!isInitial(entry.job)) return present(entry);
  const ownership = await ensureBatchOwnership(entry.job.batchId);
  return present(entry, ownership.ownerToken);
}

async function acquireBatchOwnership(batch) {
  const ownership = {
    batchId: batch,
    ownerToken: crypto.randomUUID(),
    acquiredAt: new Date().toISOString(),
  };
  return (await atomicCreateJson(batchOwnershipPath(batch), ownership))
    ? ownership
    : null;
}

async function ensureBatchOwnership(batch) {
  const existing = await readBatchOwnership(batch);
  if (existing) return existing;
  const acquired = await acquireBatchOwnership(batch);
  return acquired ?? readBatchOwnership(batch);
}

async function assertBatchOwner(batch, token) {
  const ownership = await readBatchOwnership(batch);
  if (!ownership || ownership.ownerToken !== token) {
    throw new Error(`Invalid owner token for initial batch ${batch}`);
  }
}

async function readBatchOwnership(batch) {
  const ownership = await readJsonIfExists(batchOwnershipPath(batch));
  if (!ownership) return null;
  if (ownership.batchId !== batch || !JOB_ID.test(ownership.ownerToken ?? "")) {
    throw new Error(`Invalid ownership record for initial batch ${batch}`);
  }
  return ownership;
}

function batchOwnershipPath(batch) {
  return join(batches, `${batch}.json`);
}
