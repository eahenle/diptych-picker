import {
  chmod,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const JOB_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
export const CHANNEL_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
export const LEASE_TOKEN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MIN_LEASE_MS = 10_000;
export const MAX_LEASE_MS = 600_000;
const LEASE_LOCK_TIMEOUT_MS = 5_000;
const STALE_LEASE_LOCK_MS = 30_000;

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

export async function assertActiveJob(mailbox, jobId, leaseToken) {
  return withJobLeaseLock(mailbox, jobId, async () => {
    const active = await readActiveJob(mailbox, jobId);
    const reservation = await readJsonIfExists(
      join(mailbox, "outcomes", `${jobId}.json`),
    );
    if (reservation) {
      assertOutcomeReservation(
        reservation,
        jobId,
        reservation.outcome,
        leaseToken,
      );
      return active;
    }
    await assertLeaseOwnership(mailbox, jobId, leaseToken);
    return active;
  });
}

export function validateJobKind(job) {
  const kind = job.kind ?? "challenger";
  if (kind === "challenger") return;
  if (kind === "source-profile") {
    if (!validProfileSource(job.sourceImage)) {
      throw new Error(
        `Source-profile job ${job.id} has invalid image metadata`,
      );
    }
    return;
  }
  if (kind === "leaderboard-profile") {
    const sources = job.sources;
    if (
      !/^[a-f0-9]{64}$/.test(job.fingerprint ?? "") ||
      !Array.isArray(sources) ||
      sources.length < 2 ||
      sources.length > 4 ||
      sources.some(
        (source) =>
          typeof source.candidateId !== "string" ||
          source.candidateId.length === 0 ||
          !Number.isInteger(source.rank) ||
          !validProfileSource(source.sourceImage),
      ) ||
      new Set(sources.map(({ candidateId }) => candidateId)).size !==
        sources.length ||
      new Set(sources.map(({ rank }) => rank)).size !== sources.length
    ) {
      throw new Error(
        `Leaderboard-profile job ${job.id} has invalid source metadata`,
      );
    }
    return;
  }
  if (kind === "prompt-card-editor") {
    if (
      !job.card ||
      typeof job.card.id !== "string" ||
      typeof job.card.title !== "string" ||
      typeof job.card.prompt !== "string" ||
      job.card.prompt.trim().length < 20 ||
      !Array.isArray(job.recentRejections) ||
      job.recentRejections.length < 4 ||
      job.recentRejections.length > 12
    ) {
      throw new Error(`Prompt-card editor job ${job.id} is invalid`);
    }
    return;
  }
  if (kind === "prompt-card-blender") {
    if (
      !Array.isArray(job.cards) ||
      job.cards.length !== 2 ||
      new Set(job.cards.map((card) => card?.id)).size !== 2 ||
      job.cards.some(
        (card) =>
          !card ||
          typeof card.id !== "string" ||
          typeof card.title !== "string" ||
          typeof card.prompt !== "string" ||
          card.prompt.trim().length < 20 ||
          !Array.isArray(card.tags),
      ) ||
      typeof job.ratio !== "number" ||
      job.ratio < 0.1 ||
      job.ratio > 0.9
    ) {
      throw new Error(`Prompt-card blender job ${job.id} is invalid`);
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

function validProfileSource(sourceImage) {
  return Boolean(
    sourceImage &&
    /^[a-f0-9]{64}\.png$/.test(sourceImage.filename ?? "") &&
    sourceImage.path === `profile-sources/${sourceImage.filename}` &&
    sourceImage.contentType === "image/png" &&
    Number.isInteger(sourceImage.width) &&
    sourceImage.width > 0 &&
    sourceImage.width <= 4096 &&
    Number.isInteger(sourceImage.height) &&
    sourceImage.height > 0 &&
    sourceImage.height <= 4096 &&
    Number.isInteger(sourceImage.byteLength) &&
    sourceImage.byteLength > 0,
  );
}

export async function reserveOutcome(mailbox, jobId, outcome, leaseToken) {
  return withJobLeaseLock(mailbox, jobId, async () => {
    const opposite = outcome === "completed" ? "failed" : "completed";
    const oppositeResult = await readJsonIfExists(
      join(mailbox, opposite, `${jobId}.json`),
    );
    if (oppositeResult) {
      throw new Error(`Job ${jobId} already published the ${opposite} outcome`);
    }

    const path = join(mailbox, "outcomes", `${jobId}.json`);
    const existing = await readJsonIfExists(path);
    if (existing) {
      assertOutcomeReservation(existing, jobId, outcome, leaseToken);
      return existing;
    }

    await readActiveJob(mailbox, jobId);
    await assertLeaseOwnership(mailbox, jobId, leaseToken);
    const reservation = {
      jobId,
      outcome,
      reservedAt: new Date().toISOString(),
      ...(leaseToken ? { leaseToken } : {}),
    };
    const created = await atomicCreateJson(path, reservation);
    const recorded = created ? reservation : await readJson(path);
    assertOutcomeReservation(recorded, jobId, outcome, leaseToken);
    return recorded;
  });
}

function assertOutcomeReservation(recorded, jobId, outcome, leaseToken) {
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
  if ((recorded.leaseToken ?? undefined) !== (leaseToken ?? undefined)) {
    throw new Error(`Job ${jobId} outcome is owned by another lease`);
  }
}

export function leaseDuration(value) {
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_LEASE_MS ||
    parsed > MAX_LEASE_MS
  ) {
    throw new Error(
      `Lease duration must be an integer from ${MIN_LEASE_MS} through ${MAX_LEASE_MS}`,
    );
  }
  return parsed;
}

export async function claimJobLease(
  mailbox,
  jobId,
  channel,
  token,
  durationMs,
) {
  if (!JOB_ID.test(jobId)) throw new Error("Invalid generation job ID");
  if (!CHANNEL_NAME.test(channel)) throw new Error("Invalid co-proc channel");
  if (!LEASE_TOKEN.test(token)) throw new Error("Invalid lease token");
  const validatedDuration = leaseDuration(durationMs);

  return withJobLeaseLock(mailbox, jobId, async () => {
    if (await hasTerminalResult(mailbox, jobId)) {
      throw new Error(`Job ${jobId} is already terminal`);
    }
    const existing = await readJobLease(mailbox, jobId);
    const activePath = join(mailbox, "active", `${jobId}.json`);
    const pendingPath = join(mailbox, "pending", `${jobId}.json`);
    if (existing) {
      if (
        existing.token === token &&
        existing.channel === channel &&
        !leaseExpired(existing)
      ) {
        await readActiveJob(mailbox, jobId);
        return existing;
      }
      if (!leaseExpired(existing)) {
        throw new Error(`Job ${jobId} already has a live lease`);
      }
      await expireJobLease(mailbox, existing);
    }
    if (await readJsonIfExists(activePath)) {
      throw new Error(`Job ${jobId} is already active without this lease`);
    }
    const pendingJob = await readJson(
      pendingPath,
      `No pending job ${jobId} to lease`,
    );
    if (pendingJob.id !== jobId) {
      throw new Error(`Pending job ${jobId} contains another job ID`);
    }
    validateJobKind(pendingJob);

    const now = new Date();
    const lease = {
      version: 1,
      jobId,
      channel,
      token,
      claimedAt: now.toISOString(),
      renewedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + validatedDuration).toISOString(),
    };
    const leasePath = jobLeasePath(mailbox, jobId);
    await mkdir(dirname(leasePath), { recursive: true, mode: 0o700 });
    await chmod(dirname(leasePath), 0o700);
    if (!(await atomicCreateJson(leasePath, lease, { mode: 0o600 }))) {
      throw new Error(`Job ${jobId} lease appeared during claim`);
    }
    try {
      await mkdir(dirname(activePath), { recursive: true });
      await rename(pendingPath, activePath);
    } catch (error) {
      await rm(leasePath, { force: true });
      throw error;
    }
    return lease;
  });
}

export async function renewJobLease(mailbox, jobId, token, durationMs) {
  if (!JOB_ID.test(jobId)) throw new Error("Invalid generation job ID");
  if (!LEASE_TOKEN.test(token)) throw new Error("Invalid lease token");
  const validatedDuration = leaseDuration(durationMs);

  return withJobLeaseLock(mailbox, jobId, async () => {
    await readActiveJob(mailbox, jobId);
    if (await hasTerminalResult(mailbox, jobId)) {
      throw new Error(`Job ${jobId} is already terminal`);
    }
    const existing = await readJobLease(mailbox, jobId);
    if (!existing || existing.token !== token) {
      throw new Error(`Job ${jobId} is owned by another lease`);
    }
    if (leaseExpired(existing)) {
      throw new Error(`Job ${jobId} lease has expired`);
    }
    const now = new Date();
    const renewed = {
      ...existing,
      renewedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + validatedDuration).toISOString(),
    };
    await writeJsonAtomic(jobLeasePath(mailbox, jobId), renewed);
    return renewed;
  });
}

export async function claimUnleasedJob(
  mailbox,
  pendingPath,
  activePath,
  jobId,
) {
  return withJobLeaseLock(mailbox, jobId, async () => {
    const lease = await readJobLease(mailbox, jobId);
    if (lease && !leaseExpired(lease)) return false;
    if (lease) await expireJobLease(mailbox, lease);
    try {
      await rename(pendingPath, activePath);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  });
}

export async function leaseRecoveryState(mailbox, jobId) {
  return withJobLeaseLock(mailbox, jobId, async () => {
    const lease = await readJobLease(mailbox, jobId);
    if (!lease) return "unleased";
    if (!leaseExpired(lease)) return "live";
    return "expired";
  });
}

export async function releaseExpiredJobLease(mailbox, jobId) {
  return withJobLeaseLock(mailbox, jobId, async () => {
    const lease = await readJobLease(mailbox, jobId);
    if (!lease || !leaseExpired(lease)) return false;
    await expireJobLease(mailbox, lease);
    return true;
  });
}

export async function readJobLease(mailbox, jobId) {
  const lease = await readJsonIfExists(jobLeasePath(mailbox, jobId));
  if (!lease) return null;
  if (
    lease.version !== 1 ||
    lease.jobId !== jobId ||
    !CHANNEL_NAME.test(lease.channel ?? "") ||
    !LEASE_TOKEN.test(lease.token ?? "") ||
    !validTimestamp(lease.claimedAt) ||
    !validTimestamp(lease.renewedAt) ||
    !validTimestamp(lease.expiresAt) ||
    Date.parse(lease.expiresAt) <= Date.parse(lease.renewedAt)
  ) {
    throw new Error(`Invalid lease record for job ${jobId}`);
  }
  return lease;
}

async function assertLeaseOwnership(mailbox, jobId, leaseToken) {
  const lease = await readJobLease(mailbox, jobId);
  if (!lease) {
    if (leaseToken) {
      throw new Error(`Job ${jobId} has no matching lease`);
    }
    return;
  }
  if (leaseExpired(lease)) {
    throw new Error(`Job ${jobId} lease has expired`);
  }
  if (!leaseToken || lease.token !== leaseToken) {
    throw new Error(`Job ${jobId} is owned by another lease`);
  }
}

async function readActiveJob(mailbox, jobId) {
  const path = join(mailbox, "active", `${jobId}.json`);
  const active = await readJson(path, `No active job ${jobId}`);
  if (!active || active.id !== jobId) {
    throw new Error(`Active job ${jobId} contains another job ID`);
  }
  validateJobKind(active);
  return active;
}

function leaseExpired(lease, now = Date.now()) {
  return Date.parse(lease.expiresAt) <= now;
}

async function expireJobLease(mailbox, lease) {
  const expiredDirectory = join(mailbox, "expired-leases");
  await mkdir(expiredDirectory, { recursive: true, mode: 0o700 });
  await chmod(expiredDirectory, 0o700);
  await rename(
    jobLeasePath(mailbox, lease.jobId),
    join(expiredDirectory, `${lease.jobId}.${lease.token}.json`),
  ).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function jobLeasePath(mailbox, jobId) {
  return join(mailbox, "leases", `${jobId}.json`);
}

function validTimestamp(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    value === new Date(value).toISOString()
  );
}

async function withJobLeaseLock(mailbox, jobId, operation) {
  const lockRoot = join(mailbox, "lease-locks");
  const lockPath = join(lockRoot, `${jobId}.lock`);
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  await chmod(lockRoot, 0o700);
  const deadline = Date.now() + LEASE_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const lockStat = await stat(lockPath).catch((statError) => {
        if (statError.code === "ENOENT") return null;
        throw statError;
      });
      if (lockStat && Date.now() - lockStat.mtimeMs > STALE_LEASE_LOCK_MS) {
        const stalePath = `${lockPath}.${crypto.randomUUID()}.stale`;
        try {
          await rename(lockPath, stalePath);
          await rm(stalePath, { recursive: true, force: true });
          continue;
        } catch (renameError) {
          if (renameError.code !== "ENOENT") throw renameError;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring lease lock for job ${jobId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function writeJsonAtomic(destination, value) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = join(
    dirname(destination),
    `.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
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

export async function atomicCreateJson(destination, value, options) {
  return atomicCreateFile(
    destination,
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
    options,
  );
}

export async function atomicCreateFile(destination, contents, options) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = join(
    dirname(destination),
    `.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  await writeFile(temporary, contents, { flag: "wx", ...options });
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
