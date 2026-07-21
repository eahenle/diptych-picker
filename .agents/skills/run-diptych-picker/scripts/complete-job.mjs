#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import {
  atomicCreateFile,
  assertActiveJob,
  dataDirectory,
  exportDirectory,
  JOB_ID,
  parseArgs,
  publishTerminal,
  required,
  reserveOutcome,
} from "./protocol-utils.mjs";

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_DIMENSION = 4096;
const MAX_PIXELS = MAX_DIMENSION * MAX_DIMENSION;
const nonBlankStringSchema = z.string().trim().min(1);
const preferenceRevisionSchema = z
  .object({
    themes: nonBlankStringSchema.min(20).max(2_000),
    inspiration: z.string().trim().max(1_000),
    mediaTypes: z.string().trim().max(500),
    visualStyle: z.string().trim().max(500),
    colorPalette: z.string().trim().max(500),
    contentLevel: z.enum(["family-friendly", "adult-allowed"]),
    avoid: z.string().trim().max(800),
  })
  .strict();
const proposalSchema = z
  .object({
    concept: nonBlankStringSchema,
    visualPrompt: nonBlankStringSchema,
    styleTags: z.array(nonBlankStringSchema),
    reasoningSummary: nonBlankStringSchema,
    preferenceRevision: preferenceRevisionSchema.optional(),
  })
  .strict();

const args = parseArgs(process.argv.slice(2));
const jobId = required(args, "job");
if (!JOB_ID.test(jobId)) throw new Error("Invalid generation job ID");
const proposal = proposalSchema.parse(
  JSON.parse(await readFile(required(args, "proposal-file"), "utf8")),
);
const imagePath = required(args, "image");
const root = dataDirectory();
const mailbox = join(root, "agent-mailbox");

const activeJob = await assertActiveJob(mailbox, jobId);
if (
  activeJob.kind === "source-profile" ||
  activeJob.kind === "leaderboard-profile" ||
  activeJob.kind === "prompt-card-editor" ||
  activeJob.kind === "prompt-card-blender"
) {
  throw new Error("Non-image jobs must use their dedicated completion command");
}
const adaptationMode =
  activeJob.preferenceProfile?.adaptationMode ??
  activeJob.preferenceProfile?.inspirationMode ??
  "static";
if (adaptationMode === "adaptive" && !proposal.preferenceRevision) {
  throw new Error("Adaptive jobs require a complete preferenceRevision");
}
if (adaptationMode !== "adaptive" && proposal.preferenceRevision) {
  throw new Error("Static jobs must omit preferenceRevision");
}
const imageStat = await stat(imagePath);
if (!imageStat.isFile()) throw new Error("Image path must be a regular file");
if (imageStat.size > MAX_IMAGE_BYTES) {
  throw new Error("PNG input must not exceed 50 MB");
}
const source = await readFile(imagePath);
if (source.byteLength > MAX_IMAGE_BYTES) {
  throw new Error("PNG input must not exceed 50 MB");
}

let metadata;
try {
  metadata = await sharp(source, {
    animated: true,
    failOn: "error",
    limitInputPixels: MAX_PIXELS,
  }).metadata();
} catch (error) {
  if (/pixel limit/i.test(error.message)) {
    throw new Error("PNG exceeds the 4096 by 4096 pixel limit");
  }
  throw error;
}
if (metadata.format !== "png") throw new Error("Image must be a PNG");
if ((metadata.pages ?? 1) !== 1) {
  throw new Error("Image must contain exactly one PNG frame");
}
if (!metadata.width || !metadata.height || metadata.width !== metadata.height) {
  throw new Error("Image must be square");
}
if (metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION) {
  throw new Error("PNG dimensions must not exceed 4096 by 4096 pixels");
}

const decoded = await sharp(source, {
  animated: true,
  failOn: "error",
  limitInputPixels: MAX_PIXELS,
})
  .raw()
  .toBuffer({ resolveWithObject: true });
if (
  decoded.info.width !== metadata.width ||
  decoded.info.height !== metadata.height
) {
  throw new Error("Decoded PNG dimensions do not match its metadata");
}

await reserveOutcome(mailbox, jobId, "completed");

const candidateId = `challenger-${jobId}`;
const filename = `${createHash("sha256").update(source).digest("hex")}.png`;
const assets = join(root, "assets");
const assetPath = join(assets, filename);
await mkdir(assets, { recursive: true });
if (!(await atomicCreateFile(assetPath, source))) {
  const existing = await readFile(assetPath);
  if (!existing.equals(source)) {
    throw new Error(`Existing immutable asset ${filename} differs from source`);
  }
}
const exportedAssetPath = join(exportDirectory(), filename);
if (!(await atomicCreateFile(exportedAssetPath, source))) {
  const existing = await readFile(exportedAssetPath);
  if (!existing.equals(source)) {
    throw new Error(`Existing export artifact ${filename} differs from source`);
  }
}

const published = await publishTerminal(mailbox, jobId, "completed", {
  jobId,
  status: "completed",
  completedAt: new Date().toISOString(),
  proposal,
  asset: {
    candidateId,
    filename,
    imageUrl: `/api/assets/${filename}`,
    contentType: "image/png",
    width: metadata.width,
    height: metadata.height,
    byteLength: source.byteLength,
  },
});
process.stdout.write(`${JSON.stringify(published)}\n`);
