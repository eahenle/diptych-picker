export type ImportImageContentType = "image/png" | "image/jpeg" | "image/webp";

export interface InspectedImportBytes {
  contentType: ImportImageContentType;
  width: number;
  height: number;
  animated: false;
}

export interface ImportSource extends InspectedImportBytes {
  file: File;
  bitmap: ImageBitmap;
}

export class ImportImageFileError extends Error {}

const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const maximumChunks = 4096;

export function inspectImportBytes(contents: Uint8Array): InspectedImportBytes {
  if (contents.byteLength === 0) {
    throw new ImportImageFileError("The selected image is empty.");
  }
  if (pngSignature.every((value, index) => contents[index] === value)) {
    return inspectPng(contents);
  }
  if (ascii(contents, 0, 4) === "RIFF" && ascii(contents, 8, 12) === "WEBP") {
    return inspectWebp(contents);
  }
  if (contents[0] === 0xff && contents[1] === 0xd8) {
    return inspectJpeg(contents);
  }
  throw new ImportImageFileError("Choose a still PNG, JPEG, or WebP image.");
}

export async function inspectImportFile(file: File): Promise<ImportSource> {
  let inspected: InspectedImportBytes;
  try {
    inspected = inspectImportBytes(new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    if (error instanceof ImportImageFileError) throw error;
    throw new ImportImageFileError("The selected image is malformed.");
  }
  if (typeof createImageBitmap !== "function") {
    throw new ImportImageFileError(
      "This browser cannot decode images for editing.",
    );
  }
  try {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });
    if (bitmap.width < 1 || bitmap.height < 1) {
      bitmap.close();
      throw new Error("empty decode");
    }
    return {
      ...inspected,
      width: bitmap.width,
      height: bitmap.height,
      file,
      bitmap,
    };
  } catch {
    throw new ImportImageFileError("The selected image could not be decoded.");
  }
}

function inspectPng(contents: Uint8Array): InspectedImportBytes {
  let offset: number = pngSignature.length;
  let chunks = 0;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawEnd = false;
  while (offset < contents.length) {
    if (++chunks > maximumChunks) malformed("PNG contains too many chunks");
    if (offset + 12 > contents.length) malformed("PNG is truncated");
    const length = readU32Be(contents, offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > contents.length) {
      malformed("PNG has an invalid chunk boundary");
    }
    const type = ascii(contents, offset + 4, offset + 8);
    const expectedCrc = readU32Be(contents, dataEnd);
    const actualCrc = crc32(contents.subarray(offset + 4, dataEnd));
    if (actualCrc !== expectedCrc) malformed("PNG chunk checksum is invalid");
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13 || chunks !== 1) {
        malformed("PNG must begin with one IHDR chunk");
      }
      width = readU32Be(contents, dataStart);
      height = readU32Be(contents, dataStart + 4);
      if (width < 1 || height < 1) malformed("PNG dimensions are invalid");
      sawHeader = true;
    } else if (type === "IHDR") {
      malformed("PNG contains more than one IHDR chunk");
    }
    if (type === "acTL" || type === "fcTL" || type === "fdAT") {
      throw new ImportImageFileError("Animated PNG images are not supported.");
    }
    if (type === "IEND") {
      if (length !== 0) malformed("PNG IEND chunk is invalid");
      sawEnd = true;
      offset = chunkEnd;
      break;
    }
    offset = chunkEnd;
  }
  if (!sawHeader || !sawEnd || offset !== contents.length) {
    malformed("PNG must end after one complete IEND chunk");
  }
  return { contentType: "image/png", width, height, animated: false };
}

