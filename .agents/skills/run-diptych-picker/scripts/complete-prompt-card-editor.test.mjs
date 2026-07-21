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
  "complete-prompt-card-editor.mjs",
);

const activeJob = {
  id: "editor-1",
  kind: "prompt-card-editor",
  createdAt: "2026-07-21T20:00:00.000Z",
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
    recordedAt: `2026-07-21T19:00:0${index}.000Z`,
  })),
};

const proposals = ["focused", "oblique"].map((treatment) => ({
  title: `Copper nocturne — ${treatment}`,
  prompt: `A ${treatment} copper-lit industrial editorial portrait.`,
  negativePrompt: "readable text",
  tags: ["portrait", "copper"],
  reasoningSummary: `Responds to rejection with a ${treatment} treatment.`,
}));

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "diptych-card-editor-"));
  const active = join(root, "agent-mailbox", "active");
  await mkdir(active, { recursive: true });
  await writeFile(
    join(active, `${activeJob.id}.json`),
    `${JSON.stringify(activeJob, null, 2)}\n`,
  );
  return root;
}

async function run(root, value) {
  const suggestionsPath = join(root, "suggestions.json");
  await writeFile(
    suggestionsPath,
    `${JSON.stringify({ proposals: value }, null, 2)}\n`,
  );
  return execFileAsync(
    process.execPath,
    [script, "--job", activeJob.id, "--suggestions-file", suggestionsPath],
    { cwd: process.cwd(), env: { ...process.env, LOCAL_DATA_DIR: root } },
  );
}

test("publishes exactly two distinct prompt-card proposals", async () => {
  const root = await setup();

  await run(root, proposals);

  const result = JSON.parse(
    await readFile(
      join(root, "agent-mailbox", "completed", `${activeJob.id}.json`),
      "utf8",
    ),
  );
  assert.equal(result.cardId, activeJob.card.id);
  assert.deepEqual(result.proposals, proposals);
});

test("rejects duplicate prompt-card proposals before reserving an outcome", async () => {
  const root = await setup();

  await assert.rejects(() => run(root, [proposals[0], proposals[0]]));
  await assert.rejects(() =>
    readFile(
      join(root, "agent-mailbox", "outcomes", `${activeJob.id}.json`),
      "utf8",
    ),
  );
});
