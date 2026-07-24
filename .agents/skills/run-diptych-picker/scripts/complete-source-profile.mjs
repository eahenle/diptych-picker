#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  assertActiveJob,
  dataDirectory,
  JOB_ID,
  LEASE_TOKEN,
  parseArgs,
  publishTerminal,
  required,
  reserveOutcome,
} from "./protocol-utils.mjs";

const nonBlankStringSchema = z.string().trim().min(1);
const profileSchema = z
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
const analysisSchema = z
  .object({
    profile: profileSchema,
    reasoningSummary: nonBlankStringSchema.max(2_000),
  })
  .strict();

const args = parseArgs(process.argv.slice(2));
const jobId = required(args, "job");
if (!JOB_ID.test(jobId)) throw new Error("Invalid profile-analysis job ID");
const leaseToken = args["lease-token"];
if (leaseToken !== undefined && !LEASE_TOKEN.test(leaseToken)) {
  throw new Error("Invalid lease token");
}
const analysis = analysisSchema.parse(
  JSON.parse(await readFile(required(args, "profile-file"), "utf8")),
);
const mailbox = join(dataDirectory(), "agent-mailbox");
const activeJob = await assertActiveJob(mailbox, jobId, leaseToken);
if (
  activeJob.kind !== "source-profile" &&
  activeJob.kind !== "leaderboard-profile"
) {
  throw new Error(`Job ${jobId} is not a profile analysis`);
}
const sourceImages =
  activeJob.kind === "source-profile"
    ? [activeJob.sourceImage]
    : activeJob.sources.map(({ sourceImage }) => sourceImage);
for (const sourceImage of sourceImages) {
  const sourceStat = await stat(join(dataDirectory(), sourceImage.path));
  if (!sourceStat.isFile() || sourceStat.size !== sourceImage.byteLength) {
    throw new Error("Source image no longer matches the active analysis job");
  }
}

await reserveOutcome(mailbox, jobId, "completed", leaseToken);
const published = await publishTerminal(mailbox, jobId, "completed", {
  jobId,
  kind: activeJob.kind,
  status: "completed",
  completedAt: new Date().toISOString(),
  ...(activeJob.kind === "leaderboard-profile"
    ? { fingerprint: activeJob.fingerprint }
    : {}),
  ...analysis,
});
process.stdout.write(`${JSON.stringify(published)}\n`);
