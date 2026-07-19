import { createHash } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";

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

export async function publishExportArtifact(
  contents: Buffer,
  extension: ExportArtifactExtension,
  directory: string,
): Promise<PublishedExportArtifact> {
  const digest = contentDigest(contents);
  const filename = `${digest}.${extension}`;
  const path = join(/*turbopackIgnore: true*/ directory, filename);
  await mkdir(/* turbopackIgnore: true */ directory, { recursive: true });
  try {
    await writeFile(/* turbopackIgnore: true */ path, contents, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existingFile = await open(/* turbopackIgnore: true */ path, "r");
    let existing: Buffer;
    try {
      existing = await existingFile.readFile();
    } finally {
      await existingFile.close();
    }
    if (!existing.equals(contents)) {
      throw new Error(
        `Existing export artifact ${filename} differs from source`,
      );
    }
  }
  return { digest, filename, path };
}
