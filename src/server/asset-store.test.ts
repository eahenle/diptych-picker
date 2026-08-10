import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { LocalAssetStore } from "./asset-store";
import type { ImportedAssetMetadata } from "@/domain/import-session";
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

describe("LocalAssetStore.save", () => {
  it("stores and exports PNG bytes under their SHA-256 filename", async () => {
    const root = await mkdtemp(join(tmpdir(), "diptych-assets-"));
    const assets = join(root, "assets");
    const exports = join(root, "exports");
    const store = new LocalAssetStore(assets, exports);
    const bytes = await squarePng();

    const stored = await store.save({
      id: "challenger-job-1",
      bytes,
      extension: "png",
      contentType: "image/png",
      width: 8,
      height: 8,
    });

    expect(stored.filename).toMatch(/^[a-f0-9]{64}\.png$/);
    expect(stored.url).toBe(`/api/assets/${stored.filename}`);
    expect(await readFile(join(assets, stored.filename))).toEqual(bytes);
    expect(await readFile(join(exports, stored.filename))).toEqual(bytes);
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

describe("LocalAssetStore.verifyImportedAsset", () => {
  it("accepts a fully decoded canonical imported asset", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-assets-"));
    const store = new LocalAssetStore(directory);
    const bytes = await sharp({
      create: {
        width: 1024,
        height: 1024,
        channels: 4,
        background: "#46145a",
      },
    })
      .png()
      .toBuffer();
    const digest = createHash("sha256").update(bytes).digest("hex");
    const asset: ImportedAssetMetadata = {
      digest,
      filename: `${digest}.png`,
      url: `/api/assets/${digest}.png`,
      contentType: "image/png",
      width: 1024,
      height: 1024,
      byteLength: bytes.length,
    };
    await writeFile(join(directory, asset.filename), bytes);

    await expect(store.verifyImportedAsset(asset)).resolves.toBeUndefined();
  });

  it("rejects imported metadata that does not describe the canonical bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-assets-"));
    const store = new LocalAssetStore(directory);
    const bytes = await squarePng();
    const digest = createHash("sha256").update(bytes).digest("hex");
    const asset: ImportedAssetMetadata = {
      digest,
      filename: `${digest}.png`,
      url: `/api/assets/${digest}.png`,
      contentType: "image/png",
      width: 1024,
      height: 1024,
      byteLength: bytes.length,
    };
    await writeFile(join(directory, asset.filename), bytes);

    await expect(
      store.verifyImportedAsset({ ...asset, url: "/api/assets/other.png" }),
    ).rejects.toThrow(/URL/i);
    await expect(
      store.verifyImportedAsset({ ...asset, byteLength: bytes.length + 1 }),
    ).rejects.toThrow(/byte length/i);
    await expect(
      store.verifyImportedAsset({ ...asset, width: 1023 }),
    ).rejects.toThrow(/1024/i);

    const mismatchedDigest = "0".repeat(64);
    await writeFile(join(directory, `${mismatchedDigest}.png`), bytes);
    await expect(
      store.verifyImportedAsset({
        ...asset,
        digest: mismatchedDigest,
        filename: `${mismatchedDigest}.png`,
        url: `/api/assets/${mismatchedDigest}.png`,
      }),
    ).rejects.toThrow(/digest/i);

    const corrupt = Buffer.from("not a PNG");
    const corruptDigest = createHash("sha256").update(corrupt).digest("hex");
    await writeFile(join(directory, `${corruptDigest}.png`), corrupt);
    await expect(
      store.verifyImportedAsset({
        ...asset,
        digest: corruptDigest,
        filename: `${corruptDigest}.png`,
        url: `/api/assets/${corruptDigest}.png`,
        byteLength: corrupt.length,
      }),
    ).rejects.toThrow(/unsupported|format/i);
  });
});
