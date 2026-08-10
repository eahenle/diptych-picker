import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "complete-import-annotation.mjs",
);
const job = {
  id: "annotation-1",
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
};
const annotation = {
  concept: "Copper observatory",
  prompt: "A copper radio observatory under a dark coastal sky.",
  style: ["cinematic landscape", "copper and blue"],
  reasoningSummary:
    "Describes visible subject, composition, and palette without identity claims.",
  source: "manual",
};

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "diptych-import-annotation-"));
  const active = join(root, "agent-mailbox", "active");
  await mkdir(active, { recursive: true });
  await writeFile(join(active, `${job.id}.json`), `${JSON.stringify(job)}\n`);
  return root;
}

async function run(root, value) {
  const annotationPath = join(root, "annotation.json");
  await writeFile(annotationPath, `${JSON.stringify(value)}\n`);
  return execFileAsync(
    process.execPath,
    [script, "--job", job.id, "--annotation-file", annotationPath],
    { cwd: process.cwd(), env: { ...process.env, LOCAL_DATA_DIR: root } },
  );
}

test("rejects invalid annotation before reserving an outcome", async () => {
  const root = await setup();

  await assert.rejects(() => run(root, { ...annotation, style: [] }));
  await assert.rejects(() =>
    readFile(join(root, "agent-mailbox", "outcomes", `${job.id}.json`)),
  );
});

test("forces automated source and safely repeats the same completion", async () => {
  const root = await setup();

  await run(root, annotation);
  await run(root, annotation);

  const result = JSON.parse(
    await readFile(
      join(root, "agent-mailbox", "completed", `${job.id}.json`),
      "utf8",
    ),
  );
  assert.equal(result.annotation.source, "automated");
  assert.equal(result.asset, undefined);
  assert.equal(result.imageBytes, undefined);
});
