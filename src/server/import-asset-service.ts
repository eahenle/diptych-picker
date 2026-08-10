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
  if (containsPngAnimationControl(contents)) {
    throw new Error("Imported asset must not be animated");
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

function containsPngAnimationControl(contents: Uint8Array): boolean {
  if (
    contents.length < 8 ||
    !contents
      .subarray(0, 8)
      .every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index])
  ) {
    return false;
  }
  const view = new DataView(
    contents.buffer,
    contents.byteOffset,
    contents.byteLength,
  );
  let offset = 8;
  while (offset + 12 <= contents.length) {
    const length = view.getUint32(offset);
    const nextOffset = offset + 12 + length;
    if (nextOffset > contents.length) return false;
    if (
      contents[offset + 4] === 97 &&
      contents[offset + 5] === 99 &&
      contents[offset + 6] === 84 &&
      contents[offset + 7] === 76
    ) {
      return true;
    }
    offset = nextOffset;
  }
  return false;
}
