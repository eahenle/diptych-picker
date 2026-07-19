import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type {
  AssetStore,
  CompletedAssetMetadata,
  GeneratedImage,
} from "./providers";

export class LocalAssetStore implements AssetStore {
  constructor(private readonly directory: string) {}

  async save(image: GeneratedImage & { id: string }) {
    await mkdir(this.directory, { recursive: true });
    const filename = `${image.id}.${image.extension}`;
    await writeFile(
      join(/* turbopackIgnore: true */ this.directory, filename),
      image.bytes,
      { flag: "wx" },
    );
    return { url: `/api/assets/${filename}`, byteLength: image.bytes.length };
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
    const canonicalFilename = `${asset.candidateId}.png`;
    if (asset.filename !== canonicalFilename) {
      throw new Error(`Asset filename must equal ${canonicalFilename}`);
    }
    if (asset.imageUrl !== `/api/assets/${canonicalFilename}`) {
      throw new Error(`Asset URL must be canonical for ${canonicalFilename}`);
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
      canonicalFilename,
    );
    const file = await stat(assetPath);
    if (file.size > maximumByteLength) {
      throw new Error(
        `Asset byte length ${file.size} exceeds the ${maximumByteLength} byte limit`,
      );
    }
    const bytes = await readFile(assetPath);
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
