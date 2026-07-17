#!/usr/bin/env node

import { mkdir, readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  atomicCreateJson,
  dataDirectory,
  JOB_ID,
  parseArgs,
  readJsonIfExists,
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
    return findBatchPartner(activeJobs, pendingJobs, batchId, ownerToken);
  }

  if (resume) {
    const activeJobs = await withTerminalResults(await listJobs(active));
    const unterminatedActive = activeJobs
      .filter(({ terminalResult }) => terminalResult === null)
      .sort(compareJobs);
    const activePriority = unterminatedActive.find(({ job }) => !isRefill(job));
    if (activePriority) {
      return presentForOwner(activePriority);
    }
    const activeRefills = unterminatedActive
      .filter(({ job }) => isRefill(job))
      .slice(0, maxRefills);
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
  }
  const orderedPending = pendingJobs.sort(compareJobs);
  for (const entry of orderedPending.filter(({ job }) => !isRefill(job))) {
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
  return claimRefillBatch(orderedPending.filter(({ job }) => isRefill(job)));
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
    entries.map(async (entry) => ({
      ...entry,
      terminalResult: await terminalResult(entry.job.id),
    })),
  );
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
  try {
    await rename(join(pending, entry.filename), join(active, entry.filename));
    return entry;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function compareJobs(left, right) {
  const leftRank =
    left.job.kind === "initial" && left.job.initialSide === "left" ? 0 : 1;
  const rightRank =
    right.job.kind === "initial" && right.job.initialSide === "left" ? 0 : 1;
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
