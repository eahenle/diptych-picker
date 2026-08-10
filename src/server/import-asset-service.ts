import { join } from "node:path";
import sharp from "sharp";
import type { ImportedAssetMetadata } from "@/domain/import-session";
import {
  contentDigest,
  publishExportArtifact,
  publishImmutableFile,
} from "./artifact-store";

export const canonicalImportedAssetByteLimit = 20 * 1024 * 1024;
export const canonicalImportedAssetPixels = 1024 * 1024;

const pngSignature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const maximumPngChunks = 4096;
const apngChunks = new Set(["acTL", "fcTL", "fdAT"]);
const singletonBeforePlte = new Set([
  "cHRM",
  "cICP",
  "gAMA",
  "iCCP",
  "mDCV",
  "cLLI",
  "sBIT",
  "sRGB",
]);
const singletonAfterPlteBeforeIdat = new Set(["hIST"]);
const singletonBeforeIdat = new Set(["eXIf", "pHYs"]);
const singletonBeforeIdatWithOptionalPlte = new Set(["bKGD", "tRNS"]);
const singletonWithoutOrdering = new Set(["tIME"]);
const repeatableBeforeIdat = new Set(["sPLT"]);
const repeatableWithoutOrdering = new Set(["iTXt", "tEXt", "zTXt"]);
const knownPngChunks = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  ...apngChunks,
  ...singletonBeforePlte,
  ...singletonAfterPlteBeforeIdat,
  ...singletonBeforeIdat,
  ...singletonBeforeIdatWithOptionalPlte,
  ...singletonWithoutOrdering,
  ...repeatableBeforeIdat,
  ...repeatableWithoutOrdering,
]);

export async function normalizeImportedCandidate(
  contents: Uint8Array,
  assetDirectory: string,
  exportDirectory?: string,
): Promise<ImportedAssetMetadata> {
  if (contents.length > canonicalImportedAssetByteLimit) {
    throw new Error(
      `Imported asset exceeds the ${canonicalImportedAssetByteLimit} byte limit`,
    );
  }

  inspectStaticPng(contents);

  const source = sharp(contents, {
    animated: false,
    failOn: "error",
    limitInputPixels: canonicalImportedAssetPixels,
  });
  const metadata = await source.metadata();
  if (metadata.format !== "png") {
    throw new Error("Imported asset must be a PNG");
  }
  if ((metadata.pages ?? 1) > 1) {
    throw new Error("Imported asset must contain one PNG page");
  }
  if (metadata.width !== 1024 || metadata.height !== 1024) {
    throw new Error("Imported asset must be exactly 1024x1024");
  }

  const output = await sharp(contents, {
    animated: false,
    failOn: "error",
    limitInputPixels: canonicalImportedAssetPixels,
  })
    .rotate()
    .toColorspace("srgb")
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer({ resolveWithObject: true });
  if (
    output.info.format !== "png" ||
    output.info.width !== 1024 ||
    output.info.height !== 1024 ||
    output.data.length > canonicalImportedAssetByteLimit
  ) {
    throw new Error(
      "Imported asset did not normalize to a bounded 1024x1024 PNG",
    );
  }

  const digest = contentDigest(output.data);
  const filename = `${digest}.png`;
  await publishImmutableFile(join(assetDirectory, filename), output.data);
  if (exportDirectory) {
    await publishExportArtifact(output.data, "png", exportDirectory);
  }

  return {
    digest,
    filename,
    url: `/api/assets/${filename}`,
    contentType: "image/png",
    width: output.info.width,
    height: output.info.height,
    byteLength: output.data.length,
  };
}

