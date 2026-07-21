import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  contentAddressedFilename,
  contentDigest,
  publishExportArtifact,
} from "./artifact-store";

describe("content-addressed export artifacts", () => {
  it("names an artifact with the SHA-256 digest of its exact bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-exports-"));
    const contents = Buffer.from("exact artifact bytes\n", "utf8");

    const artifact = await publishExportArtifact(contents, "json", directory);

    expect(artifact.digest).toBe(contentDigest(contents));
    expect(artifact.filename).toBe(contentAddressedFilename(contents, "json"));
    expect(await readFile(artifact.path)).toEqual(contents);
  });

  it("deduplicates matching bytes and rejects a mismatched occupied digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-exports-"));
    const contents = Buffer.from("same bytes", "utf8");
    const first = await publishExportArtifact(contents, "png", directory);

    await expect(
      publishExportArtifact(contents, "png", directory),
    ).resolves.toEqual(first);

    await writeFile(first.path, Buffer.from("different bytes", "utf8"));
    await expect(
      publishExportArtifact(contents, "png", directory),
    ).rejects.toThrow(/differs from source/i);
  });

  it("publishes concurrent identical artifacts without exposing partial bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-exports-"));
    const contents = Buffer.alloc(1024 * 1024, 0x5a);

    const artifacts = await Promise.all(
      Array.from({ length: 8 }, () =>
        publishExportArtifact(contents, "png", directory),
      ),
    );

    expect(new Set(artifacts.map(({ path }) => path))).toHaveLength(1);
    expect(await readFile(artifacts[0].path)).toEqual(contents);
  });
});
