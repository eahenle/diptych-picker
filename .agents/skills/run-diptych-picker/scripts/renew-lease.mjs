#!/usr/bin/env node

import { join } from "node:path";
import {
  dataDirectory,
  JOB_ID,
  parseArgs,
  renewJobLease,
  required,
} from "./protocol-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const jobId = required(args, "job");
if (!JOB_ID.test(jobId)) throw new Error("Invalid generation job ID");

const lease = await renewJobLease(
  join(dataDirectory(), "agent-mailbox"),
  jobId,
  required(args, "lease-token"),
  required(args, "lease-ms"),
);
process.stdout.write(`${JSON.stringify(lease)}\n`);
