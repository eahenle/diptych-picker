import { createHash } from "node:crypto";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { normalizeImportedCandidate } from "./import-asset-service";

const canonicalLimit = 20 * 1024 * 1024;

async function squarePngWithMetadata(): Promise<Buffer> {
  return sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 4,
      background: "#46145a",
    },
  })
    .withMetadata({ exif: { IFD0: { Artist: "Private source metadata" } } })
    .png()
    .toBuffer();
}

async function animatedPng(): Promise<Buffer> {
  const still = await sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 4,
      background: "#46145a",
    },
  })
    .png()
    .toBuffer();
  const chunks = pngChunks(still);
  const header = chunks.find((chunk) => chunk.type === "IHDR")!;
  const frame = Buffer.concat(
    chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data),
  );
  const frameControl = (sequence: number) => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(sequence, 0);
    data.writeUInt32BE(1024, 4);
    data.writeUInt32BE(1024, 8);
    data.writeUInt32BE(0, 12);
    data.writeUInt32BE(0, 16);
    data.writeUInt16BE(1, 20);
    data.writeUInt16BE(10, 22);
    return pngChunk("fcTL", data);
  };
  const animationControl = Buffer.alloc(8);
  animationControl.writeUInt32BE(2, 0);
  const output = Buffer.concat([
    still.subarray(0, 8),
    pngChunk("IHDR", header.data),
    pngChunk("acTL", animationControl),
    frameControl(0),
    pngChunk("IDAT", frame),
    frameControl(1),
    pngChunk("fdAT", Buffer.concat([Buffer.from([0, 0, 0, 2]), frame])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  expect(pngChunks(output).some((chunk) => chunk.type === "acTL")).toBe(true);
  await expect(sharp(output).raw().toBuffer()).resolves.toBeInstanceOf(Buffer);
  return output;
}

function pngChunks(
  contents: Buffer,
): Array<{ offset: number; type: string; data: Buffer }> {
  const chunks: Array<{ offset: number; type: string; data: Buffer }> = [];
  let offset = 8;
  while (offset < contents.length) {
    const length = contents.readUInt32BE(offset);
    const type = contents.subarray(offset + 4, offset + 8).toString("ascii");
    const data = contents.subarray(offset + 8, offset + 8 + length);
    chunks.push({ offset, type, data });
    offset += 12 + length;
  }
  return chunks;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(chunk.subarray(4, 8 + data.length)),
    8 + data.length,
  );
  return chunk;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function artifactDirectories() {
  const root = await mkdtemp(join(tmpdir(), "diptych-import-assets-"));
  return { assets: join(root, "assets"), exports: join(root, "exports") };
}

async function staticPng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 4,
      background: "#46145a",
    },
  })
    .png()
    .toBuffer();
}

describe("normalizeImportedCandidate", () => {
  it("canonicalizes a square PNG deterministically without source metadata", async () => {
    const { assets, exports } = await artifactDirectories();
    const input = await squarePngWithMetadata();

    const first = await normalizeImportedCandidate(input, assets, exports);
    const second = await normalizeImportedCandidate(input, assets, exports);
    const canonicalBytes = await readFile(join(assets, first.filename));
    const metadata = await sharp(canonicalBytes).metadata();

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      filename: expect.stringMatching(/^[a-f0-9]{64}\.png$/),
      url: expect.stringMatching(/^\/api\/assets\/[a-f0-9]{64}\.png$/),
      contentType: "image/png",
      width: 1024,
      height: 1024,
      byteLength: canonicalBytes.length,
    });
    expect(first.filename).toBe(`${first.digest}.png`);
    expect(first.url).toBe(`/api/assets/${first.filename}`);
    expect(first.digest).toBe(
      createHash("sha256").update(canonicalBytes).digest("hex"),
    );
    expect(metadata.space).toBe("srgb");
    expect(metadata.exif).toBeUndefined();
    expect(await readFile(join(exports, first.filename))).toEqual(
      canonicalBytes,
    );
  });

  it.each([
    [
      "non-square PNG",
      async () =>
        sharp({
          create: {
            width: 1024,
            height: 768,
            channels: 4,
            background: "#46145a",
          },
        })
          .png()
          .toBuffer(),
    ],
    ["animated PNG", animatedPng],
    ["corrupt bytes", async () => Buffer.from("not a PNG")],
    [
      "a PNG with trailing bytes",
      async () =>
        Buffer.concat([await staticPng(), Buffer.from("trailing bytes")]),
    ],
    [
      "a PNG without IEND",
      async () => {
        const contents = await staticPng();
        return contents.subarray(0, contents.length - 12);
      },
    ],
    [
      "a PNG with an invalid IEND CRC",
      async () => {
        const contents = Buffer.from(await staticPng());
        contents[contents.length - 1] ^= 1;
        return contents;
      },
    ],
    [
      "a PNG with an invalid IDAT CRC",
      async () => {
        const contents = Buffer.from(await staticPng());
        const idat = pngChunks(contents).find(
          (chunk) => chunk.type === "IDAT",
        )!;
        contents[idat.offset + 8 + idat.data.length] ^= 1;
        return contents;
      },
    ],
    [
      "a PNG with truncated chunk framing",
      async () => {
        const contents = await staticPng();
        return contents.subarray(0, contents.length - 1);
      },
    ],
    [
      "a valid decodable WebP",
      async () =>
        sharp({
          create: {
            width: 1024,
            height: 1024,
            channels: 4,
            background: "#46145a",
          },
        })
          .webp()
          .toBuffer(),
    ],
    [
      "a valid decodable JPEG",
      async () =>
        sharp({
          create: {
            width: 1024,
            height: 1024,
            channels: 3,
            background: "#46145a",
          },
        })
          .jpeg()
          .toBuffer(),
    ],
    [
      "request above the canonical byte limit",
      async () => Buffer.alloc(canonicalLimit + 1),
    ],
  ])("rejects %s before publishing any artifact", async (_name, input) => {
    const { assets, exports } = await artifactDirectories();
    const contents = await input();

    await expect(
      normalizeImportedCandidate(contents, assets, exports),
    ).rejects.toThrow();

    await expect(access(assets)).rejects.toThrow();
    await expect(access(exports)).rejects.toThrow();
  });
});
