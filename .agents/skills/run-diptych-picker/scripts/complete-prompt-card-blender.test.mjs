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
  "complete-prompt-card-blender.mjs",
);
const activeJob = {
  id: "blender-1",
  kind: "prompt-card-blender",
  createdAt: "2026-07-21T20:00:00.000Z",
  cards: [
    {
      id: "card-1",
      title: "Copper nocturne",
      prompt: "A severe copper-lit industrial editorial portrait.",
      negativePrompt: "readable text",
      tags: ["portrait", "copper"],
    },
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
const proposal = {
  title: "Copper glasshouse",
  prompt:
    "A copper-lit editorial portrait inside a translucent botanical glasshouse.",
  negativePrompt: "readable text, hard shadows",
  tags: ["portrait", "copper", "botanical", "glass"],
  reasoningSummary: "Balances the two immutable source directions.",
};

test("publishes one strict prompt-card blend proposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "diptych-card-blender-"));
  const active = join(root, "agent-mailbox", "active");
  await mkdir(active, { recursive: true });
  await writeFile(
    join(active, `${activeJob.id}.json`),
    `${JSON.stringify(activeJob, null, 2)}\n`,
  );
  const suggestionPath = join(root, "suggestion.json");
  await writeFile(suggestionPath, `${JSON.stringify({ proposal }, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [script, "--job", activeJob.id, "--suggestion-file", suggestionPath],
    { cwd: process.cwd(), env: { ...process.env, LOCAL_DATA_DIR: root } },
  );

  const result = JSON.parse(
    await readFile(
      join(root, "agent-mailbox", "completed", `${activeJob.id}.json`),
      "utf8",
    ),
  );
  assert.deepEqual(result.cardIds, ["card-1", "card-2"]);
  assert.deepEqual(result.proposal, proposal);
});
