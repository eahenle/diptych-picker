import { describe, expect, it, vi } from "vitest";
import type { ChallengerState } from "@/domain/challenger-state";
import type {
  Candidate,
  GameState,
  PromptCardWriterRequest,
} from "@/domain/game";
import { createPromptCard, emptyPromptDeck } from "@/domain/prompt-deck";
import type {
  PromptCardBlenderMailbox,
  PromptCardBlenderJob,
  PromptCardWriterJob,
} from "./agent-mailbox";
import { MemoryChallengerRepository } from "./challenger-repository";
import { MissingGameError, PromptDeckError } from "./game-service-errors";
import { PromptDeckService } from "./prompt-deck-service";
import type { PromptCardWriterCoordinator } from "./prompt-card-writer-service";
import { MemoryGameRepository } from "./repository";

const NOW = "2026-07-25T22:00:00.000Z";

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
      retainedCandidateId: null,
      winStreak: 0,
    },
    history: [],
    preferenceSeed: "Architectural portraits with dramatic natural light.",
    promptDeck: emptyPromptDeck(),
    ...overrides,
  };
}

function challengers(
  current: GameState,
  favorites: string[] = [],
): ChallengerState {
  return {
    version: 1,
    sessionId: "session-1",
    ready: [],
    refillJobs: [],
    pendingComparison: null,
    pendingSelectionBaseline: null,
    ratings: [
      current.round.leftCandidate,
      current.round.rightCandidate,
      ...favorites.map(candidate),
    ].map((item) => ({
      candidate: item,
      rating: 1000,
      wins: 0,
      losses: 0,
      source: item.id.startsWith("favorite-")
        ? ("generated" as const)
        : ("curated" as const),
      poolMember: true,
      lastServedAt: null,
      ...(item.id.startsWith("favorite-") ? { favorite: true } : {}),
    })),
    generationTurnaroundEmaMs: 100_000,
    consecutiveFallbackDraws: 0,
    nextFallbackAt: null,
  };
}

function fixture(
  current: GameState | null = game(),
  state: ChallengerState | null = current ? challengers(current) : null,
) {
  const gameRepository = new MemoryGameRepository(current);
  const challengerRepository = new MemoryChallengerRepository(state);
  const ensureBlenderEnqueued = vi.fn<
    (job: PromptCardBlenderJob) => Promise<void>
  >(async () => {});
  const ensureWriterEnqueued = vi.fn<
    (job: PromptCardWriterJob) => Promise<void>
  >(async () => {});
  const prepare = vi.fn<PromptCardWriterCoordinator["prepare"]>(
    async (id, createdAt) =>
      ({
        id,
        kind: "prompt-card-writer",
        createdAt,
        sources: [],
      }) as PromptCardWriterRequest,
  );
  const writer: PromptCardWriterCoordinator = {
    prepare,
    enqueue: async () => {},
    readWork: async () => null,
    readResult: async () => null,
    archive: async () => {},
  };
  const service = new PromptDeckService({
    gameRepository,
    challengerRepository,
    jobPublisher: { ensureBlenderEnqueued, ensureWriterEnqueued },
    blender: {} as PromptCardBlenderMailbox,
    writer,
    createId: (() => {
      let next = 0;
      return () => `created-${++next}`;
    })(),
    now: () => NOW,
  });
  return {
    gameRepository,
    challengerRepository,
    ensureBlenderEnqueued,
    ensureWriterEnqueued,
    prepare,
    service,
  };
}

