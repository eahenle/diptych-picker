import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import type { PreferenceRevision } from "@/domain/game";
import type { SourceProfileMailbox } from "./agent-mailbox";

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_DIMENSION = 4096;
const MAX_SOURCE_PIXELS = MAX_SOURCE_DIMENSION * MAX_SOURCE_DIMENSION;
const ACCEPTED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export class SourceProfileInputError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export class SourceProfileNotFoundError extends Error {}

export interface NormalizedProfileSource {
  filename: string;
  path: string;
  contentType: "image/png";
  width: number;
  height: number;
  byteLength: number;
}

export async function normalizeProfileSource(
  contents: Uint8Array,
  contentType: string,
  sourceDirectory: string,
): Promise<NormalizedProfileSource> {
  if (!ACCEPTED_CONTENT_TYPES.has(contentType)) {
    throw new SourceProfileInputError(
      "Choose a PNG, JPEG, or WebP source image.",
    );
  }
  if (contents.byteLength === 0) {
    throw new SourceProfileInputError("The source image is empty.");
  }
  if (contents.byteLength > MAX_SOURCE_BYTES) {
    throw new SourceProfileInputError(
      "Source images must not exceed 20 MB.",
      413,
    );
  }

  let normalized: Buffer;
  let width: number;
  let height: number;
  try {
    const result = await sharp(contents, {
      animated: false,
      failOn: "error",
      limitInputPixels: MAX_SOURCE_PIXELS,
    })
      .rotate()
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
    normalized = result.data;
    width = result.info.width;
    height = result.info.height;
  } catch {
    throw new SourceProfileInputError(
      "The source image could not be decoded or exceeds 4096 by 4096 pixels.",
    );
  }
  if (
    width < 1 ||
    height < 1 ||
    width > MAX_SOURCE_DIMENSION ||
    height > MAX_SOURCE_DIMENSION
  ) {
    throw new SourceProfileInputError(
      "Source image dimensions must not exceed 4096 by 4096 pixels.",
    );
  }

  const filename = `${createHash("sha256").update(normalized).digest("hex")}.png`;
  const sourcePath = resolve(sourceDirectory, filename);
  await mkdir(sourceDirectory, { recursive: true });
  try {
    await writeFile(sourcePath, normalized, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await readFile(sourcePath)).equals(normalized)) {
      throw new Error(
        `Existing private source ${sourcePath} differs from input`,
      );
    }
  }

  return {
    filename,
    path: `profile-sources/${filename}`,
    contentType: "image/png",
    width,
    height,
    byteLength: normalized.byteLength,
  };
}

export type SourceProfileStatus =
  | { status: "analyzing"; jobId: string }
  | {
      status: "completed";
      jobId: string;
      profile: PreferenceRevision;
      reasoningSummary: string;
    }
  | { status: "failed"; jobId: string; message: string };

interface SourceProfileServiceOptions {
  mailbox: SourceProfileMailbox;
  sourceDirectory: string;
  createId?: () => string;
  now?: () => string;
}

export class SourceProfileService {
  private readonly createId: () => string;
  private readonly now: () => string;

  constructor(private readonly options: SourceProfileServiceOptions) {
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async request(
    contents: Uint8Array,
    contentType: string,
  ): Promise<{ status: "analyzing"; jobId: string }> {
    const sourceImage = await normalizeProfileSource(
      contents,
      contentType,
      this.options.sourceDirectory,
    );

    const jobId = this.createId();
    await this.options.mailbox.enqueueSourceProfile({
      id: jobId,
      kind: "source-profile",
      createdAt: this.now(),
      sourceImage,
    });
    return { status: "analyzing", jobId };
  }

  async status(jobId: string): Promise<SourceProfileStatus> {
    const work = await this.options.mailbox.readSourceProfileWork(jobId);
    if (!work || work.kind !== "source-profile") {
      throw new SourceProfileNotFoundError(
        "That source-image analysis is no longer available.",
      );
    }
    const result = await this.options.mailbox.readSourceProfileResult(jobId);
    if (!result) return { status: "analyzing", jobId };
    if (result.status === "failed") {
      return { status: "failed", jobId, message: result.message };
    }
    return {
      status: "completed",
      jobId,
      profile: result.profile,
      reasoningSummary: result.reasoningSummary,
    };
  }

  async acknowledge(jobId: string): Promise<void> {
    const work = await this.options.mailbox.readSourceProfileWork(jobId);
    if (!work || work.kind !== "source-profile") {
      throw new SourceProfileNotFoundError(
        "That source-image analysis is no longer available.",
      );
    }
    await this.options.mailbox.archiveSourceProfile(jobId);
  }
}