export function inspectStaticPng(contents: Uint8Array): void {
  if (
    contents.length < pngSignature.length ||
    !contents
      .subarray(0, pngSignature.length)
      .every((byte, index) => byte === pngSignature[index])
  ) {
    throw new Error("Imported asset must have an exact PNG signature");
  }
  const view = new DataView(
    contents.buffer,
    contents.byteOffset,
    contents.byteLength,
  );
  let offset = pngSignature.length;
  let chunkCount = 0;
  let sawPlte = false;
  let sawIdat = false;
  let idatRunEnded = false;
  let sawChunkThatRequiresNoLaterPlte = false;
  const seenSingletonChunks = new Set<string>();
  while (offset + 12 <= contents.length) {
    if (chunkCount >= maximumPngChunks) {
      throw new Error(
        `Imported PNG exceeds the ${maximumPngChunks} chunk limit`,
      );
    }
    const length = view.getUint32(offset);
    const nextOffset = offset + 12 + length;
    if (nextOffset > contents.length) {
      throw new Error("Imported PNG has truncated chunk framing");
    }
    const typeStart = offset + 4;
    const typeEnd = typeStart + 4;
    if (!contents.subarray(typeStart, typeEnd).every(isPngChunkTypeByte)) {
      throw new Error("Imported PNG has an invalid chunk type");
    }
    const expectedCrc = view.getUint32(nextOffset - 4);
    const actualCrc = crc32(contents.subarray(typeStart, nextOffset - 4));
    if (expectedCrc !== actualCrc) {
      throw new Error("Imported PNG has an invalid chunk CRC");
    }
    const type = String.fromCharCode(...contents.subarray(typeStart, typeEnd));
    if (chunkCount === 0 && type !== "IHDR") {
      throw new Error("Imported PNG must begin with IHDR");
    }
    if (type === "IHDR" && (chunkCount !== 0 || length !== 13)) {
      throw new Error("Imported PNG must contain one 13-byte IHDR chunk");
    }
    if (contents[typeStart + 2] & 0x20) {
      throw new Error("Imported PNG has a lowercase reserved chunk-type byte");
    }
    if (apngChunks.has(type)) {
      throw new Error("Imported PNG must not be animated");
    }
    if (!knownPngChunks.has(type) && !(contents[typeStart] & 0x20)) {
      throw new Error("Imported PNG has an unknown critical chunk");
    }
    if (type === "IEND") {
      if (length !== 0) {
        throw new Error("Imported PNG must have a zero-length IEND chunk");
      }
      if (!sawIdat) {
        throw new Error("Imported PNG must contain IDAT data");
      }
      if (nextOffset !== contents.length) {
        throw new Error("Imported PNG must not contain trailing bytes");
      }
      return;
    }

    if (type === "IDAT") {
      if (idatRunEnded) {
        throw new Error("Imported PNG IDAT chunks must be consecutive");
      }
      sawIdat = true;
    } else if (sawIdat) {
      idatRunEnded = true;
    }

    if (type === "PLTE") {
      if (sawPlte || sawIdat || sawChunkThatRequiresNoLaterPlte) {
        throw new Error("Imported PNG may contain one PLTE before IDAT");
      }
      sawPlte = true;
    } else if (singletonBeforePlte.has(type)) {
      assertSingletonChunk(type, seenSingletonChunks);
      if (sawPlte || sawIdat) {
        throw new Error(`Imported PNG ${type} must precede PLTE and IDAT`);
      }
    } else if (singletonAfterPlteBeforeIdat.has(type)) {
      assertSingletonChunk(type, seenSingletonChunks);
      if (!sawPlte || sawIdat) {
        throw new Error(
          `Imported PNG ${type} must follow PLTE and precede IDAT`,
        );
      }
    } else if (singletonBeforeIdat.has(type)) {
      assertSingletonChunk(type, seenSingletonChunks);
      if (sawIdat) {
        throw new Error(`Imported PNG ${type} must precede IDAT`);
      }
    } else if (singletonBeforeIdatWithOptionalPlte.has(type)) {
      assertSingletonChunk(type, seenSingletonChunks);
      if (sawIdat) {
        throw new Error(`Imported PNG ${type} must precede IDAT`);
      }
      if (!sawPlte) sawChunkThatRequiresNoLaterPlte = true;
    } else if (singletonWithoutOrdering.has(type)) {
      assertSingletonChunk(type, seenSingletonChunks);
    } else if (repeatableBeforeIdat.has(type) && sawIdat) {
      throw new Error(`Imported PNG ${type} must precede IDAT`);
    }

    offset = nextOffset;
    chunkCount += 1;
  }
  throw new Error("Imported PNG must end with IEND");
}

function isPngChunkTypeByte(byte: number): boolean {
  return (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122);
}

function assertSingletonChunk(type: string, seen: Set<string>): void {
  if (seen.has(type)) {
    throw new Error(`Imported PNG may contain one ${type} chunk`);
  }
  seen.add(type);
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