describe("PromptDeckService", () => {
  it("creates a normalized card and preserves immutable parent lineage", async () => {
    const parent = createPromptCard(
      {
        title: "Parent",
        prompt: "A tactile parent direction with warm editorial lighting.",
        negativePrompt: "",
        weight: 1,
        tags: ["editorial"],
      },
      "parent-1",
      NOW,
    );
    const current = game({
      promptDeck: { ...emptyPromptDeck(), cards: [parent] },
    });
    const context = fixture(current, challengers(current));

    const updated = await context.service.create({
      title: " Child ",
      prompt: " A coherent child direction with translucent materials. ",
      negativePrompt: " readable text ",
      weight: 2,
      tags: [" glass ", ""],
      parents: ["parent-1"],
    });

    expect(updated.promptDeck?.cards[1]).toMatchObject({
      id: "created-1",
      title: "Child",
      prompt: "A coherent child direction with translucent materials.",
      negativePrompt: "readable text",
      tags: ["glass"],
      parents: ["parent-1"],
    });
  });

  it("rejects a card whose parent is outside the current deck", async () => {
    const context = fixture();

    await expect(
      context.service.create({
        title: "Orphan",
        prompt: "A sufficiently detailed orphan prompt for validation.",
        negativePrompt: "",
        weight: 1,
        tags: [],
        parents: ["missing"],
      }),
    ).rejects.toBeInstanceOf(PromptDeckError);
  });

  it("persists and publishes an exact two-card blend request", async () => {
    const cards = ["one", "two"].map((id) =>
      createPromptCard(
        {
          title: id,
          prompt: `${id} has a distinct detailed editorial visual direction.`,
          negativePrompt: "",
          weight: 1,
          tags: [id],
        },
        id,
        NOW,
      ),
    );
    const current = game({
      promptDeck: { ...emptyPromptDeck(), cards },
    });
    const context = fixture(current, challengers(current));

    const updated = await context.service.requestBlend(["one", "two"], 0.6);

    expect(updated.promptDeck?.blendJob).toMatchObject({
      jobId: "created-1",
      cardIds: ["one", "two"],
      expectedJob: {
        id: "created-1",
        kind: "prompt-card-blender",
        ratio: 0.6,
      },
    });
    expect(context.ensureBlenderEnqueued).toHaveBeenCalledWith(
      updated.promptDeck?.blendJob?.expectedJob,
    );
  });

  it("prepares and publishes a writer job from generated favorites", async () => {
    const current = game();
    const favoriteIds = ["favorite-1", "favorite-2", "favorite-3"];
    const context = fixture(current, challengers(current, favoriteIds));

    const updated = await context.service.requestWriter(favoriteIds);

    expect(context.prepare.mock.calls[0]?.slice(0, 2)).toEqual([
      "created-1",
      NOW,
    ]);
    expect(
      context.prepare.mock.calls[0]?.[2].map(({ candidate: item }) => item.id),
    ).toEqual(favoriteIds);
    expect(updated.promptDeck?.writerJob).toMatchObject({
      jobId: "created-1",
      sourceCandidateIds: favoriteIds,
      expectedJob: { kind: "prompt-card-writer" },
    });
    expect(context.ensureWriterEnqueued).toHaveBeenCalledWith(
      updated.promptDeck?.writerJob?.expectedJob,
    );
  });

  it("accepts a suggestion with all parent and source lineage", async () => {
    const current = game({
      promptDeck: {
        ...emptyPromptDeck(),
        suggestions: [
          {
            id: "suggestion-1",
            title: "Synthesis",
            prompt:
              "A synthesized editorial direction with tactile translucent materials.",
            negativePrompt: "readable text",
            tags: ["editorial", "glass"],
            reasoningSummary: "Combines shared transferable qualities.",
            parentCardId: "parent-1",
            parentCardIds: ["parent-1", "parent-2"],
            sourceCandidateIds: ["favorite-1", "favorite-2", "favorite-3"],
            createdAt: NOW,
          },
        ],
      },
    });
    const context = fixture(current, challengers(current));

    const updated = await context.service.update({
      kind: "suggestion",
      suggestionId: "suggestion-1",
      action: "accept",
    });

    expect(updated.promptDeck?.cards[0]).toMatchObject({
      id: "created-1",
      parents: ["parent-1", "parent-2"],
      sourceCandidateIds: ["favorite-1", "favorite-2", "favorite-3"],
    });
    expect(updated.promptDeck?.suggestions).toEqual([]);
  });

  it("disables weighted draws when the final active card is deactivated", async () => {
    const onlyCard = createPromptCard(
      {
        title: "Only card",
        prompt: "The only active weighted editorial direction in this deck.",
        negativePrompt: "",
        weight: 1,
        tags: [],
      },
      "only",
      NOW,
    );
    const current = game({
      promptDeck: {
        ...emptyPromptDeck(),
        enabled: true,
        cards: [onlyCard],
      },
    });
    const context = fixture(current, challengers(current));

    const updated = await context.service.update({
      kind: "card",
      cardId: "only",
      active: false,
    });

    expect(updated.promptDeck).toMatchObject({
      enabled: false,
      cards: [{ id: "only", active: false }],
    });
  });

  it("preserves the shared missing-game error contract", async () => {
    const context = fixture(null, null);

    await expect(
      context.service.update({ kind: "deck", enabled: false }),
    ).rejects.toBeInstanceOf(MissingGameError);
  });
});
