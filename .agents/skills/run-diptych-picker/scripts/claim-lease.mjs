#!/usr/bin/env node

import { join } from "node:path";
import {
  claimJobLease,
  dataDirectory,
  JOB_ID,
  parseArgs,
  required,
} from "./protocol-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const jobId = required(args, "job");
if (!JOB_ID.test(jobId)) throw new Error("Invalid generation job ID");

const lease = await claimJobLease(
  join(dataDirectory(), "agent-mailbox"),
  jobId,
  required(args, "channel"),
  required(args, "lease-token"),
  required(args, "lease-ms"),
);
process.stdout.write(`${JSON.stringify(lease)}\n`);
