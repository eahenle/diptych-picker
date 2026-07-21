import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const JOB_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function dataDirectory() {
  return resolve(process.cwd(), process.env.LOCAL_DATA_DIR ?? ".local-data");
}

export function exportDirectory() {
  if (process.env.NODE_ENV === "test") {
    return join(dataDirectory(), "exports");
  }
  return resolve(process.cwd(), "output", "artifacts");
}

export function parseArgs(values, booleanNames = []) {
  const parsed = {};
  const booleans = new Set(booleanNames);
  for (let index = 0; index < values.length;) {
    const key = values[index];
    if (!key?.startsWith("--")) {
      throw new Error(`Invalid argument near ${key ?? "end of command"}`);
    }
    const name = key.slice(2);
    if (booleans.has(name)) {
      parsed[name] = true;
      index += 1;
      continue;
    }
    const value = values[index + 1];
    if (value === undefined) {
      throw new Error(`Invalid argument near ${key ?? "end of command"}`);
    }
    parsed[name] = value;
    index += 2;
  }
  return parsed;
}

export function required(values, name) {
  const value = values[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

export async function assertActiveJob(mailbox, jobId) {
  const path = join(mailbox, "active", `${jobId}.json`);
  const active = await readJson(path, `No active job ${jobId}`);
  if (!active || active.id !== jobId) {
    throw new Error(`Active job ${jobId} contains another job ID`);
  }
  validateJobKind(active);
  return active;
}

export function validateJobKind(job) {
  const kind = job.kind ?? "challenger";
  if (kind === "challenger") return;
  if (kind === "source-profile") {
    if (
      !job.sourceImage ||
      !/^[a-f0-9]{64}\.png$/.test(job.sourceImage.filename ?? "") ||
      job.sourceImage.path !== `profile-sources/${job.sourceImage.filename}` ||
      job.sourceImage.contentType !== "image/png" ||
      !Number.isInteger(job.sourceImage.width) ||
      !Number.isInteger(job.sourceImage.height) ||
      !Number.isInteger(job.sourceImage.byteLength)
    ) {
      throw new Error(
        `Source-profile job ${job.id} has invalid image metadata`,
      );
    }
    return;
  }
  if (kind === "refill") {
    if (!JOB_ID.test(job.sessionId ?? "")) {
      throw new Error(`Refill job ${job.id} requires a valid sessionId`);
    }
    if (
      typeof job.pinnedWinnerId !== "string" ||
      job.pinnedWinnerId.length === 0 ||
      job.pinnedWinnerId !== job.retainedWinner?.id
    ) {
      throw new Error(
        `Refill job ${job.id} requires pinnedWinnerId to match retainedWinner.id`,
      );
    }
    return;
  }
  if (kind !== "initial") throw new Error(`Unsupported job kind ${kind}`);
  if (!JOB_ID.test(job.batchId ?? "")) {
    throw new Error(`Initial job ${job.id} requires a valid batchId`);
  }
  if (job.initialSide !== "left" && job.initialSide !== "right") {
    throw new Error(`Initial job ${job.id} requires initialSide left or right`);
  }
}

export async function reserveOutcome(mailbox, jobId, outcome) {
  const opposite = outcome === "completed" ? "failed" : "completed";
  const oppositeResult = await readJsonIfExists(
    join(mailbox, opposite, `${jobId}.json`),
  );
  if (oppositeResult) {
    throw new Error(`Job ${jobId} already published the ${opposite} outcome`);
  }

  const path = join(mailbox, "outcomes", `${jobId}.json`);
  const reservation = {
    jobId,
    outcome,
    reservedAt: new Date().toISOString(),
  };
  const created = await atomicCreateJson(path, reservation);
  const recorded = created ? reservation : await readJson(path);
  if (
    recorded.jobId !== jobId ||
    (recorded.outcome !== "completed" && recorded.outcome !== "failed")
  ) {
    throw new Error(`Invalid outcome reservation for job ${jobId}`);
  }
  if (recorded.outcome !== outcome) {
    throw new Error(
      `Job ${jobId} reserved the ${recorded.outcome} outcome; cannot publish ${outcome}`,
    );
  }
  return recorded;
}

export async function publishTerminal(mailbox, jobId, outcome, result) {
  const destination = join(mailbox, outcome, `${jobId}.json`);
  if (await atomicCreateJson(destination, result)) return result;
  const existing = await readJson(destination);
  if (existing.jobId !== jobId || existing.status !== outcome) {
    throw new Error(`Invalid existing ${outcome} result for job ${jobId}`);
  }
  return existing;
}

export async function hasTerminalResult(mailbox, jobId) {
  const [completed, failed] = await Promise.all([
    readJsonIfExists(join(mailbox, "completed", `${jobId}.json`)),
    readJsonIfExists(join(mailbox, "failed", `${jobId}.json`)),
  ]);
  if (completed && failed) {
    throw new Error(`Job ${jobId} has both completed and failed results`);
  }
  return Boolean(completed ?? failed);
}

export async function atomicCreateJson(destination, value) {
  return atomicCreateFile(
    destination,
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
  );
}

export async function atomicCreateFile(destination, contents) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = join(
    dirname(destination),
    `.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  await writeFile(temporary, contents, { flag: "wx" });
  try {
    await link(temporary, destination);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readJson(path, missingMessage) {
  const value = await readJsonIfExists(path);
  if (value === null) throw new Error(missingMessage ?? `Missing ${path}`);
  return value;
}
