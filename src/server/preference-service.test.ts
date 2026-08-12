import { describe, expect, it, vi } from "vitest";
import type { ChallengerState } from "@/domain/challenger-state";
import {
  composePreferenceSeed,
  preferenceProfileFromSeed,
  type Candidate,
  type GameState,
} from "@/domain/game";
import { MemoryChallengerRepository } from "./challenger-repository";
import {
  MissingGameError,
  SelectionConflictError,
} from "./game-service-errors";
import { PreferenceService } from "./preference-service";
import { MemoryGameRepository } from "./repository";

const NOW = "2026-07-26T05:00:00.000Z";
const SEED = "Architectural portraits with dramatic natural light.";

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
    preferenceSeed: SEED,
    preferenceProfile: preferenceProfileFromSeed(SEED),
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
  const ready = ["ready-1", "ready-2"].map((id) => ({
    candidate: candidate(id),
    source: "generated" as const,
    importItemId: null,
    pinnedWinnerId: "left",
    enqueuedAt: NOW,
  }));
  return {
    version: 1,
    sessionId: "session-1",
    ready,
    importQueue: [],
    refillJobs: [],
    pendingComparison: null,
    pendingSelectionBaseline: null,
    ratings: [
      current.round.leftCandidate,
      current.round.rightCandidate,
      candidate("rated-source"),
      ...ready.map(({ candidate: item }) => item),
    ].map((item) => ({
      candidate: item,
      rating: 1000,
      wins: 0,
      losses: 0,
      source: "generated" as const,
      importItemId: null,
      poolMember: true,
      lastServedAt: null,
    })),
    generationTurnaroundEmaMs: 100_000,
    consecutiveFallbackDraws: 0,
    nextFallbackAt: null,
  };
}

function fixture(
  current: GameState | null = game(),
  challengerState: ChallengerState | null = current
    ? challengers(current)
    : null,
) {
  const gameRepository = new MemoryGameRepository(current);
  const challengerRepository = new MemoryChallengerRepository(challengerState);
  const addRefillCapacity = vi.fn((state: ChallengerState) => ({
    state,
    jobs: [],
  }));
  const ensureJobsEnqueued = vi.fn(async () => {});
  const service = new PreferenceService({
    gameRepository,
    challengerRepository,
    addRefillCapacity,
    ensureJobsEnqueued,
    now: () => NOW,
  });
  return {
    service,
    gameRepository,
    challengerRepository,
    addRefillCapacity,
    ensureJobsEnqueued,
  };
}

describe("PreferenceService", () => {
  it("records a manual revision, clears its notice, and replaces stale ready capacity", async () => {
    const context = fixture();
    const nextSeed =
      "Copper-lit architectural portraits with translucent materials.";
    const nextProfile = {
      ...preferenceProfileFromSeed(nextSeed),
      visualStyle: "Tactile editorial photography",
    };

    const updated = await context.service.update(nextSeed, nextProfile);

    expect(updated).toMatchObject({
      preferenceSeed: nextSeed,
      preferenceProfile: nextProfile,
      preferenceRevisions: [
        {
          source: "initial",
          createdAt: NOW,
          profile: { themes: SEED },
        },
        {
          source: "manual",
          createdAt: NOW,
          profile: nextProfile,
        },
      ],
    });
    expect(updated.generationNotice).toBeUndefined();
    expect(context.addRefillCapacity).toHaveBeenCalledWith(
      expect.objectContaining({ ready: [] }),
      expect.objectContaining({ game: updated, winnerSide: "left" }),
    );
    expect(context.ensureJobsEnqueued).toHaveBeenCalledWith([]);
    await expect(context.challengerRepository.load()).resolves.toMatchObject({
      ready: [],
    });
  });

  it("preserves ready capacity for a profile-only edit that does not alter generation controls", async () => {
    const current = game();
    const state = challengers(current);
    const context = fixture(current, state);
    const profile = {
      ...current.preferenceProfile!,
      inspiration: "Brutalist museum interiors",
    };

    const updated = await context.service.update(
      current.preferenceSeed,
      profile,
    );

    expect(updated.preferenceProfile).toEqual(profile);
    expect(updated.preferenceRevisions?.at(-1)).toMatchObject({
      source: "manual",
      profile,
    });
    expect((await context.challengerRepository.load())?.ready).toEqual(
      state.ready,
    );
    expect(context.addRefillCapacity).not.toHaveBeenCalled();
  });

  it("starts and clears variation lineage from current rated candidates", async () => {
    const current = game();
    const context = fixture(current);
    const profile = preferenceProfileFromSeed(
      "Variations on a rated architectural portrait.",
    );

    const branched = await context.service.update(
      profile.themes,
      profile,
      undefined,
      "rated-source",
    );
    expect(branched.variationSource).toEqual({
      candidateId: "rated-source",
      concept: "rated-source concept",
    });
    expect(branched.preferenceRevisions?.at(-1)).toMatchObject({
      source: "variation",
      variationSource: {
        candidateId: "rated-source",
        concept: "rated-source concept",
      },
    });

    const cleared = await context.service.update(
      profile.themes,
      profile,
      profile,
      null,
    );
    expect(cleared.variationSource).toBeUndefined();
    expect(cleared.preferenceRevisions?.at(-1)).toMatchObject({
      source: "manual",
    });
  });

  it("rejects stale editors and unavailable variation sources without persistence", async () => {
    const current = game();
    const context = fixture(current);
    const staleProfile = {
      ...current.preferenceProfile!,
      adaptationMode: "adaptive" as const,
    };

    await expect(
      context.service.update(
        "Stale editor preference text.",
        preferenceProfileFromSeed("Stale editor preference text."),
        staleProfile,
      ),
    ).rejects.toThrow(
      "Preferences changed while this editor was open. Reopen Preferences and try again.",
    );
    await expect(
      context.service.update(
        current.preferenceSeed,
        current.preferenceProfile!,
        undefined,
        "missing-source",
      ),
    ).rejects.toThrow(
      "That variation source is no longer available in this game.",
    );
    await expect(context.gameRepository.load()).resolves.toEqual(current);
  });

  it("preserves missing-game and in-flight selection conflicts", async () => {
    await expect(
      fixture(null).service.update(
        "A new preference.",
        preferenceProfileFromSeed("A new preference."),
      ),
    ).rejects.toBeInstanceOf(MissingGameError);

    const generating = game({
      round: { ...game().round, status: "generating" },
    });
    await expect(
      fixture(generating).service.update(
        generating.preferenceSeed,
        generating.preferenceProfile!,
      ),
    ).rejects.toBeInstanceOf(SelectionConflictError);
  });

  it("persists profile edits while a buffered selection is in flight", async () => {
    const current = game({
      round: { ...game().round, status: "generating" },
      pendingSelection: {
        kind: "buffer",
        winnerSide: "left",
        selectedAt: NOW,
      },
    });
    const context = fixture(current);
    const profile = {
      ...current.preferenceProfile!,
      inspiration: "Copper light across a monumental interior",
    };
    const nextSeed = composePreferenceSeed(profile);

    const updated = await context.service.update(
      nextSeed,
      profile,
      current.preferenceProfile,
    );

    expect(updated.preferenceSeed).toBe(nextSeed);
    expect(updated.preferenceProfile).toEqual(profile);
    expect(updated.pendingSelection).toEqual(current.pendingSelection);
    expect(context.addRefillCapacity).toHaveBeenCalledWith(
      expect.objectContaining({ ready: [] }),
      expect.objectContaining({ game: updated, winnerSide: "left" }),
    );
    await expect(context.gameRepository.load()).resolves.toEqual(updated);
  });
});
