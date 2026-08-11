import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PromptCardWriterMailbox } from "./agent-mailbox";
import { PromptCardWriterService } from "./prompt-card-writer-service";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const mailbox: PromptCardWriterMailbox = {
  enqueuePromptCardWriter: async () => undefined,
  readPromptCardWriterWork: async () => null,
  readPromptCardWriterResult: async () => null,
  archivePromptCardWriter: async () => undefined,
};

describe("PromptCardWriterService", () => {
  it("normalizes private seed images and hashes trimmed text guidance", async () => {
    const root = await mkdtemp(join(tmpdir(), "prompt-card-writer-"));
    const service = new PromptCardWriterService({
      mailbox,
      sourceDirectory: root,
      readCandidateImage: async () => ({
        contents: PNG,
        contentType: "image/png",
      }),
    });

    const job = await service.prepareCustom(
      "writer-1",
      "2026-08-10T20:00:00.000Z",
      {
        guidance: "  Preserve cold monumental negative space.  ",
        images: [
          {
            filename: " reference.webp ",
            contents: PNG,
            contentType: "image/png",
          },
        ],
      },
    );

    expect(job).toMatchObject({
      kind: "prompt-card-writer",
      guidance: "Preserve cold monumental negative space.",
      sourceTextDigest: createHash("sha256")
        .update("Preserve cold monumental negative space.")
        .digest("hex"),
      sources: [
        {
          concept: "Seed image 1: reference.webp",
          style: [],
          sourceImage: { contentType: "image/png", width: 1, height: 1 },
        },
      ],
    });
    const source = job.sources[0]!.sourceImage;
    expect(await readFile(join(root, source.filename))).toHaveLength(
      source.byteLength,
    );
  });

  it("supports text-only writer jobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "prompt-card-writer-"));
    const service = new PromptCardWriterService({
      mailbox,
      sourceDirectory: root,
      readCandidateImage: async () => ({
        contents: PNG,
        contentType: "image/png",
      }),
    });

    const job = await service.prepareCustom("writer-2", "now", {
      guidance: "A quiet ultraviolet architectural nocturne.",
      images: [],
    });

    expect(job.sources).toEqual([]);
    expect(job.sourceTextDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});
