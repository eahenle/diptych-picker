import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type {
  GenerationJob,
  GenerationMailbox,
  GenerationResult,
} from "./agent-mailbox";
import {
  CoProcChannelUnavailableError,
  CoProcDeliveryUnconfirmedError,
  CoProcGenerationChannelPool,
  CoProcGenerationTransport,
  TransportNotifyingGenerationMailbox,
  type GenerationChannelTransport,
  type GenerationTransport,
} from "./co-proc-generation-transport";

const execFileAsync = promisify(execFile);
const frameBufferSize = 4096;

async function readFrame(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<Record<string, unknown>> {
  const buffer = Buffer.alloc(frameBufferSize);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") {
        throw error;
      }
    }
    await delay(2);
  }
  throw new Error("Timed out waiting for co-proc test frame");
}

async function createSecureChannel(root: string, name: string) {
  const channel = join(root, name);
  const input = join(channel, "input");
  const output = join(channel, "output");
  await mkdir(channel, { mode: 0o700 });
  await execFileAsync("mkfifo", [input, output]);
  await chmod(input, 0o600);
  await chmod(output, 0o600);
  await writeFile(
    join(channel, "metadata.json"),
    `${JSON.stringify({
      version: 1,
      name,
      pid: process.pid,
      owner_uid: process.getuid?.(),
      started: 1,
      input,
      output,
    })}\n`,
    { mode: 0o600 },
  );
  return {
    input: await open(input, constants.O_RDWR | constants.O_NONBLOCK),
    output: await open(output, constants.O_RDWR | constants.O_NONBLOCK),
  };
}

function pendingJobPath(root: string, jobId = "job-1"): string {
  return join(root, "agent-mailbox", "pending", `${jobId}.json`);
}

