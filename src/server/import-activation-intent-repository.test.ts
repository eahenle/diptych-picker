import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { session } from "@/domain/import-session.test";
import type { ChallengerState } from "@/domain/challenger-state";
import type { GameState } from "@/domain/game";
import {
  JsonImportActivationIntentRepository,
  parseImportActivationIntent,
  type ImportActivationIntent,
} from "./import-activation-intent-repository";

const candidate = (id: string) => ({
  id,
  imageUrl: `/api/assets/${id}.png`,
  prompt: `${id} prompt`,
  concept: `${id} concept`,
  style: ["cinematic"],
  createdAt: "2026-08-09T20:00:00.000Z",
  winCount: 0,
});

const game: GameState = {
  round: {
    leftCandidate: candidate("left"),
    rightCandidate: candidate("right"),
    status: "idle",
    replacingSide: null,
    roundNumber: 1,
    retainedCandidateId: null,
    winStreak: 0,
  },
  history: [],
  preferenceSeed: "new import game",
  preferenceProfile: {
    themes: "architectural images with cinematic texture",
    inspiration: "architectural light",
    mediaTypes: "photography",
    visualStyle: "cinematic",
    colorPalette: "copper and blue",
    contentLevel: "family-friendly",
    avoid: "readable text",
    adaptationMode: "static",
    adaptationStrength: "guided",
    adaptationLastDecision: 0,
    adaptationSourceWinnerIds: [],
    adaptationSourceRejectedIds: [],
  },
};

const challengers: ChallengerState = {
  version: 1,
  sessionId: "challenger-session-1",
  ready: [],
  importQueue: [],
  refillJobs: [],
  leaderboardProfileJob: null,
  leaderboardVisualProfile: null,
  leaderboardProfileAttemptedFingerprint: null,
  pendingComparison: null,
  pendingSelectionBaseline: null,
  ratings: [],
  generationTurnaroundEmaMs: 0,
  consecutiveFallbackDraws: 0,
  nextFallbackAt: null,
};

const intent = (): ImportActivationIntent => ({
  version: 1,
  id: "activation-intent-1",
  createdAt: "2026-08-09T20:05:00.000Z",
  expectedOld: {
    importSessionId: "import-session-1",
    gameRevisionId: "game-revision-previous",
    challengerSessionId: "challenger-session-previous",
    bootstrapBatchId: "bootstrap-previous",
  },
  next: {
    game: { revisionId: "game-revision-1", state: game },
    challenger: challengers,
    bootstrap: null,
    importSession: session(),
  },
  supersededJobIds: ["bootstrap-previous", "superseded-job-1"],
  archivedSupersededJobIds: [],
  phase: "prepared",
  outcome: "undecided",
  committedAt: null,
});

describe("import activation intent schema", () => {
  it("round-trips the complete intended aggregate with null bootstrap", () => {
    expect(parseImportActivationIntent(intent())).toEqual(intent());
  });

  it("rejects duplicate and unknown archived job IDs", () => {
    const duplicate = intent();
    duplicate.archivedSupersededJobIds = [
      "superseded-job-1",
      "superseded-job-1",
    ];
    expect(() => parseImportActivationIntent(duplicate)).toThrow(
      /archived.*unique|unique.*archived/i,
    );

    const unknown = intent();
    unknown.archivedSupersededJobIds = ["not-superseded"];
    expect(() => parseImportActivationIntent(unknown)).toThrow(
      /archived.*superseded|superseded/i,
    );
  });

  it("requires cleaned commit intents to archive every superseded job", () => {
    const value = intent();
    value.phase = "cleaned";
    value.outcome = "commit";
    value.committedAt = "2026-08-09T20:06:00.000Z";
    value.archivedSupersededJobIds = ["superseded-job-1"];

    expect(() => parseImportActivationIntent(value)).toThrow(
      /archived|cleaned/i,
    );
  });

  it("rejects rollback evidence that claims a commit or archival", () => {
    const committedRollback = intent();
    committedRollback.phase = "cleaned";
    committedRollback.outcome = "rollback";
    committedRollback.committedAt = "2026-08-09T20:06:00.000Z";
    expect(() => parseImportActivationIntent(committedRollback)).toThrow(
      /rollback|commit/i,
    );

    const archivedRollback = intent();
    archivedRollback.phase = "cleaned";
    archivedRollback.outcome = "rollback";
    archivedRollback.archivedSupersededJobIds = ["superseded-job-1"];
    expect(() => parseImportActivationIntent(archivedRollback)).toThrow(
      /rollback|archived/i,
    );
  });
});

describe("JsonImportActivationIntentRepository", () => {
  it("loads and saves a durable prepared intent independently from its targets", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "diptych-activation-intent-"),
    );
    const repository = new JsonImportActivationIntentRepository(
      join(directory, "activation-intent.json"),
    );
    const value = intent();

    await repository.save(value);

    await expect(repository.load()).resolves.toEqual(value);
  });

  it("clears only the expected terminal intent", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "diptych-activation-intent-"),
    );
    const repository = new JsonImportActivationIntentRepository(
      join(directory, "activation-intent.json"),
    );
    const value = intent();
    await repository.save(value);

    await expect(repository.clear("other-intent")).rejects.toThrow(
      /expected|intent/i,
    );
    await expect(repository.load()).resolves.toEqual(value);
    await repository.clear(value.id);
    await expect(repository.load()).resolves.toBeNull();
  });

  it("serializes journal mutations across repository instances", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "diptych-activation-intent-"),
    );
    const file = join(directory, "activation-intent.json");
    const first = new JsonImportActivationIntentRepository(file);
    const second = new JsonImportActivationIntentRepository(file);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      signalFirstEntered = resolve;
    });
    const order: string[] = [];

    const firstOperation = first.withLock(async () => {
      order.push("first-entered");
      signalFirstEntered();
      await held;
      order.push("first-left");
    });
    await firstEntered;
    const secondOperation = second.withLock(async () => {
      order.push("second-entered");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(order).toEqual(["first-entered"]);
    release();
    await Promise.all([firstOperation, secondOperation]);
    expect(order).toEqual(["first-entered", "first-left", "second-entered"]);
  });
});
