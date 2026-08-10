#!/usr/bin/env node

import { readFile } from "node:fs/promises";
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
const annotationSchema = z
  .object({
    concept: nonBlankStringSchema.max(240),
    prompt: nonBlankStringSchema.max(1_000),
    style: z
      .array(nonBlankStringSchema.max(80))
      .min(1)
      .max(8)
      .superRefine((style, context) => {
        if (new Set(style).size !== style.length) {
          context.addIssue({
            code: "custom",
            message: "Annotation style tags must be unique",
          });
        }
      }),
    reasoningSummary: nonBlankStringSchema.max(2_000),
    source: z.enum(["automated", "manual"]),
  })
  .strict();

const args = parseArgs(process.argv.slice(2));
const jobId = required(args, "job");
if (!JOB_ID.test(jobId)) throw new Error("Invalid import-annotation job ID");
const leaseToken = args["lease-token"];
if (leaseToken !== undefined && !LEASE_TOKEN.test(leaseToken)) {
  throw new Error("Invalid lease token");
}
const annotation = annotationSchema.parse(
  JSON.parse(await readFile(required(args, "annotation-file"), "utf8")),
);
const mailbox = join(dataDirectory(), "agent-mailbox");
const activeJob = await assertActiveJob(mailbox, jobId, leaseToken);
if (activeJob.kind !== "import-annotation") {
  throw new Error(`Job ${jobId} is not an import annotation request`);
}

await reserveOutcome(mailbox, jobId, "completed", leaseToken);
const published = await publishTerminal(mailbox, jobId, "completed", {
  jobId,
  kind: "import-annotation",
  status: "completed",
  completedAt: new Date().toISOString(),
  annotation: { ...annotation, source: "automated" },
});
process.stdout.write(`${JSON.stringify(published)}\n`);