async function claimDispatchedLease(
  dataRoot: string,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      join(
        process.cwd(),
        ".agents/skills/run-diptych-picker/scripts/claim-lease.mjs",
      ),
      "--job",
      String(frame.id),
      "--channel",
      "gen_a",
      "--lease-token",
      String(frame.lease_token),
      "--lease-ms",
      String(frame.lease_duration_ms),
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, LOCAL_DATA_DIR: dataRoot },
    },
  );
  return JSON.parse(stdout);
}

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

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
  it("dispatches after ready and requires a matching acknowledgement", async () => {
    const root = await mkdtemp(join(tmpdir(), "diptych-co-proc-"));
    const dataRoot = join(root, "data");
    const durableJobPath = pendingJobPath(dataRoot);
    await chmod(root, 0o700);
    await mkdir(dirname(durableJobPath), { recursive: true });
    await writeFile(durableJobPath, `${JSON.stringify(job())}\n`, "utf8");
    const peer = await createSecureChannel(root, "gen_a");
    const transport = new CoProcGenerationTransport({
      channel: "gen_a",
      runtimeRoot: root,
      readyTimeoutMs: 100,
      acknowledgementTimeoutMs: 100,
    });

    try {
      await peer.output.writeFile(
        `${JSON.stringify({
          version: 1,
          type: "ready",
          id: "gen_a",
        })}\n`,
      );
      const notification = transport.notify(job(), durableJobPath);
      const frame = await readFrame(peer.input);
      expect(frame).toMatchObject({
        version: 2,
        type: "gen",
        id: "job-1",
        kind: "refill",
        job_path: durableJobPath,
        lease_path: join(dataRoot, "agent-mailbox", "leases", "job-1.json"),
        lease_duration_ms: 120_000,
      });
      expect(frame.lease_token).toEqual(expect.any(String));
      const lease = await claimDispatchedLease(dataRoot, frame);
      await peer.output.writeFile(
        `${JSON.stringify({
          version: 2,
          type: "ack",
          id: "job-1",
          lease_token: frame.lease_token,
          lease_expires_at: lease.expiresAt,
        })}\n`,
      );
      await expect(notification).resolves.toBeUndefined();
    } finally {
      await peer.input.close();
      await peer.output.close();
    }
  });

  it("does not dispatch when a persistent worker is busy", async () => {
    const root = await mkdtemp(join(tmpdir(), "diptych-co-proc-"));
    await chmod(root, 0o700);
    const peer = await createSecureChannel(root, "gen_a");
    const transport = new CoProcGenerationTransport({
      channel: "gen_a",
      runtimeRoot: root,
      readyTimeoutMs: 100,
    });

    try {
      await peer.output.writeFile(
        `${JSON.stringify({
          version: 1,
          type: "busy",
          id: "gen_a",
        })}\n`,
      );
      await expect(
        transport.notify(job(), pendingJobPath(root)),
      ).rejects.toBeInstanceOf(CoProcChannelUnavailableError);
    } finally {
      await peer.input.close();
      await peer.output.close();
    }
  });

  it("reports an unconfirmed delivery after dispatch without acknowledgement", async () => {
    const root = await mkdtemp(join(tmpdir(), "diptych-co-proc-"));
    await chmod(root, 0o700);
    const peer = await createSecureChannel(root, "gen_a");
    const transport = new CoProcGenerationTransport({
      channel: "gen_a",
      runtimeRoot: root,
      readyTimeoutMs: 100,
      acknowledgementTimeoutMs: 20,
    });

    try {
      await peer.output.writeFile(
        `${JSON.stringify({
          version: 1,
          type: "ready",
          id: "gen_a",
        })}\n`,
      );
      const notification = transport.notify(job(), pendingJobPath(root));
      await readFrame(peer.input);
      await expect(notification).rejects.toBeInstanceOf(
        CoProcDeliveryUnconfirmedError,
      );
    } finally {
      await peer.input.close();
      await peer.output.close();
    }
  });

  it("rejects an acknowledgement without its matching durable lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "diptych-co-proc-"));
    await chmod(root, 0o700);
    const peer = await createSecureChannel(root, "gen_a");
    const transport = new CoProcGenerationTransport({
      channel: "gen_a",
      runtimeRoot: root,
      readyTimeoutMs: 100,
      acknowledgementTimeoutMs: 100,
    });

    try {
      await peer.output.writeFile(
        `${JSON.stringify({
          version: 1,
          type: "ready",
          id: "gen_a",
        })}\n`,
      );
      const notification = transport.notify(job(), pendingJobPath(root));
      const frame = await readFrame(peer.input);
      await peer.output.writeFile(
        `${JSON.stringify({
          version: 2,
          type: "ack",
          id: "job-1",
          lease_token: frame.lease_token,
          lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
        })}\n`,
      );
      await expect(notification).rejects.toBeInstanceOf(
        CoProcDeliveryUnconfirmedError,
      );
    } finally {
      await peer.input.close();
      await peer.output.close();
    }
  });

  it("does not retry another channel after an unacknowledged dispatch", async () => {
    const first: GenerationChannelTransport = {
      channel: "gen_a",
      notify: vi.fn(async () => {
        throw new CoProcDeliveryUnconfirmedError(
          "gen_a",
          "job-1",
          "acknowledgement timed out",
        );
      }),
    };
    const second: GenerationChannelTransport = {
      channel: "gen_b",
      notify: vi.fn(async () => {}),
    };
    const transport = new CoProcGenerationChannelPool([first, second]);

    await expect(
      transport.notify(job(), "/mailbox/pending/job-1.json"),
    ).rejects.toBeInstanceOf(CoProcDeliveryUnconfirmedError);
    expect(first.notify).toHaveBeenCalledOnce();
    expect(second.notify).not.toHaveBeenCalled();
  });

  it("routes around an unavailable channel without overcommitting a busy one", async () => {
    const first: GenerationChannelTransport = {
      channel: "gen_a",
      notify: vi.fn(async () => {
        throw new CoProcChannelUnavailableError("gen_a", "worker is busy");
      }),
    };
    const second: GenerationChannelTransport = {
      channel: "gen_b",
      notify: vi.fn(async () => {}),
    };
    const transport = new CoProcGenerationChannelPool([first, second]);

    await expect(
      transport.notify(job(), "/mailbox/pending/job-1.json"),
    ).resolves.toBeUndefined();
    expect(first.notify).toHaveBeenCalledOnce();
    expect(second.notify).toHaveBeenCalledOnce();
  });

  it("uses every ready channel once before reporting the pool busy", async () => {
    const gates = [deferred(), deferred(), deferred()];
    const channels = gates.map((gate, index): GenerationChannelTransport => ({
      channel: `gen_${index + 1}`,
      notify: vi.fn(async () => gate.promise),
    }));
    const transport = new CoProcGenerationChannelPool(channels);
    const notifications = channels.map((_, index) =>
      transport.notify(
        { ...job(), id: `job-${index + 1}` },
        `/mailbox/pending/job-${index + 1}.json`,
      ),
    );

    await expect(
      transport.notify(
        { ...job(), id: "job-4" },
        "/mailbox/pending/job-4.json",
      ),
    ).rejects.toBeInstanceOf(CoProcChannelUnavailableError);
    for (const channel of channels) {
      expect(channel.notify).toHaveBeenCalledOnce();
    }

    for (const gate of gates) {
      gate.resolve();
    }
    await expect(Promise.all(notifications)).resolves.toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("keeps the persistent generation pool within the worker limit", () => {
    expect(
      () =>
        new CoProcGenerationChannelPool(
          ["gen_1", "gen_2", "gen_3", "gen_4"].map(
            (channel): GenerationChannelTransport => ({
              channel,
              notify: vi.fn(async () => {}),
            }),
          ),
        ),
    ).toThrow(/at most three/i);
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

    await expect(transport.notify(job(), pendingJobPath(root))).rejects.toThrow(
      /fifo/i,
    );
  });
});
