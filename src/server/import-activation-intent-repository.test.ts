import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importSessionFixture } from "@/domain/import-session-fixture";
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
  preparedDequeues: [],
  pendingSelectionBaseline: null,
  ratings: [],
  generationTurnaroundEmaMs: 0,
  consecutiveFallbackDraws: 0,
  nextFallbackAt: null,
};

const intent = (): ImportActivationIntent => ({
  id: "activation-intent-1",
  expectedOld: {
    importSessionId: "import-session-1",
    gameRevisionId: "game-revision-previous",
    challengerSessionId: "challenger-session-previous",
    bootstrapBatchId: "bootstrap-previous",
  },
  next: {
    game: {
      revisionId: "game-revision-next",
      state: game,
    },
    challengers,
    bootstrap: null,
    importSession: importSessionFixture(),
  },
  supersededJobIds: ["bootstrap-previous", "superseded-job-1"],
  archivedSupersededJobIds: [],
  phase: "prepared",
  outcome: "undecided",
  preparedAt: "2026-08-09T20:05:00.000Z",
  committedAt: null,
  cleanedAt: null,
});

describe("import activation intent schema", () => {
  it("requires the merged journal fields and coherent phase evidence", () => {
    const prepared = intent() as unknown as Record<string, unknown>;
    expect(parseImportActivationIntent(prepared)).toMatchObject({
      phase: "prepared",
      preparedAt: "2026-08-09T20:05:00.000Z",
    });

    const preparedWithCommit = structuredClone(prepared);
    preparedWithCommit.committedAt = "2026-08-09T20:06:00.000Z";
    expect(() => parseImportActivationIntent(preparedWithCommit)).toThrow(
      /prepared|commit/i,
    );

    const writingWithArchive = structuredClone(prepared);
    writingWithArchive.phase = "writing";
    writingWithArchive.outcome = "commit";
    writingWithArchive.archivedSupersededJobIds = ["superseded-job-1"];
    expect(() => parseImportActivationIntent(writingWithArchive)).toThrow(
      /writing|archive/i,
    );
  });
  it("round-trips the complete intended aggregate with null bootstrap", () => {
    expect(parseImportActivationIntent(intent())).toEqual(intent());
  });

  it("accepts durable activation IDs and rejects spaces or punctuation", () => {
    expect(
      parseImportActivationIntent({
        ...intent(),
        expectedOld: {
          ...intent().expectedOld,
          gameRevisionId: "Game_Revision-9",
        },
        next: {
          ...intent().next,
          game: { revisionId: "Game_Next-9", state: game },
        },
        supersededJobIds: ["Superseded_Job-9"],
      }),
    ).toMatchObject({
      expectedOld: { gameRevisionId: "Game_Revision-9" },
      next: { game: { revisionId: "Game_Next-9" } },
    });

    for (const build of [
      () => ({ ...intent(), id: "activation intent" }),
      () => ({
        ...intent(),
        expectedOld: { ...intent().expectedOld, gameRevisionId: "game!" },
      }),
      () => ({
        ...intent(),
        next: {
          ...intent().next,
          game: { revisionId: "game revision", state: game },
        },
      }),
      () => ({ ...intent(), supersededJobIds: ["superseded job"] }),
    ]) {
      expect(() => parseImportActivationIntent(build())).toThrow();
    }
  });

  it("rejects unknown top-level activation intent fields", () => {
    expect(() =>
      parseImportActivationIntent({ ...intent(), unexpectedWalField: true }),
    ).toThrow(/unrecognized|unexpected/i);
  });

  it("accepts every valid phase and evidence combination", () => {
    const writing = intent();
    writing.phase = "writing";
    writing.outcome = "commit";

    const committed = structuredClone(writing);
    committed.phase = "committed";
    committed.committedAt = "2026-08-09T20:06:00.000Z";
    committed.archivedSupersededJobIds = ["superseded-job-1"];

    const cleanedCommit = structuredClone(committed);
    cleanedCommit.phase = "cleaned";
    cleanedCommit.archivedSupersededJobIds = [
      "bootstrap-previous",
      "superseded-job-1",
    ];
    cleanedCommit.cleanedAt = "2026-08-09T20:07:00.000Z";

    const cleanedRollback = intent();
    cleanedRollback.phase = "cleaned";
    cleanedRollback.outcome = "rollback";
    cleanedRollback.cleanedAt = "2026-08-09T20:07:00.000Z";

    for (const value of [
      intent(),
      writing,
      committed,
      cleanedCommit,
      cleanedRollback,
    ]) {
      expect(parseImportActivationIntent(value)).toEqual(value);
    }
  });

  it("requires the intended import session to match the expected session", () => {
    const value = intent();
    value.expectedOld.importSessionId = "different-import-session";

    expect(() => parseImportActivationIntent(value)).toThrow(
      /expected.*import|import.*expected/i,
    );
  });

  it("rejects a cleaned intent whose outcome is still undecided", () => {
    const value = intent();
    value.phase = "cleaned";
    value.cleanedAt = "2026-08-09T20:07:00.000Z";

    expect(() => parseImportActivationIntent(value)).toThrow(
      /cleaned.*outcome|outcome.*cleaned/i,
    );
  });

  it("round-trips the intended game revision envelope", () => {
    const value = intent() as unknown as Record<string, unknown>;
    (value.next as Record<string, unknown>).game = {
      revisionId: "game-revision-next",
      state: game,
    };

    expect(parseImportActivationIntent(value)).toMatchObject({
      next: {
        game: {
          revisionId: "game-revision-next",
          state: game,
        },
      },
    });
  });

  it("rejects an intended game revision envelope without a revision ID", () => {
    const value = intent() as unknown as Record<string, unknown>;
    (value.next as Record<string, unknown>).game = {
      revisionId: "",
      state: game,
    };

    expect(() => parseImportActivationIntent(value)).toThrow(/revision/i);
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
    await expect(repository.clear(value.id)).rejects.toThrow(/cleaned/i);
    const cleaned = intent();
    cleaned.phase = "cleaned";
    cleaned.outcome = "rollback";
    cleaned.cleanedAt = "2026-08-09T20:07:00.000Z";
    await repository.save(cleaned);
    await repository.clear(cleaned.id);
    await expect(repository.load()).resolves.toBeNull();
  });

  it("preserves the prior intent when atomic save is interrupted", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "diptych-activation-intent-"),
    );
    const file = join(directory, "activation-intent.json");
    const repository = new JsonImportActivationIntentRepository(file);
    const previous = intent();
    await repository.save(previous);
    const interrupted = new JsonImportActivationIntentRepository(file, {
      renameFile: async () => {
        throw new Error("interrupted rename");
      },
    } as never);

    await expect(
      interrupted.save({
        ...previous,
        preparedAt: "2026-08-09T20:05:01.000Z",
      }),
    ).rejects.toThrow("interrupted rename");
    await expect(repository.load()).resolves.toEqual(previous);
  });

  it("preserves the matching intent when atomic clear is interrupted", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "diptych-activation-intent-"),
    );
    const file = join(directory, "activation-intent.json");
    const repository = new JsonImportActivationIntentRepository(file);
    const value = intent();
    value.phase = "cleaned";
    value.outcome = "rollback";
    value.cleanedAt = "2026-08-09T20:07:00.000Z";
    await repository.save(value);
    const interrupted = new JsonImportActivationIntentRepository(file, {
      renameFile: async () => {
        throw new Error("interrupted rename");
      },
    } as never);

    await expect(interrupted.clear(value.id)).rejects.toThrow(
      "interrupted rename",
    );
    await expect(repository.load()).resolves.toEqual(value);
    const cleaned = intent();
    cleaned.phase = "cleaned";
    cleaned.outcome = "rollback";
    cleaned.cleanedAt = "2026-08-09T20:07:00.000Z";
    await repository.save(cleaned);
    await repository.clear(cleaned.id);
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
