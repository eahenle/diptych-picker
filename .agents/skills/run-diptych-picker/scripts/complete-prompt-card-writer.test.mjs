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
  "complete-prompt-card-writer.mjs",
);
const sourceImage = {
  filename: `${"a".repeat(64)}.png`,
  path: `profile-sources/${"a".repeat(64)}.png`,
  contentType: "image/png",
  width: 1024,
  height: 1024,
  byteLength: 2048,
};
const activeJob = {
  id: "writer-1",
  kind: "prompt-card-writer",
  createdAt: "2026-07-21T20:00:00.000Z",
  sources: ["favorite-1", "favorite-2", "favorite-3"].map((candidateId) => ({
    candidateId,
    concept: `${candidateId} concept`,
    style: ["editorial"],
    sourceImage,
  })),
};
const proposal = {
  title: "Favorite synthesis",
  prompt:
    "A new editorial direction synthesizing the shared light, scale, and tactile material qualities.",
  negativePrompt: "exact copies, readable text, logos",
  tags: ["editorial", "tactile"],
  reasoningSummary:
    "Extracts shared transferable qualities without copying any source.",
};

test("publishes one strict prompt-card writer proposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "diptych-card-writer-"));
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
  assert.deepEqual(result.sourceCandidateIds, [
    "favorite-1",
    "favorite-2",
    "favorite-3",
  ]);
  assert.deepEqual(result.proposal, proposal);
});
