#!/usr/bin/env node

import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const status = args.status ?? "waiting";
const jobId = args.job;
if (!/^[a-z][a-z0-9-]*$/.test(status)) {
  throw new Error("--status must be a lowercase status name");
}
if (jobId && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(jobId)) {
  throw new Error("Invalid generation job ID");
}

const mailbox = join(
  resolve(process.cwd(), process.env.LOCAL_DATA_DIR ?? ".local-data"),
  "agent-mailbox",
);
await mkdir(mailbox, { recursive: true });
const destination = join(mailbox, "heartbeat.json");
const temporary = join(
  mailbox,
  `.heartbeat.${process.pid}.${crypto.randomUUID()}.tmp`,
);
const heartbeat = {
  status,
  ...(jobId ? { jobId } : {}),
  updatedAt: new Date().toISOString(),
};
await writeFile(temporary, `${JSON.stringify(heartbeat, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
});
await rename(temporary, destination);
process.stdout.write(`${JSON.stringify(heartbeat)}\n`);

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? "end of command"}`);
    }
    parsed[key.slice(2)] = value;
  }
  return parsed;
}
