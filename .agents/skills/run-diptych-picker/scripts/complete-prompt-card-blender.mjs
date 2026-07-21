#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  assertActiveJob,
  dataDirectory,
  JOB_ID,
  parseArgs,
  publishTerminal,
  required,
  reserveOutcome,
} from "./protocol-utils.mjs";

const nonBlankStringSchema = z.string().trim().min(1);
const proposalSchema = z
  .object({
    title: nonBlankStringSchema.max(80),
    prompt: nonBlankStringSchema.min(20).max(1_000),
    negativePrompt: z.string().max(500),
    tags: z.array(nonBlankStringSchema.max(40)).max(8),
    reasoningSummary: nonBlankStringSchema.max(1_000),
  })
  .strict();
const suggestionSchema = z.object({ proposal: proposalSchema }).strict();

const args = parseArgs(process.argv.slice(2));
const jobId = required(args, "job");
if (!JOB_ID.test(jobId)) throw new Error("Invalid prompt-card blender job ID");
const suggestion = suggestionSchema.parse(
  JSON.parse(await readFile(required(args, "suggestion-file"), "utf8")),
);
const mailbox = join(dataDirectory(), "agent-mailbox");
const activeJob = await assertActiveJob(mailbox, jobId);
if (activeJob.kind !== "prompt-card-blender") {
  throw new Error(`Job ${jobId} is not a prompt-card blender request`);
}

await reserveOutcome(mailbox, jobId, "completed");
const published = await publishTerminal(mailbox, jobId, "completed", {
  jobId,
  kind: "prompt-card-blender",
  status: "completed",
  completedAt: new Date().toISOString(),
  cardIds: activeJob.cards.map(({ id }) => id),
  proposal: suggestion.proposal,
});
process.stdout.write(`${JSON.stringify(published)}\n`);
