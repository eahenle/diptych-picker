#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertActiveJob,
  dataDirectory,
  JOB_ID,
  parseArgs,
  publishTerminal,
  required,
  reserveOutcome,
} from "./protocol-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const jobId = required(args, "job");
if (!JOB_ID.test(jobId)) throw new Error("Invalid generation job ID");
const message = (await readFile(required(args, "message-file"), "utf8")).trim();
if (!message) throw new Error("Failure message must not be blank");
const category = args.category ?? "operational";
if (!["operational", "moderation", "invalid-output"].includes(category)) {
  throw new Error(
    "Failure category must be operational, moderation, or invalid-output",
  );
}

const mailbox = join(dataDirectory(), "agent-mailbox");
await assertActiveJob(mailbox, jobId);
await reserveOutcome(mailbox, jobId, "failed");

const published = await publishTerminal(mailbox, jobId, "failed", {
  jobId,
  status: "failed",
  completedAt: new Date().toISOString(),
  message,
  retryable: true,
  category,
});
process.stdout.write(`${JSON.stringify(published)}\n`);
