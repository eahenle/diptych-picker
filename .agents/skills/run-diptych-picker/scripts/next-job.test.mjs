import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const script = join(dirname(fileURLToPath(import.meta.url)), "next-job.mjs");

const candidate = (id) => ({
  id,
  imageUrl: `/api/assets/${id}.png`,
  prompt: `${id} prompt`,
  concept: `${id} concept`,
  style: ["cinematic"],
  createdAt: "2026-07-16T00:00:00.000Z",
  winCount: 0,
});

function challenger(id, createdAt = "2026-07-16T01:00:00.000Z") {
  return {
    id,
    kind: "challenger",
    createdAt,
    roundNumber: 3,
    winnerSide: "left",
    retainedWinner: candidate("left"),
    rejectedCandidate: candidate("right"),
    selectionHistory: [],
    recentConcepts: [],
    preferenceSeed: "industrial and strange",
  };
}

function refill(id, createdAt) {
  return {
    ...challenger(id, createdAt),
    kind: "refill",
    sessionId: "session-1",
    pinnedWinnerId: "left",
  };
}

function initial(id, batchId, initialSide, createdAt) {
  return {
    ...challenger(id, createdAt),
    kind: "initial",
    batchId,
    initialSide,
  };
}

function sourceProfile(id, createdAt) {
  return {
    id,
    kind: "source-profile",
    createdAt,
    sourceImage: {
      filename: `${"a".repeat(64)}.png`,
      path: `profile-sources/${"a".repeat(64)}.png`,
      contentType: "image/png",
      width: 100,
      height: 80,
      byteLength: 1024,
    },
  };
}

function importAnnotation(id, createdAt) {
  return {
    id,
    kind: "import-annotation",
    createdAt,
    importSessionId: "import-session-1",
    importItemId: `item-${id}`,
    asset: {
      digest: "c".repeat(64),
      filename: `${"c".repeat(64)}.png`,
      url: `/api/assets/${"c".repeat(64)}.png`,
      contentType: "image/png",
      width: 1024,
      height: 1024,
      byteLength: 2048,
    },
  };
}

function leaderboardProfile(id, createdAt) {
  return {
    id,
    kind: "leaderboard-profile",
    createdAt,
    fingerprint: "b".repeat(64),
    sources: [1, 2].map((rank) => ({
      candidateId: `leader-${rank}`,
      rank,
      rating: 1100 - rank * 10,
      wins: 4 - rank,
      losses: rank,
      favorite: rank === 1,
      source: "generated",
      concept: `leader ${rank} concept`,
      style: ["cinematic"],
      sourceImage: {
        filename: `${String(rank).repeat(64)}.png`,
        path: `profile-sources/${String(rank).repeat(64)}.png`,
        contentType: "image/png",
        width: 100,
        height: 100,
        byteLength: 1024,
      },
    })),
  };
}

function promptCardEditor(id, createdAt) {
  return {
    id,
    kind: "prompt-card-editor",
    createdAt,
    card: {
      id: "card-1",
      title: "Copper nocturne",
      prompt: "A severe copper-lit industrial editorial portrait.",
      negativePrompt: "readable text",
      tags: ["portrait", "copper"],
    },
    recentRejections: Array.from({ length: 4 }, (_, index) => ({
      resultId: `rejected-${index + 1}`,
      reason: "Selected comparison winner",
      recordedAt: `2026-07-16T00:00:0${index}.000Z`,
    })),
  };
}

function promptCardBlender(id, createdAt) {
  return {
    id,
    kind: "prompt-card-blender",
    createdAt,
    cards: [
      promptCardEditor("unused", createdAt).card,
      {
        id: "card-2",
        title: "Glass botany",
        prompt: "Translucent botanical structures in soft green daylight.",
        negativePrompt: "hard shadows",
        tags: ["botanical", "glass"],
      },
    ],
    ratio: 0.5,
  };
}

function promptCardWriter(id, createdAt) {
  return {
    id,
    kind: "prompt-card-writer",
    createdAt,
    sources: ["favorite-1", "favorite-2", "favorite-3"].map(
      (candidateId, index) => ({
        candidateId,
        concept: `${candidateId} concept`,
        style: ["editorial"],
        sourceImage: {
          filename: `${String(index + 1).repeat(64)}.png`,
          path: `profile-sources/${String(index + 1).repeat(64)}.png`,
          contentType: "image/png",
          width: 100,
          height: 100,
          byteLength: 1024,
        },
      }),
    ),
  };
}

async function dataRoot() {
  return mkdtemp(join(tmpdir(), "diptych-next-job-"));
}

async function put(root, directory, job) {
  const target = join(root, "agent-mailbox", directory);
  await mkdir(target, { recursive: true });
  await writeFile(
    join(target, `${job.id}.json`),
    `${JSON.stringify(job, null, 2)}\n`,
    "utf8",
  );
}

