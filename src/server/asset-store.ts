import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type {
  AssetStore,
  CompletedAssetMetadata,
  GeneratedImage,
} from "./providers";
import {
  contentAddressedFilename,
  contentDigest,
  publishExportArtifact,
  publishImmutableFile,
} from "./artifact-store";

export class LocalAssetStore implements AssetStore {
  constructor(
    private readonly directory: string,
    private readonly exportDirectory?: string,
  ) {}

  async save(image: GeneratedImage & { id: string }) {
    const filename = contentAddressedFilename(image.bytes, image.extension);
    const path = join(/* turbopackIgnore: true */ this.directory, filename);
    await publishImmutableFile(path, image.bytes);
    if (this.exportDirectory) {
      await publishExportArtifact(
        image.bytes,
        image.extension,
        this.exportDirectory,
      );
    }
    return {
      filename,
      url: `/api/assets/${filename}`,
      byteLength: image.bytes.length,
    };
  }

  async read(filename: string): Promise<Buffer> {
    if (!/^[a-zA-Z0-9-]+\.(png|webp|svg)$/.test(filename)) {
      throw new Error("Invalid asset filename");
    }
    return readFile(join(/* turbopackIgnore: true */ this.directory, filename));
  }

  async verifyExistingPng(filename: string): Promise<void> {
    const maximumByteLength = 50 * 1024 * 1024;
    const maximumPixels = 4096 * 4096;
    const bytes = await this.read(filename);
    if (
      /^[a-f0-9]{64}\.png$/.test(filename) &&
      filename !== `${contentDigest(bytes)}.png`
    ) {
      throw new Error(
        "Content-addressed asset filename does not match its bytes",
      );
    }
    if (bytes.length > maximumByteLength) {
      throw new Error(
        `Asset byte length ${bytes.length} exceeds the ${maximumByteLength} byte limit`,
      );
    }
    const image = sharp(bytes, {
      failOn: "error",
      limitInputPixels: maximumPixels,
    });
    const metadata = await image.metadata();
    if (
      metadata.format !== "png" ||
      !metadata.width ||
      metadata.width !== metadata.height
    ) {
      throw new Error("Existing asset must be a square PNG");
    }
    await image.raw().toBuffer();
  }

  async verify(asset: CompletedAssetMetadata): Promise<void> {
    const maximumByteLength = 50 * 1024 * 1024;
    const maximumPixels = 4096 * 4096;
    const legacyFilename = `${asset.candidateId}.png`;
    const contentAddressed = /^[a-f0-9]{64}\.png$/.test(asset.filename);
    if (!contentAddressed && asset.filename !== legacyFilename) {
      throw new Error(
        `Asset filename must be a SHA-256 digest or equal legacy name ${legacyFilename}`,
      );
    }
    if (asset.imageUrl !== `/api/assets/${asset.filename}`) {
      throw new Error(`Asset URL must match ${asset.filename}`);
    }
    if (asset.contentType !== "image/png") {
      throw new Error("Completed asset must use image/png");
    }
    if (asset.byteLength > maximumByteLength) {
      throw new Error(
        `Asset byte length ${asset.byteLength} exceeds the ${maximumByteLength} byte limit`,
      );
    }
    if (
      asset.width <= 0 ||
      asset.height <= 0 ||
      asset.width > maximumPixels / asset.height
    ) {
      throw new Error(
        `Asset dimensions ${asset.width}x${asset.height} exceed the ${maximumPixels} pixel limit`,
      );
    }

    const assetPath = join(
      /* turbopackIgnore: true */ this.directory,
      asset.filename,
    );
    const file = await stat(assetPath);
    if (file.size > maximumByteLength) {
      throw new Error(
        `Asset byte length ${file.size} exceeds the ${maximumByteLength} byte limit`,
      );
    }
    const bytes = await readFile(assetPath);
    if (contentAddressed && asset.filename !== `${contentDigest(bytes)}.png`) {
      throw new Error(
        "Content-addressed asset filename does not match its bytes",
      );
    }
    if (bytes.length > maximumByteLength) {
      throw new Error(
        `Asset byte length ${bytes.length} exceeds the ${maximumByteLength} byte limit`,
      );
    }
    if (bytes.length !== asset.byteLength) {
      throw new Error(
        `Asset byte length ${bytes.length} does not match reported ${asset.byteLength}`,
      );
    }

    const image = sharp(bytes, {
      failOn: "error",
      limitInputPixels: maximumPixels,
    });
    const metadata = await image.metadata();
    if (metadata.format !== "png") {
      throw new Error("Completed asset bytes are not a PNG");
    }
    if (
      metadata.width !== asset.width ||
      metadata.height !== asset.height ||
      asset.width !== asset.height
    ) {
      throw new Error(
        `Asset dimensions ${metadata.width}x${metadata.height} do not match reported ${asset.width}x${asset.height}`,
      );
    }
    await image.raw().toBuffer();
  }
}
