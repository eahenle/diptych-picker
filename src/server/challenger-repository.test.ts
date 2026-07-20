import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { ChallengerState } from "@/domain/challenger-state";
import type { GenerationJob } from "./agent-mailbox";
import {
  JsonChallengerRepository,
  MemoryChallengerRepository,
  type ChallengerRepository,
} from "./challenger-repository";

const candidate = (id: string) => ({
  id,
  imageUrl: `/api/assets/${id}.png`,
  prompt: `${id} prompt`,
  concept: `${id} concept`,
  style: ["etched", "cinematic"],
  createdAt: "2026-07-16T20:00:00.000Z",
  winCount: 0,
});

const expectedRefillJob: GenerationJob = {
  id: "job-1",
  kind: "refill",
  createdAt: "2026-07-16T20:02:00.000Z",
  roundNumber: 3,
  winnerSide: "left",
  retainedWinner: candidate("winner-1"),
  rejectedCandidate: candidate("loser-1"),
  selectionHistory: [],
  recentConcepts: ["older concept"],
  preferenceSeed: "industrial and strange",
  sessionId: "session-1",
  pinnedWinnerId: "winner-1",
};

const populatedState: ChallengerState = {
  version: 1,
  sessionId: "session-1",
  ready: [
    {
      candidate: candidate("ready-1"),
      source: "generated",
      pinnedWinnerId: "winner-1",
      enqueuedAt: "2026-07-16T20:01:00.000Z",
    },
  ],
  refillJobs: [
    {
      jobId: "job-1",
      pinnedWinnerId: "winner-1",
      enqueuedAt: "2026-07-16T20:02:00.000Z",
      expectedJob: expectedRefillJob,
    },
  ],
  pendingComparison: null,
  pendingSelectionBaseline: null,
  ratings: [
    {
      candidate: candidate("winner-1"),
      rating: 1016,
      wins: 1,
      losses: 0,
      source: "curated",
      poolMember: true,
      favorite: true,
      lastServedAt: "2026-07-16T20:03:00.000Z",
    },
  ],
  generationTurnaroundEmaMs: 240_000,
  consecutiveFallbackDraws: 2,
  nextFallbackAt: "2026-07-16T20:05:00.000Z",
};

async function expectSessionReset(
  repository: ChallengerRepository,
): Promise<void> {
  await repository.save(populatedState);
  await repository.clearSession("next-session");

  await expect(repository.load()).resolves.toEqual({
    ...populatedState,
    sessionId: "next-session",
    ready: [],
    refillJobs: [],
    consecutiveFallbackDraws: 0,
    nextFallbackAt: null,
  });
}

describe("JsonChallengerRepository", () => {
  it("strictly persists the complete expected refill job snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-refill-intent-"));
    const file = join(directory, "challenger-state.json");
    const repository = new JsonChallengerRepository(file);
    const expanded = {
      ...populatedState,
      refillJobs: [
        {
          ...populatedState.refillJobs[0],
          expectedJob: expectedRefillJob,
        },
      ],
    } as ChallengerState;

    await repository.save(expanded);

    await expect(repository.load()).resolves.toEqual(expanded);
  });

  it("atomically persists validated challenger state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-challengers-"));
    const file = join(directory, "challenger-state.json");
    const repository = new JsonChallengerRepository(file);

    await repository.save(populatedState);

    await expect(new JsonChallengerRepository(file).load()).resolves.toEqual(
      populatedState,
    );
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(populatedState);
    expect(await readdir(directory)).toEqual(["challenger-state.json"]);
  });

  it("rejects corrupt JSON instead of treating it as empty state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-corrupt-"));
    const file = join(directory, "challenger-state.json");
    await writeFile(file, "{not-json\n", "utf8");

    await expect(new JsonChallengerRepository(file).load()).rejects.toThrow();
  });

  it("rejects persisted null as invalid challenger state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-null-"));
    const file = join(directory, "challenger-state.json");
    await writeFile(file, "null\n", "utf8");

    await expect(
      new JsonChallengerRepository(file).load(),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("strictly validates loaded and saved state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-invalid-"));
    const file = join(directory, "challenger-state.json");
    const repository = new JsonChallengerRepository(file);
    await repository.save(populatedState);
    const invalidState = {
      ...populatedState,
      unexpected: true,
    } as ChallengerState;

    await expect(repository.save(invalidState)).rejects.toThrow();
    await expect(repository.load()).resolves.toEqual(populatedState);

    await writeFile(file, JSON.stringify(invalidState), "utf8");
    await expect(repository.load()).rejects.toThrow();
  });

  it("clears session data without erasing learned ratings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-session-"));
    await expectSessionReset(
      new JsonChallengerRepository(join(directory, "challenger-state.json")),
    );
  });

  it("serializes transactions across repository instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-lock-"));
    const file = join(directory, "challenger-state.json");
    const first = new JsonChallengerRepository(file);
    const second = new JsonChallengerRepository(file);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const order: string[] = [];

    const firstTransaction = first.withLock(async () => {
      order.push("first-entered");
      signalEntered();
      await held;
      order.push("first-leaving");
    });
    await entered;
    const secondTransaction = second.withLock(async () => {
      order.push("second-entered");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(order).toEqual(["first-entered"]);
    release();
    await Promise.all([firstTransaction, secondTransaction]);
    expect(order).toEqual(["first-entered", "first-leaving", "second-entered"]);
  });
});

describe("MemoryChallengerRepository", () => {
  it("clears session data without erasing learned ratings", async () => {
    await expectSessionReset(new MemoryChallengerRepository());
  });

  it("serializes concurrent transactions", async () => {
    const repository = new MemoryChallengerRepository();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const order: string[] = [];

    const first = repository.withLock(async () => {
      order.push("first");
      signalEntered();
      await held;
    });
    await entered;
    const second = repository.withLock(async () => {
      order.push("second");
    });

    expect(order).toEqual(["first"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });
});
