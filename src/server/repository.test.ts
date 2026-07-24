import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonGameRepository, MemoryGameRepository } from "./repository";
import { preferenceProfileFromSeed, type GameState } from "@/domain/game";

const state: GameState = {
  round: {
    leftCandidate: {
      id: "a",
      imageUrl: "/a.png",
      prompt: "a",
      concept: "a",
      style: [],
      createdAt: "now",
      winCount: 2,
    },
    rightCandidate: {
      id: "b",
      imageUrl: "/b.png",
      prompt: "b",
      concept: "b",
      style: [],
      createdAt: "now",
      winCount: 0,
    },
    status: "idle",
    replacingSide: null,
    roundNumber: 4,
    retainedCandidateId: "a",
    winStreak: 2,
  },
  history: [],
  preferenceSeed: "seed",
  gameRules: {
    bufferTarget: 4,
    poolMaximum: 24,
    championRetirementStreak: 8,
    fallbackMaximumConsecutive: 6,
  },
};

describe("JsonGameRepository", () => {
  it("restores the current round from disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-picker-"));
    const file = join(directory, "game.json");
    const first = new JsonGameRepository(file);
    await first.save(state);

    const restored = await new JsonGameRepository(file).load();

    expect(restored).toEqual({
      ...state,
      preferenceProfile: preferenceProfileFromSeed(state.preferenceSeed),
    });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(state);
  });

  it("migrates persisted rounds that predate round-level streak fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-picker-legacy-"));
    const file = join(directory, "game.json");
    const legacy = structuredClone(state) as unknown as {
      round: Record<string, unknown>;
    };
    delete legacy.round.retainedCandidateId;
    delete legacy.round.winStreak;
    await writeFile(file, JSON.stringify(legacy));

    const restored = await new JsonGameRepository(file).load();

    expect(restored?.round.retainedCandidateId).toBeNull();
    expect(restored?.round.winStreak).toBe(0);
    expect(restored?.round.leftCandidate.winCount).toBe(2);
  });

  it("migrates pending selections that predate the generation discriminator", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-picker-legacy-"));
    const file = join(directory, "game.json");
    const legacy = {
      ...structuredClone(state),
      round: {
        ...structuredClone(state.round),
        status: "generating",
        replacingSide: "right",
      },
      pendingSelection: {
        winnerSide: "left",
        selectedAt: "2026-07-17T04:31:14.240Z",
        generationJobId: "legacy-job",
      },
    };
    await writeFile(file, JSON.stringify(legacy));

    const restored = await new JsonGameRepository(file).load();

    expect(restored?.pendingSelection).toEqual({
      kind: "generation",
      winnerSide: "left",
      selectedAt: "2026-07-17T04:31:14.240Z",
      generationJobId: "legacy-job",
    });
  });

  it("restores a cleared repository as empty", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-picker-clear-"));
    const file = join(directory, "game.json");
    const repository = new JsonGameRepository(file);
    await repository.clear();

    await expect(repository.load()).resolves.toBeNull();
  });

  it("serializes transactions across repository instances for the same file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-picker-lock-"));
    const file = join(directory, "game.json");
    const first = new JsonGameRepository(file);
    const second = new JsonGameRepository(file);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      signalFirstEntered = resolve;
    });
    const order: string[] = [];

    const firstTransaction = first.withLock(async () => {
      order.push("first-entered");
      signalFirstEntered();
      await held;
      order.push("first-leaving");
    });
    await firstEntered;
    const secondTransaction = second.withLock(async () => {
      order.push("second-entered");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(order).toEqual(["first-entered"]);
    release();
    await Promise.all([firstTransaction, secondTransaction]);
    expect(order).toEqual(["first-entered", "first-leaving", "second-entered"]);
  });

  it("recovers an expired lock left by a dead process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diptych-picker-stale-"));
    const file = join(directory, "game.json");
    const lockDirectory = `${file}.lock`;
    await mkdir(lockDirectory);
    await writeFile(
      join(lockDirectory, "owner.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        token: "dead-owner",
        acquiredAt: "2000-01-01T00:00:00.000Z",
      }),
    );
    const repository = new JsonGameRepository(file, {
      lockTimeoutMs: 200,
      staleLockMs: 10,
      retryDelayMs: 1,
    });

    await expect(repository.withLock(async () => "recovered")).resolves.toBe(
      "recovered",
    );
  });
});

describe("MemoryGameRepository", () => {
  it("serializes transactions through one shared repository mutex", async () => {
    const repository = new MemoryGameRepository(state);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      signalFirstEntered = resolve;
    });
    const order: string[] = [];

    const first = repository.withLock(async () => {
      order.push("first");
      signalFirstEntered();
      await held;
    });
    const second = repository.withLock(async () => {
      order.push("second");
    });
    await firstEntered;

    expect(order).toEqual(["first"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });
});