async function run(root, args = []) {
  return execFileAsync(process.execPath, [script, "--wait-ms", "0", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, LOCAL_DATA_DIR: root },
  });
}

test("claims at most three refill jobs oldest-first", async () => {
  const root = await dataRoot();
  await Promise.all([
    put(root, "pending", refill("newest", "2026-07-16T01:00:04.000Z")),
    put(root, "pending", refill("oldest", "2026-07-16T01:00:01.000Z")),
    put(root, "pending", refill("middle", "2026-07-16T01:00:03.000Z")),
    put(root, "pending", refill("second", "2026-07-16T01:00:02.000Z")),
  ]);

  const { stdout } = await run(root, ["--max-refills", "3"]);

  assert.deepEqual(JSON.parse(stdout), {
    kind: "refill-batch",
    jobs: [
      refill("oldest", "2026-07-16T01:00:01.000Z"),
      refill("second", "2026-07-16T01:00:02.000Z"),
      refill("middle", "2026-07-16T01:00:03.000Z"),
    ],
  });
  assert.deepEqual(await readdir(join(root, "agent-mailbox", "active")), [
    "middle.json",
    "oldest.json",
    "second.json",
  ]);
  assert.deepEqual(await readdir(join(root, "agent-mailbox", "pending")), [
    "newest.json",
  ]);
});

test("never claims more refills than the requested worker limit", async () => {
  const root = await dataRoot();
  await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      put(
        root,
        "pending",
        refill(`refill-${index + 1}`, `2026-07-16T01:00:0${index}.000Z`),
      ),
    ),
  );

  const { stdout } = await run(root, ["--max-refills", "2"]);

  assert.equal(JSON.parse(stdout).jobs.length, 2);
  assert.equal(
    (await readdir(join(root, "agent-mailbox", "pending"))).length,
    2,
  );
});

test("returns one ordinary challenger before any refill batch", async () => {
  const root = await dataRoot();
  await put(
    root,
    "pending",
    refill("older-refill", "2026-07-16T01:00:00.000Z"),
  );
  await put(
    root,
    "pending",
    challenger("selection", "2026-07-16T01:00:10.000Z"),
  );

  const { stdout } = await run(root, ["--max-refills", "3"]);

  assert.equal(JSON.parse(stdout).id, "selection");
  await assert.doesNotReject(() =>
    readFile(
      join(root, "agent-mailbox", "pending", "older-refill.json"),
      "utf8",
    ),
  );
});

test("claims the three oldest import annotations as one interactive batch before cached analysis and refills", async () => {
  const root = await dataRoot();
  await Promise.all([
    put(root, "pending", refill("older-refill", "2026-08-09T18:00:00.000Z")),
    put(
      root,
      "pending",
      leaderboardProfile("leaderboard-1", "2026-08-09T18:00:01.000Z"),
    ),
    put(
      root,
      "pending",
      importAnnotation("annotation-3", "2026-08-09T18:00:04.000Z"),
    ),
    put(
      root,
      "pending",
      importAnnotation("annotation-1", "2026-08-09T18:00:02.000Z"),
    ),
    put(
      root,
      "pending",
      importAnnotation("annotation-2", "2026-08-09T18:00:03.000Z"),
    ),
  ]);

  const { stdout } = await run(root, ["--max-refills", "3"]);
  const claim = JSON.parse(stdout);

  assert.equal(claim.kind, "import-annotation-batch");
  assert.deepEqual(
    claim.jobs.map(({ id }) => id),
    ["annotation-1", "annotation-2", "annotation-3"],
  );
  assert.deepEqual(await readdir(join(root, "agent-mailbox", "active")), [
    "annotation-1.json",
    "annotation-2.json",
    "annotation-3.json",
  ]);
});

test("prioritizes an interactive source-profile analysis before refills", async () => {
  const root = await dataRoot();
  await put(
    root,
    "pending",
    refill("older-refill", "2026-07-16T01:00:00.000Z"),
  );
  await put(
    root,
    "pending",
    sourceProfile("source-profile-1", "2026-07-16T01:00:10.000Z"),
  );

  const { stdout } = await run(root, ["--max-refills", "3"]);

  assert.deepEqual(
    JSON.parse(stdout),
    sourceProfile("source-profile-1", "2026-07-16T01:00:10.000Z"),
  );
  await assert.doesNotReject(() =>
    readFile(
      join(root, "agent-mailbox", "pending", "older-refill.json"),
      "utf8",
    ),
  );
});

