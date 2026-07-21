import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ExportArtifactExtension = "json" | "png" | "svg" | "webp";

export interface PublishedExportArtifact {
  digest: string;
  filename: string;
  path: string;
}

export function contentDigest(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

export function contentAddressedFilename(
  contents: Uint8Array,
  extension: ExportArtifactExtension,
): string {
  return `${contentDigest(contents)}.${extension}`;
}

export async function publishImmutableFile(
  path: string,
  contents: Buffer,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(
    dirname(path),
    `.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(temporaryPath, contents, { flag: "wx" });
  try {
    await link(temporaryPath, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(path);
    if (!existing.equals(contents)) {
      throw new Error(`Existing immutable file ${path} differs from source`);
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function publishExportArtifact(
  contents: Buffer,
  extension: ExportArtifactExtension,
  directory: string,
): Promise<PublishedExportArtifact> {
  const digest = contentDigest(contents);
  const filename = `${digest}.${extension}`;
  const path = join(/*turbopackIgnore: true*/ directory, filename);
  await publishImmutableFile(path, contents);
  return { digest, filename, path };
}
