import { describe, expect, it } from "vitest";
import { ImportImageFileError, inspectImportBytes } from "./import-image-file";

describe("inspectImportBytes", () => {
  it("structurally accepts a still PNG and ignores marker text inside pixels", () => {
    const value = png([
      chunk("IHDR", ihdr(16, 9)),
      chunk("IDAT", bytes("decoy acTL ANIM MPF text")),
      chunk("IEND", new Uint8Array()),
    ]);

    expect(inspectImportBytes(value)).toEqual({
      contentType: "image/png",
      width: 16,
      height: 9,
      animated: false,
    });
  });

  it("rejects parsed APNG animation and truncated PNG chunks", () => {
    const animated = png([
      chunk("IHDR", ihdr(8, 8)),
      chunk("acTL", new Uint8Array(8)),
      chunk("IEND", new Uint8Array()),
    ]);
    expect(() => inspectImportBytes(animated)).toThrow(/animated png/i);
    expect(() => inspectImportBytes(animated.subarray(0, -2))).toThrow(
      ImportImageFileError,
    );
  });

  it("accepts a bounded still WebP and rejects animation chunks and RIFF mismatch", () => {
    const still = webp([["VP8X", vp8x(23, 17, 0)]]);
    expect(inspectImportBytes(still)).toMatchObject({
      contentType: "image/webp",
      width: 23,
      height: 17,
    });
    expect(() =>
      inspectImportBytes(
        webp([
          ["VP8X", vp8x(23, 17, 2)],
          ["ANIM", new Uint8Array(6)],
        ]),
      ),
    ).toThrow(/animated webp/i);
    const corrupt = still.slice();
    corrupt[4] = 0;
    expect(() => inspectImportBytes(corrupt)).toThrow(/riff size/i);
  });

  it("walks JPEG segments, rejects MPF/MPO, and rejects trailing images", () => {
    const still = jpeg([
      segment(0xc0, new Uint8Array([8, 0, 9, 0, 16, 1, 1, 0x11, 0])),
    ]);
    expect(inspectImportBytes(still)).toMatchObject({
      contentType: "image/jpeg",
      width: 16,
      height: 9,
    });
    const mpo = jpeg([
      segment(0xe2, bytes("MPF\0II*\0")),
      segment(0xc0, new Uint8Array([8, 0, 9, 0, 16, 1, 1, 0x11, 0])),
    ]);
    expect(() => inspectImportBytes(mpo)).toThrow(/multi-picture|mpo/i);
    expect(() => inspectImportBytes(concat(still, still))).toThrow(
      /payload|multiple/i,
    );
  });

  it("rejects empty, unsupported, and malformed input", () => {
    expect(() => inspectImportBytes(new Uint8Array())).toThrow(/empty/i);
    expect(() => inspectImportBytes(bytes("GIF89a"))).toThrow(
      /png, jpeg, or webp/i,
    );
    expect(() =>
      inspectImportBytes(new Uint8Array([0xff, 0xd8, 0xff])),
    ).toThrow(ImportImageFileError);
  });
});

function png(chunks: Uint8Array[]): Uint8Array {
  return concat(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks);
}

function ihdr(width: number, height: number): Uint8Array {
  const value = new Uint8Array(13);
  writeU32Be(value, 0, width);
  writeU32Be(value, 4, height);
  value[8] = 8;
  value[9] = 6;
  return value;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = bytes(type);
  const value = new Uint8Array(12 + data.length);
  writeU32Be(value, 0, data.length);
  value.set(typeBytes, 4);
  value.set(data, 8);
  writeU32Be(value, 8 + data.length, crc32(concat(typeBytes, data)));
  return value;
}

function webp(chunks: Array<[string, Uint8Array]>): Uint8Array {
  const body = concat(
    bytes("WEBP"),
    ...chunks.map(([type, data]) => {
      const value = new Uint8Array(8 + data.length + (data.length & 1));
      value.set(bytes(type), 0);
      writeU32Le(value, 4, data.length);
      value.set(data, 8);
      return value;
    }),
  );
  const value = new Uint8Array(8 + body.length);
  value.set(bytes("RIFF"), 0);
  writeU32Le(value, 4, body.length);
  value.set(body, 8);
  return value;
}

function vp8x(width: number, height: number, flags: number): Uint8Array {
  const value = new Uint8Array(10);
  value[0] = flags;
  writeU24Le(value, 4, width - 1);
  writeU24Le(value, 7, height - 1);
  return value;
}

function jpeg(segments: Uint8Array[]): Uint8Array {
  return concat(
    new Uint8Array([0xff, 0xd8]),
    ...segments,
    new Uint8Array([0xff, 0xd9]),
  );
}

function segment(marker: number, data: Uint8Array): Uint8Array {
  const value = new Uint8Array(4 + data.length);
  value[0] = 0xff;
  value[1] = marker;
  value[2] = ((data.length + 2) >>> 8) & 0xff;
  value[3] = (data.length + 2) & 0xff;
  value.set(data, 4);
  return value;
}

function concat(...values: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    values.reduce((total, value) => total + value.length, 0),
  );
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function writeU24Le(value: Uint8Array, offset: number, input: number): void {
  value[offset] = input & 0xff;
  value[offset + 1] = (input >>> 8) & 0xff;
  value[offset + 2] = (input >>> 16) & 0xff;
}

function writeU32Be(value: Uint8Array, offset: number, input: number): void {
  value[offset] = (input >>> 24) & 0xff;
  value[offset + 1] = (input >>> 16) & 0xff;
  value[offset + 2] = (input >>> 8) & 0xff;
  value[offset + 3] = input & 0xff;
}

function writeU32Le(value: Uint8Array, offset: number, input: number): void {
  value[offset] = input & 0xff;
  value[offset + 1] = (input >>> 8) & 0xff;
  value[offset + 2] = (input >>> 16) & 0xff;
  value[offset + 3] = (input >>> 24) & 0xff;
}

function crc32(contents: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of contents) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
