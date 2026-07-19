import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type {
  GenerationJob,
  GenerationMailbox,
  GenerationResult,
} from "./agent-mailbox";
import {
  CoProcGenerationTransport,
  TransportNotifyingGenerationMailbox,
  type GenerationTransport,
} from "./co-proc-generation-transport";

const execFileAsync = promisify(execFile);

const job = (): GenerationJob => ({
  id: "job-1",
  kind: "refill",
  createdAt: "2026-07-19T01:00:00.000Z",
  roundNumber: 4,
  winnerSide: "left",
  retainedWinner: {
    id: "winner",
    imageUrl: "/api/assets/winner.png",
    prompt: "winner prompt",
    concept: "winner concept",
    style: ["cinematic"],
    createdAt: "2026-07-19T00:00:00.000Z",
    winCount: 2,
  },
  rejectedCandidate: {
    id: "loser",
    imageUrl: "/api/assets/loser.png",
    prompt: "loser prompt",
    concept: "loser concept",
    style: ["graphic"],
    createdAt: "2026-07-19T00:00:00.000Z",
    winCount: 0,
  },
  selectionHistory: [],
  recentConcepts: ["recent concept"],
  preferenceSeed: "precise and surprising",
  sessionId: "session-1",
  pinnedWinnerId: "winner",
});

class MemoryMailbox implements GenerationMailbox {
  enqueued: GenerationJob[] = [];

  async enqueue(value: GenerationJob): Promise<void> {
    this.enqueued.push(value);
  }

  async readPending(): Promise<GenerationJob | null> {
    return null;
  }

  async readWork(): Promise<GenerationJob | null> {
    return null;
  }

  async readResult(): Promise<GenerationResult | null> {
    return null;
  }

  async archive(): Promise<void> {}
}

describe("TransportNotifyingGenerationMailbox", () => {
  it("publishes durably before notifying the live transport", async () => {
    const mailbox = new MemoryMailbox();
    const calls: string[] = [];
    const transport: GenerationTransport = {
      notify: vi.fn(async (value, path) => {
        calls.push(`notify:${value.id}:${path}`);
        expect(mailbox.enqueued).toEqual([value]);
      }),
    };
    const adapter = new TransportNotifyingGenerationMailbox(
      mailbox,
      transport,
      { durableJobPath: (value) => `/mailbox/pending/${value.id}.json` },
    );

    await adapter.enqueue(job());

    expect(calls).toEqual(["notify:job-1:/mailbox/pending/job-1.json"]);
  });

  it("keeps the durable job when live notification is unavailable", async () => {
    const mailbox = new MemoryMailbox();
    const onTransportError = vi.fn();
    const transport: GenerationTransport = {
      notify: vi.fn(async () => {
        throw new Error("channel unavailable");
      }),
    };
    const adapter = new TransportNotifyingGenerationMailbox(
      mailbox,
      transport,
      {
        durableJobPath: (value) => `/mailbox/pending/${value.id}.json`,
        onTransportError,
      },
    );

    await expect(adapter.enqueue(job())).resolves.toBeUndefined();
    expect(mailbox.enqueued).toEqual([job()]);
    expect(onTransportError).toHaveBeenCalledWith(expect.any(Error), job());
  });
});

describe("CoProcGenerationTransport", () => {
  it("writes one compact notification to a secure live FIFO", async () => {
    const root = await mkdtemp(join(tmpdir(), "diptych-co-proc-"));
    const channel = join(root, "gen_a");
    const input = join(channel, "input");
    const output = join(channel, "output");
    const durableJobPath = join(root, "mailbox", "pending", "job-1.json");
    await chmod(root, 0o700);
    await mkdir(channel, { mode: 0o700 });
    await execFileAsync("mkfifo", [input, output]);
    await chmod(input, 0o600);
    await chmod(output, 0o600);
    await mkdir(join(root, "mailbox", "pending"), { recursive: true });
    await writeFile(durableJobPath, "{}\n", "utf8");
    await writeFile(
      join(channel, "metadata.json"),
      `${JSON.stringify({
        version: 1,
        name: "gen_a",
        pid: process.pid,
        owner_uid: process.getuid?.(),
        started: 1,
        input,
        output,
      })}\n`,
      { mode: 0o600 },
    );
    const reader = await open(input, constants.O_RDONLY | constants.O_NONBLOCK);
    const transport = new CoProcGenerationTransport({
      channel: "gen_a",
      runtimeRoot: root,
    });

    try {
      await transport.notify(job(), durableJobPath);
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await reader.read(buffer, 0, buffer.length, null);
      expect(
        JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")),
      ).toEqual({
        version: 1,
        type: "gen",
        id: "job-1",
        kind: "refill",
        job_path: durableJobPath,
      });
    } finally {
      await reader.close();
    }
  });

  it("rejects an insecure or non-FIFO endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "diptych-co-proc-"));
    const channel = join(root, "gen_a");
    const input = join(channel, "input");
    const output = join(channel, "output");
    await chmod(root, 0o700);
    await mkdir(channel, { mode: 0o700 });
    await writeFile(input, "not a fifo", { mode: 0o600 });
    await writeFile(
      join(channel, "metadata.json"),
      `${JSON.stringify({
        version: 1,
        name: "gen_a",
        pid: process.pid,
        owner_uid: process.getuid?.(),
        started: 1,
        input,
        output,
      })}\n`,
      { mode: 0o600 },
    );
    const transport = new CoProcGenerationTransport({
      channel: "gen_a",
      runtimeRoot: root,
    });

    await expect(
      transport.notify(job(), join(root, "job.json")),
    ).rejects.toThrow(/fifo/i);
  });
});