test("prioritizes prompt-card editor work before cached analysis and refills", async () => {
  const root = await dataRoot();
  await Promise.all([
    put(root, "pending", refill("older-refill", "2026-07-16T01:00:00.000Z")),
    put(
      root,
      "pending",
      leaderboardProfile("leaderboard-1", "2026-07-16T01:00:01.000Z"),
    ),
    put(
      root,
      "pending",
      promptCardEditor("editor-1", "2026-07-16T01:00:02.000Z"),
    ),
  ]);

  const { stdout } = await run(root, ["--max-refills", "3"]);

  assert.deepEqual(
    JSON.parse(stdout),
    promptCardEditor("editor-1", "2026-07-16T01:00:02.000Z"),
  );
});

test("prioritizes prompt-card blender work before cached analysis and refills", async () => {
  const root = await dataRoot();
  const blend = promptCardBlender("blender-1", "2026-07-16T01:00:02.000Z");
  await Promise.all([
    put(root, "pending", refill("older-refill", "2026-07-16T01:00:00.000Z")),
    put(
      root,
      "pending",
      leaderboardProfile("leaderboard-1", "2026-07-16T01:00:01.000Z"),
    ),
    put(root, "pending", blend),
  ]);

  const { stdout } = await run(root, ["--max-refills", "3"]);

  assert.deepEqual(JSON.parse(stdout), blend);
});

test("prioritizes prompt-card writer work before cached analysis and refills", async () => {
  const root = await dataRoot();
  const writer = promptCardWriter("writer-1", "2026-07-16T01:00:02.000Z");
  await Promise.all([
    put(root, "pending", refill("older-refill", "2026-07-16T01:00:00.000Z")),
    put(
      root,
      "pending",
      leaderboardProfile("leaderboard-1", "2026-07-16T01:00:01.000Z"),
    ),
    put(root, "pending", writer),
  ]);

  const { stdout } = await run(root, ["--max-refills", "3"]);

  assert.deepEqual(JSON.parse(stdout), writer);
});

test("prioritizes interactive source analysis before cached leaderboard analysis", async () => {
  const root = await dataRoot();
  await put(
    root,
    "pending",
    leaderboardProfile("leaderboard-profile-1", "2026-07-16T01:00:00.000Z"),
  );
  await put(
    root,
    "pending",
    sourceProfile("source-profile-1", "2026-07-16T01:00:10.000Z"),
  );

  const { stdout } = await run(root, ["--max-refills", "3"]);

  assert.equal(JSON.parse(stdout).id, "source-profile-1");
});

test("prioritizes cached leaderboard analysis before refills", async () => {
  const root = await dataRoot();
  await put(
    root,
    "pending",
    refill("older-refill", "2026-07-16T01:00:00.000Z"),
  );
  const analysis = leaderboardProfile(
    "leaderboard-profile-1",
    "2026-07-16T01:00:10.000Z",
  );
  await put(root, "pending", analysis);

  const { stdout } = await run(root, ["--max-refills", "3"]);

  assert.deepEqual(JSON.parse(stdout), analysis);
  await assert.doesNotReject(() =>
    readFile(
      join(root, "agent-mailbox", "pending", "older-refill.json"),
      "utf8",
    ),
  );
});

test("keeps an owned initial partner out of ordinary and refill claims", async () => {
  const root = await dataRoot();
  const left = initial(
    "initial-left",
    "batch-1",
    "left",
    "2026-07-16T01:00:00.000Z",
  );
  const right = initial(
    "initial-right",
    "batch-1",
    "right",
    "2026-07-16T01:00:00.000Z",
  );
  await Promise.all([
    put(root, "pending", left),
    put(root, "pending", right),
    put(root, "pending", refill("refill-1", "2026-07-16T01:00:01.000Z")),
  ]);

  const first = JSON.parse((await run(root, ["--max-refills", "3"])).stdout);
  const ordinary = JSON.parse((await run(root, ["--max-refills", "3"])).stdout);
  const partner = JSON.parse(
    (
      await run(root, [
        "--batch",
        "batch-1",
        "--owner-token",
        first.batchOwnerToken,
      ])
    ).stdout,
  );

  assert.equal(first.id, "initial-left");
  assert.deepEqual(ordinary, {
    kind: "refill-batch",
    jobs: [refill("refill-1", "2026-07-16T01:00:01.000Z")],
  });
  assert.equal(partner.id, "initial-right");
  assert.equal(partner.batchOwnerToken, first.batchOwnerToken);
});

test("resume returns a bounded batch of unfinished active refills", async () => {
  const root = await dataRoot();
  await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      put(
        root,
        "active",
        refill(`active-${index + 1}`, `2026-07-16T01:00:0${index}.000Z`),
      ),
    ),
  );

  const { stdout } = await run(root, ["--resume", "--max-refills", "3"]);

  assert.deepEqual(
    JSON.parse(stdout).jobs.map(({ id }) => id),
    ["active-1", "active-2", "active-3"],
  );
});

test("rejects refill limits outside the coordinator concurrency bound", async () => {
  const root = await dataRoot();
  await assert.rejects(run(root, ["--max-refills", "4"]), /max-refills/i);
});
