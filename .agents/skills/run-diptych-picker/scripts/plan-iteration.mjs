#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  generationIterationPlanSchema,
  iterationDirectionSchema,
  iterationJobContextSchema,
  iterationPlanningEvidenceSchema,
  planImageIteration,
} from "../../../../src/domain/image-iteration.ts";
import {
  assertActiveJob,
  dataDirectory,
  JOB_ID,
  parseArgs,
  required,
} from "./protocol-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const jobId = required(args, "job");
if (!JOB_ID.test(jobId)) throw new Error("Invalid generation job ID");
const root = dataDirectory();
const job = await assertActiveJob(join(root, "agent-mailbox"), jobId);
if (job.kind !== "challenger")
  throw new Error("Expected an Explore challenger job");
const context = iterationJobContextSchema.parse(job.iterationContext);
const requested = generationIterationPlanSchema.parse(job.iterationPlan);
const filename = basename(context.sourceImageUrl);
const sourcePath = context.sourceImageUrl.startsWith("/seed-assets/")
  ? join(process.cwd(), "public", "seed-assets", filename)
  : join(root, "assets", filename);
const bytes = await readFile(sourcePath);
if (
  createHash("sha256").update(bytes).digest("hex") !== context.sourceImageSha256
) {
  throw new Error("The variation source image changed since it was selected");
}
const evidence = iterationPlanningEvidenceSchema.parse(
  JSON.parse(await readFile(required(args, "observations-file"), "utf8")),
);
const planned = planImageIteration({
  ...evidence,
  command: context.command,
  subject: {
    ...evidence.subject,
    mandatoryAnchors: [
      ...requested.mandatoryAnchors,
      ...evidence.subject.mandatoryAnchors,
    ],
    exclusions: [
      ...requested.exclusions,
      ...(evidence.subject.exclusions ?? []),
    ],
  },
  contentLevel: job.preferenceProfile?.contentLevel ?? "family-friendly",
  history: context.history,
});
if (planned.status === "blocked") {
  throw new Error(
    `Image iteration is blocked (${planned.reason})${"conflictingAnchors" in planned ? `: ${planned.conflictingAnchors.join(", ")}` : ""}`,
  );
}
const { plan } = planned;
const iterationDirection = iterationDirectionSchema.parse({
  plan: {
    temperature: plan.temperature,
    mandatoryAnchors: plan.mandatoryAnchors,
    optionalAnchors: plan.optionalAnchors,
    exclusions: plan.exclusions,
  },
  changedAxes: plan.changedAxes.map(({ axis }) => axis),
});
process.stdout.write(`${JSON.stringify({ plan, iterationDirection })}\n`);
