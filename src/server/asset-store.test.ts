import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { LocalAssetStore } from "./asset-store";
import type { CompletedAssetMetadata } from "./providers";

const metadata = (byteLength: number): CompletedAssetMetadata => ({
  candidateId: "challenger-job-1",
  filename: "challenger-job-1.png",
  imageUrl: "/api/assets/challenger-job-1.png",
  contentType: "image/png",
  width: 8,
  height: 8,
  byteLength,
});

async function squarePng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 8,
      height: 8,
      channels: 4,
      background: "#46145a",
    },
  })
    .png()
    .toBuffer();
}

describe("LocalAssetStore.verify", () => {
  it("rejects a missing immutable asset", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-assets-"));
    const store = new LocalAssetStore(directory);

    await expect(store.verify(metadata(100))).rejects.toThrow();
  });

  it("rejects corrupt bytes reported as a PNG", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-assets-"));
    const store = new LocalAssetStore(directory);
    const bytes = Buffer.from("not a png");
    await writeFile(join(directory, "challenger-job-1.png"), bytes);

    await expect(store.verify(metadata(bytes.length))).rejects.toThrow();
  });

  it("rejects a header-valid PNG whose pixel stream is truncated", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-assets-"));
    const store = new LocalAssetStore(directory);
    const complete = await squarePng();
    const truncated = complete.subarray(0, complete.length - 16);
    await writeFile(join(directory, "challenger-job-1.png"), truncated);

    await expect(store.verify(metadata(truncated.length))).rejects.toThrow();
  });

  it("rejects PNGs above the decoded pixel limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-assets-"));
    const store = new LocalAssetStore(directory);
    const bytes = await sharp({
      create: {
        width: 4097,
        height: 4097,
        channels: 4,
        background: "#46145a",
      },
    })
      .png()
      .toBuffer();
    await writeFile(join(directory, "challenger-job-1.png"), bytes);

    await expect(
      store.verify({
        ...metadata(bytes.length),
        width: 4097,
        height: 4097,
      }),
    ).rejects.toThrow(/pixel|dimension|limit/i);
  });

  it("rejects assets above the encoded byte limit before decoding", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-assets-"));
    const store = new LocalAssetStore(directory);
    const bytes = Buffer.alloc(50 * 1024 * 1024 + 1);
    await writeFile(join(directory, "challenger-job-1.png"), bytes);

    await expect(store.verify(metadata(bytes.length))).rejects.toThrow(
      /byte|size|limit/i,
    );
  });

  it("rejects byte-length and dimension metadata mismatches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-assets-"));
    const store = new LocalAssetStore(directory);
    const bytes = await squarePng();
    await writeFile(join(directory, "challenger-job-1.png"), bytes);

    await expect(store.verify(metadata(bytes.length + 1))).rejects.toThrow(
      /byte length/i,
    );
    await expect(
      store.verify({ ...metadata(bytes.length), width: 9 }),
    ).rejects.toThrow(/dimensions/i);
  });

  it("accepts a canonical square PNG whose metadata matches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-assets-"));
    const store = new LocalAssetStore(directory);
    const bytes = await squarePng();
    await writeFile(join(directory, "challenger-job-1.png"), bytes);

    await expect(store.verify(metadata(bytes.length))).resolves.toBeUndefined();
  });
});

describe("LocalAssetStore.verifyExistingPng", () => {
  it("fully decodes an existing square PNG", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-assets-"));
    const store = new LocalAssetStore(directory);
    await writeFile(join(directory, "candidate.png"), await squarePng());

    await expect(
      store.verifyExistingPng("candidate.png"),
    ).resolves.toBeUndefined();
  });

  it("rejects corrupt or non-square existing assets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-assets-"));
    const store = new LocalAssetStore(directory);
    await writeFile(join(directory, "corrupt.png"), Buffer.from("not a png"));
    const rectangle = await sharp({
      create: {
        width: 8,
        height: 4,
        channels: 4,
        background: "#46145a",
      },
    })
      .png()
      .toBuffer();
    await writeFile(join(directory, "rectangle.png"), rectangle);

    await expect(store.verifyExistingPng("corrupt.png")).rejects.toThrow();
    await expect(store.verifyExistingPng("rectangle.png")).rejects.toThrow(
      /square PNG/i,
    );
  });
});
