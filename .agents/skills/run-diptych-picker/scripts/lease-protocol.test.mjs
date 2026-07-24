import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scripts = dirname(fileURLToPath(import.meta.url));
const claimScript = join(scripts, "claim-lease.mjs");
const renewScript = join(scripts, "renew-lease.mjs");
const nextScript = join(scripts, "next-job.mjs");
const failScript = join(scripts, "fail-job.mjs");
const firstToken = "11111111-1111-4111-8111-111111111111";
const secondToken = "22222222-2222-4222-8222-222222222222";

const candidate = (id) => ({
  id,
  imageUrl: `/api/assets/${id}.png`,
  prompt: `${id} prompt`,
  concept: `${id} concept`,
  style: ["cinematic"],
  createdAt: "2026-07-24T00:00:00.000Z",
  winCount: 0,
});

const job = {
  id: "leased-refill",
  kind: "refill",
  createdAt: "2026-07-24T01:00:00.000Z",
  roundNumber: 2,
  winnerSide: "left",
  retainedWinner: candidate("winner"),
  rejectedCandidate: candidate("loser"),
  selectionHistory: [],
  recentConcepts: [],
  preferenceSeed: "precise and surprising",
  sessionId: "session-1",
  pinnedWinnerId: "winner",
};

async function setupPending() {
  const root = await mkdtemp(join(tmpdir(), "diptych-lease-"));
  const pending = join(root, "agent-mailbox", "pending");
  await mkdir(pending, { recursive: true });
  await writeFile(
    join(pending, `${job.id}.json`),
    `${JSON.stringify(job, null, 2)}\n`,
  );
  return root;
}

function run(root, script, args) {
  return execFileAsync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, LOCAL_DATA_DIR: root },
  });
}

async function claim(root, token = firstToken) {
  const { stdout } = await run(root, claimScript, [
    "--job",
    job.id,
    "--channel",
    "gen_a",
    "--lease-token",
    token,
    "--lease-ms",
    "10000",
  ]);
  return JSON.parse(stdout);
}

test("atomically claims one pending job and renews only its owner token", async () => {
  const root = await setupPending();

  const original = await claim(root);
  assert.equal(original.jobId, job.id);
  assert.equal(original.channel, "gen_a");
  assert.equal(original.token, firstToken);
  assert.deepEqual(await readdir(join(root, "agent-mailbox", "active")), [
    `${job.id}.json`,
  ]);
  await assert.rejects(
    readFile(join(root, "agent-mailbox", "pending", `${job.id}.json`)),
  );

  assert.deepEqual(await claim(root), original);
  await assert.rejects(() => claim(root, secondToken), /live lease/i);
  await assert.rejects(
    () =>
      run(root, renewScript, [
        "--job",
        job.id,
        "--lease-token",
        secondToken,
        "--lease-ms",
        "20000",
      ]),
    /another lease/i,
  );

  const { stdout } = await run(root, renewScript, [
    "--job",
    job.id,
    "--lease-token",
    firstToken,
    "--lease-ms",
    "20000",
  ]);
  const renewed = JSON.parse(stdout);
  assert.equal(renewed.token, original.token);
  assert.ok(Date.parse(renewed.expiresAt) > Date.parse(original.expiresAt));
});

test("keeps a live leased job away from mailbox recovery", async () => {
  const root = await setupPending();
  await claim(root);

  const { stdout } = await run(root, nextScript, [
    "--wait-ms",
    "0",
    "--resume",
    "--max-refills",
    "3",
  ]);

  assert.equal(stdout, "");
});

test("ordinary polling takes over an expired lease without restart", async () => {
  const root = await setupPending();
  const lease = await claim(root);
  const expired = {
    ...lease,
    claimedAt: "2026-07-24T01:00:00.000Z",
    renewedAt: "2026-07-24T01:00:00.000Z",
    expiresAt: "2026-07-24T01:00:10.000Z",
  };
  await writeFile(
    join(root, "agent-mailbox", "leases", `${job.id}.json`),
    `${JSON.stringify(expired, null, 2)}\n`,
  );

  const { stdout } = await run(root, nextScript, [
    "--wait-ms",
    "0",
    "--max-refills",
    "3",
  ]);

  assert.deepEqual(JSON.parse(stdout), {
    kind: "refill-batch",
    jobs: [job],
  });
  await assert.rejects(
    readFile(join(root, "agent-mailbox", "leases", `${job.id}.json`)),
  );
  assert.deepEqual(
    await readdir(join(root, "agent-mailbox", "expired-leases")),
    [`${job.id}.${lease.token}.json`],
  );
});

test("gates terminal outcome ownership on the durable lease token", async () => {
  const root = await setupPending();
  await claim(root);
  const failurePath = join(root, "failure.txt");
  await writeFile(failurePath, "worker could not complete\n");
  const baseArgs = [
    "--job",
    job.id,
    "--message-file",
    failurePath,
    "--category",
    "operational",
  ];

  await assert.rejects(() => run(root, failScript, baseArgs), /owned/i);
  await assert.rejects(
    () => run(root, failScript, [...baseArgs, "--lease-token", secondToken]),
    /owned/i,
  );
  await run(root, failScript, [...baseArgs, "--lease-token", firstToken]);

  const reservation = JSON.parse(
    await readFile(
      join(root, "agent-mailbox", "outcomes", `${job.id}.json`),
      "utf8",
    ),
  );
  assert.equal(reservation.leaseToken, firstToken);

  await rm(join(root, "agent-mailbox", "leases", `${job.id}.json`));
  await assert.doesNotReject(() =>
    run(root, failScript, [...baseArgs, "--lease-token", firstToken]),
  );
  await assert.rejects(
    () => run(root, failScript, [...baseArgs, "--lease-token", secondToken]),
    /another lease/i,
  );
});