function inspectWebp(contents: Uint8Array): InspectedImportBytes {
  if (contents.length < 20) malformed("WebP is truncated");
  const riffSize = readU32Le(contents, 4);
  if (riffSize + 8 !== contents.length) {
    malformed("WebP RIFF size does not match the file boundary");
  }
  let offset = 12;
  let chunks = 0;
  let width = 0;
  let height = 0;
  while (offset < contents.length) {
    if (++chunks > maximumChunks) malformed("WebP contains too many chunks");
    if (offset + 8 > contents.length) malformed("WebP chunk is truncated");
    const type = ascii(contents, offset, offset + 4);
    const length = readU32Le(contents, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const paddedEnd = dataEnd + (length & 1);
    if (dataEnd < dataStart || paddedEnd > contents.length) {
      malformed("WebP has an invalid chunk boundary");
    }
    if (type === "ANIM" || type === "ANMF") {
      throw new ImportImageFileError("Animated WebP images are not supported.");
    }
    if (type === "VP8X") {
      if (length < 10) malformed("WebP VP8X header is truncated");
      if ((contents[dataStart]! & 0x02) !== 0) {
        throw new ImportImageFileError(
          "Animated WebP images are not supported.",
        );
      }
      width = 1 + readU24Le(contents, dataStart + 4);
      height = 1 + readU24Le(contents, dataStart + 7);
    } else if (type === "VP8 ") {
      if (
        length < 10 ||
        contents[dataStart + 3] !== 0x9d ||
        contents[dataStart + 4] !== 0x01 ||
        contents[dataStart + 5] !== 0x2a
      ) {
        malformed("WebP VP8 frame header is invalid");
      }
      width = readU16Le(contents, dataStart + 6) & 0x3fff;
      height = readU16Le(contents, dataStart + 8) & 0x3fff;
    } else if (type === "VP8L") {
      if (length < 5 || contents[dataStart] !== 0x2f) {
        malformed("WebP VP8L frame header is invalid");
      }
      const bits = readU32Le(contents, dataStart + 1);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    }
    offset = paddedEnd;
  }
  if (offset !== contents.length || width < 1 || height < 1) {
    malformed("WebP has no valid still-image frame");
  }
  return { contentType: "image/webp", width, height, animated: false };
}

function inspectJpeg(contents: Uint8Array): InspectedImportBytes {
  let offset = 2;
  let markers = 0;
  let width = 0;
  let height = 0;
  let sawEnd = false;
  while (offset < contents.length) {
    if (++markers > maximumChunks) malformed("JPEG contains too many markers");
    if (contents[offset] !== 0xff) malformed("JPEG marker boundary is invalid");
    while (contents[offset] === 0xff) offset += 1;
    if (offset >= contents.length) malformed("JPEG marker is truncated");
    const marker = contents[offset++]!;
    if (marker === 0x00) malformed("JPEG contains an unexpected stuffed byte");
    if (marker === 0xd8) malformed("JPEG contains multiple images");
    if (marker === 0xd9) {
      sawEnd = true;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > contents.length) malformed("JPEG segment is truncated");
    const length = readU16Be(contents, offset);
    if (length < 2 || offset + length > contents.length) {
      malformed("JPEG segment boundary is invalid");
    }
    const dataStart = offset + 2;
    const dataEnd = offset + length;
    if (
      marker === 0xe2 &&
      ascii(contents, dataStart, dataStart + 4) === "MPF\0"
    ) {
      throw new ImportImageFileError(
        "Multi-picture JPEG and MPO files are not supported.",
      );
    }
    if (isStartOfFrame(marker)) {
      if (length < 7) malformed("JPEG frame header is truncated");
      height = readU16Be(contents, dataStart + 1);
      width = readU16Be(contents, dataStart + 3);
      if (width < 1 || height < 1) malformed("JPEG dimensions are invalid");
    }
    offset = dataEnd;
    if (marker === 0xda) {
      offset = scanJpegEntropy(contents, offset);
    }
  }
  if (!sawEnd || width < 1 || height < 1) {
    malformed("JPEG has no complete image frame");
  }
  for (; offset < contents.length; offset += 1) {
    if (contents[offset] !== 0x00 && contents[offset] !== 0xff) {
      malformed("JPEG contains payload after its final image");
    }
  }
  return { contentType: "image/jpeg", width, height, animated: false };
}

function scanJpegEntropy(contents: Uint8Array, start: number): number {
  let offset = start;
  while (offset < contents.length) {
    if (contents[offset++] !== 0xff) continue;
    while (contents[offset] === 0xff) offset += 1;
    if (offset >= contents.length) malformed("JPEG scan is truncated");
    const marker = contents[offset]!;
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 1;
      continue;
    }
    return offset - 1;
  }
  malformed("JPEG scan is missing its end marker");
}

function isStartOfFrame(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function malformed(message: string): never {
  throw new ImportImageFileError(message);
}

function ascii(contents: Uint8Array, start: number, end: number): string {
  if (start < 0 || end > contents.length || end < start) return "";
  return String.fromCharCode(...contents.subarray(start, end));
}

function readU16Be(contents: Uint8Array, offset: number): number {
  return (contents[offset]! << 8) | contents[offset + 1]!;
}

function readU16Le(contents: Uint8Array, offset: number): number {
  return contents[offset]! | (contents[offset + 1]! << 8);
}

function readU24Le(contents: Uint8Array, offset: number): number {
  return (
    contents[offset]! |
    (contents[offset + 1]! << 8) |
    (contents[offset + 2]! << 16)
  );
}

function readU32Be(contents: Uint8Array, offset: number): number {
  return (
    contents[offset]! * 0x1000000 +
    (contents[offset + 1]! << 16) +
    (contents[offset + 2]! << 8) +
    contents[offset + 3]!
  );
}

function readU32Le(contents: Uint8Array, offset: number): number {
  return (
    contents[offset]! +
    contents[offset + 1]! * 0x100 +
    contents[offset + 2]! * 0x10000 +
    contents[offset + 3]! * 0x1000000
  );
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
