import { describe, expect, it, vi } from "vitest";
import type { ChallengerState } from "@/domain/challenger-state";
import {
  preferenceProfileFromSeed,
  type Candidate,
  type GameState,
} from "@/domain/game";
import { MemoryChallengerRepository } from "./challenger-repository";
import {
  GameRulesError,
  MissingGameError,
  PreferencePresetLimitError,
} from "./game-service-errors";
import { GameSettingsService } from "./game-settings-service";
import { MemoryGameRepository } from "./repository";

const NOW = "2026-07-26T04:00:00.000Z";

function candidate(id: string): Candidate {
  return {
    id,
    imageUrl: `/api/assets/${id}.png`,
    prompt: `${id} prompt`,
    concept: `${id} concept`,
    style: ["editorial"],
    createdAt: NOW,
    winCount: 0,
  };
}

function game(overrides: Partial<GameState> = {}): GameState {
  return {
    round: {
      leftCandidate: candidate("left"),
      rightCandidate: candidate("right"),
      status: "idle",
      replacingSide: null,
      roundNumber: 4,
      retainedCandidateId: "left",
      winStreak: 2,
    },
    history: [],
    preferenceSeed: "Architectural portraits with dramatic natural light.",
    generationNotice: {
      kind: "moderation-block",
      jobId: "blocked-job",
      occurredAt: NOW,
      occurrenceCount: 1,
    },
    ...overrides,
  };
}

function challengers(current: GameState): ChallengerState {
  return {
    version: 1,
    sessionId: "session-1",
    ready: [],
    importQueue: [],
    refillJobs: [],
    pendingComparison: null,
    pendingSelectionBaseline: null,
    ratings: [current.round.leftCandidate, current.round.rightCandidate].map(
      (item) => ({
        candidate: item,
        rating: 1000,
        wins: 0,
        losses: 0,
        source: "curated" as const,
        importItemId: null,
        poolMember: true,
        lastServedAt: null,
      }),
    ),
    generationTurnaroundEmaMs: 100_000,
    consecutiveFallbackDraws: 0,
    nextFallbackAt: null,
  };
}

function fixture(current: GameState | null = game()) {
  const gameRepository = new MemoryGameRepository(current);
  const challengerRepository = new MemoryChallengerRepository(
    current ? challengers(current) : null,
  );
  const addRefillCapacity = vi.fn((state: ChallengerState) => ({
    state,
    jobs: [],
  }));
  const ensureJobsEnqueued = vi.fn(async () => {});
  let nextId = 0;
  const service = new GameSettingsService({
    gameRepository,
    challengerRepository,
    addRefillCapacity,
    ensureJobsEnqueued,
    now: () => NOW,
    createId: () => `preset-${++nextId}`,
  });
  return {
    service,
    gameRepository,
    challengerRepository,
    addRefillCapacity,
    ensureJobsEnqueued,
  };
}

describe("GameSettingsService", () => {
  it("dismisses a generation notice without touching challenger state", async () => {
    const context = fixture();
    const before = await context.challengerRepository.load();

    const updated = await context.service.dismissGenerationNotice();

    expect(updated.generationNotice).toBeUndefined();
    await expect(context.gameRepository.load()).resolves.toEqual(updated);
    await expect(context.challengerRepository.load()).resolves.toEqual(before);
  });

  it("saves, replaces, and deletes reusable preference presets", async () => {
    const context = fixture();
    const profile = {
      ...preferenceProfileFromSeed("Copper-lit industrial portrait studies."),
      adaptationLastDecision: 9,
      adaptationSourceWinnerIds: ["winner"],
      adaptationSourceRejectedIds: ["rejected"],
    };

    const saved = await context.service.savePreferencePreset(
      " Copper study ",
      profile,
    );
    expect(saved.preferencePresets).toEqual([
      expect.objectContaining({
        id: "preset-1",
        name: "Copper study",
        profile: {
          ...profile,
          adaptationLastDecision: 0,
          adaptationSourceWinnerIds: [],
          adaptationSourceRejectedIds: [],
        },
      }),
    ]);

    const replaced = await context.service.savePreferencePreset(
      "copper STUDY",
      { ...profile, inspiration: "ultraviolet rim lighting" },
    );
    expect(replaced.preferencePresets).toEqual([
      expect.objectContaining({
        id: "preset-1",
        name: "copper STUDY",
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ]);

    const deleted = await context.service.deletePreferencePreset("preset-1");
    expect(deleted.preferencePresets).toEqual([]);
    expect(context.addRefillCapacity).not.toHaveBeenCalled();
  });

  it("enforces the preset limit before creating another ID", async () => {
    const full = game({
      preferencePresets: Array.from({ length: 20 }, (_, index) => ({
        id: `existing-${index}`,
        name: `Preset ${index}`,
        createdAt: NOW,
        updatedAt: NOW,
        profile: preferenceProfileFromSeed(`Portrait preset ${index}.`),
      })),
    });
    const context = fixture(full);

    await expect(
      context.service.savePreferencePreset(
        "One too many",
        preferenceProfileFromSeed("Another portrait direction."),
      ),
    ).rejects.toThrow(PreferencePresetLimitError);
  });

  it("persists valid rules and requests refill capacity under both locks", async () => {
    const context = fixture();
    const rules = {
      bufferTarget: 6,
      poolMaximum: 12,
      championRetirementStreak: 4,
      fallbackMaximumConsecutive: 3,
    };

    const updated = await context.service.updateGameRules(rules);

    expect(updated.gameRules).toEqual(rules);
    expect(context.addRefillCapacity).toHaveBeenCalledOnce();
    expect(context.ensureJobsEnqueued).toHaveBeenCalledWith([]);
    await expect(context.gameRepository.load()).resolves.toMatchObject({
      gameRules: rules,
    });
  });

  it("rejects invalid rules and missing game state without persistence", async () => {
    const context = fixture();

    await expect(
      context.service.updateGameRules({
        bufferTarget: 0,
        poolMaximum: 12,
        championRetirementStreak: 4,
        fallbackMaximumConsecutive: 3,
      }),
    ).rejects.toThrow(GameRulesError);

    const empty = fixture(null);
    await expect(empty.service.dismissGenerationNotice()).rejects.toThrow(
      MissingGameError,
    );
  });
});
