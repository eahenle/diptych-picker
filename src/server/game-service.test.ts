import { describe, expect, it, vi } from "vitest";
import type {
  CandidateRating,
  ChallengerState,
} from "@/domain/challenger-state";
import {
  isReusablePoolLeaderboardEntry,
  summarizePoolLeaderboard,
} from "@/domain/challenger-state";
import {
  preferenceProfileFromSeed,
  type Candidate,
  type GameState,
} from "@/domain/game";
import type {
  GenerationJob,
  GenerationMailbox,
  GenerationResult,
  LeaderboardProfileJob,
  LeaderboardProfileResult,
  PromptCardBlenderJob,
  PromptCardBlenderMailbox,
  PromptCardBlenderResult,
  PromptCardEditorJob,
  PromptCardEditorMailbox,
  PromptCardEditorResult,
  PromptCardWriterJob,
  PromptCardWriterResult,
} from "./agent-mailbox";
import {
  MemoryChallengerRepository,
  type ChallengerRepository,
} from "./challenger-repository";
import { challengerConfig } from "./challenger-config";
import { GameService, SelectionConflictError } from "./game-service";
import type { LeaderboardProfileCoordinator } from "./leaderboard-profile-service";
import type { PromptCardWriterCoordinator } from "./prompt-card-writer-service";
import type { AssetStore } from "./providers";
import { MemoryGameRepository, type GameRepository } from "./repository";

const NOW = "2026-07-16T01:00:00.000Z";

const candidate = (id: string): Candidate => ({
  id,
  imageUrl: `/api/assets/${id}.png`,
  prompt: `${id} prompt`,
  concept: `${id} concept`,
  style: ["cinematic", id],
  reasoningSummary: `${id} reasoning`,
  createdAt: "2026-07-16T00:00:00.000Z",
  winCount: 0,
});

const rating = (
  item: Candidate,
  overrides: Partial<CandidateRating> = {},
): CandidateRating => {
  const { importItemId = null, ...rest } = overrides;
  return {
    candidate: item,
    rating: 1000,
    wins: 0,
    losses: 0,
    source: "curated",
    importItemId,
    poolMember: true,
    lastServedAt: null,
    ...rest,
  };
};

const gameState = (overrides: Partial<GameState> = {}): GameState => ({
  round: {
    leftCandidate: candidate("left"),
    rightCandidate: candidate("right"),
    status: "idle",
    replacingSide: null,
    roundNumber: 3,
    retainedCandidateId: null,
    winStreak: 0,
  },
  history: [
    {
      winnerId: "recent-winner",
      loserId: "recent-loser",
      winnerPrompt: "recent winner prompt",
      loserPrompt: "recent loser prompt",
      winnerConcept: "recent winner concept",
      loserConcept: "recent loser concept",
      selectedAt: "2026-07-15T00:00:00.000Z",
    },
  ],
  preferenceSeed: "industrial, gothic, natural, and surprising",
  ...overrides,
});

function challengerState(
  game: GameState,
  overrides: Partial<ChallengerState> = {},
): ChallengerState {
  const { importQueue = [], ...rest } = overrides;
  const ready = Array.from({ length: 5 }, (_, index) => ({
    candidate: candidate(`buffer-${index + 1}`),
    source: "seed" as const,
    importItemId: null,
    pinnedWinnerId: null,
    enqueuedAt: "2026-07-16T00:00:00.000Z",
  }));
  return {
    version: 1,
    sessionId: "session-1",
    ready,
    refillJobs: [],
    pendingComparison: null,
    ratings: [
      rating(game.round.leftCandidate),
      rating(game.round.rightCandidate),
      ...ready.map(({ candidate: item }) => rating(item)),
    ],
    generationTurnaroundEmaMs: 100_000,
    consecutiveFallbackDraws: 0,
    nextFallbackAt: null,
    ...rest,
    importQueue,
  };
}

function mailbox() {
  const work = new Map<string, GenerationJob>();
  const results = new Map<string, GenerationResult>();
  const enqueue = vi.fn<(job: GenerationJob) => Promise<void>>(async (job) => {
    work.set(job.id, job);
  });
  const readWork = vi.fn<(jobId: string) => Promise<GenerationJob | null>>(
    async (jobId) => work.get(jobId) ?? null,
  );
  const readResult = vi.fn<(jobId: string) => Promise<GenerationResult | null>>(
    async (jobId) => results.get(jobId) ?? null,
  );
  const archive = vi.fn<(jobId: string) => Promise<void>>(async (jobId) => {
    work.delete(jobId);
    results.delete(jobId);
  });
  const generationMailbox: GenerationMailbox = {
    enqueue,
    readPending: readWork,
    readWork,
    readResult,
    archive,
  };
  return {
    generationMailbox,
    enqueue,
    readWork,
    readResult,
    archive,
    setWork(job: GenerationJob) {
      work.set(job.id, job);
    },
    deleteWork(jobId: string) {
      work.delete(jobId);
    },
    setResult(result: GenerationResult) {
      results.set(result.jobId, result);
    },
  };
}

function leaderboardProfiles() {
  const work = new Map<string, LeaderboardProfileJob>();
  const results = new Map<string, LeaderboardProfileResult>();
  const fingerprint = "b".repeat(64);
  const desired = vi.fn<LeaderboardProfileCoordinator["desired"]>((state) => {
    const entries = summarizePoolLeaderboard(state)
      .filter(isReusablePoolLeaderboardEntry)
      .slice(0, 4);
    return entries.length >= 2 ? { fingerprint, entries } : null;
  });
  const prepare = vi.fn<LeaderboardProfileCoordinator["prepare"]>(
    async (id, createdAt, request) => ({
      id,
      kind: "leaderboard-profile",
      createdAt,
      fingerprint: request.fingerprint,
      sources: request.entries.map((entry) => ({
        candidateId: entry.candidate.id,
        rank: entry.rank,
        rating: entry.rating,
        wins: entry.wins,
        losses: entry.losses,
        favorite: entry.favorite,
        source: entry.source,
        concept: entry.candidate.concept,
        style: entry.candidate.style,
        sourceImage: {
          filename: `${String(entry.rank).repeat(64)}.png`,
          path: `profile-sources/${String(entry.rank).repeat(64)}.png`,
          contentType: "image/png",
          width: 100,
          height: 100,
          byteLength: 1024,
        },
      })),
    }),
  );
  const enqueue = vi.fn<LeaderboardProfileCoordinator["enqueue"]>(
    async (job) => {
      work.set(job.id, job);
    },
  );
  const readWork = vi.fn<LeaderboardProfileCoordinator["readWork"]>(
    async (jobId) => work.get(jobId) ?? null,
  );
  const readResult = vi.fn<LeaderboardProfileCoordinator["readResult"]>(
    async (jobId) => results.get(jobId) ?? null,
  );
  const archive = vi.fn<LeaderboardProfileCoordinator["archive"]>(
    async (jobId) => {
      work.delete(jobId);
      results.delete(jobId);
    },
  );
  const coordinator: LeaderboardProfileCoordinator = {
    desired,
    prepare,
    enqueue,
    readWork,
    readResult,
    archive,
  };
  return {
    coordinator,
    fingerprint,
    desired,
    prepare,
    enqueue,
    archive,
    setResult(result: LeaderboardProfileResult) {
      results.set(result.jobId, result);
    },
  };
}

function promptCardEditor() {
  const work = new Map<string, PromptCardEditorJob>();
  const results = new Map<string, PromptCardEditorResult>();
  const enqueuePromptCardEditor = vi.fn<
    PromptCardEditorMailbox["enqueuePromptCardEditor"]
  >(async (job) => {
    work.set(job.id, job);
  });
  const readPromptCardEditorWork = vi.fn<
    PromptCardEditorMailbox["readPromptCardEditorWork"]
  >(async (jobId) => work.get(jobId) ?? null);
  const readPromptCardEditorResult = vi.fn<
    PromptCardEditorMailbox["readPromptCardEditorResult"]
  >(async (jobId) => results.get(jobId) ?? null);
  const archivePromptCardEditor = vi.fn<
    PromptCardEditorMailbox["archivePromptCardEditor"]
  >(async (jobId) => {
    work.delete(jobId);
    results.delete(jobId);
  });
  const mailbox: PromptCardEditorMailbox = {
    enqueuePromptCardEditor,
    readPromptCardEditorWork,
    readPromptCardEditorResult,
    archivePromptCardEditor,
  };
  return {
    mailbox,
    enqueuePromptCardEditor,
    setResult(result: PromptCardEditorResult) {
      results.set(result.jobId, result);
    },
  };
}

function promptCardBlender() {
  const work = new Map<string, PromptCardBlenderJob>();
  const results = new Map<string, PromptCardBlenderResult>();
  const enqueuePromptCardBlender = vi.fn<
    PromptCardBlenderMailbox["enqueuePromptCardBlender"]
  >(async (job) => {
    work.set(job.id, job);
  });
  const mailbox: PromptCardBlenderMailbox = {
    enqueuePromptCardBlender,
    readPromptCardBlenderWork: async (jobId) => work.get(jobId) ?? null,
    readPromptCardBlenderResult: async (jobId) => results.get(jobId) ?? null,
    archivePromptCardBlender: async (jobId) => {
      work.delete(jobId);
      results.delete(jobId);
    },
  };
  return {
    mailbox,
    enqueuePromptCardBlender,
    setResult(result: PromptCardBlenderResult) {
      results.set(result.jobId, result);
    },
  };
}

function promptCardWriter() {
  const work = new Map<string, PromptCardWriterJob>();
  const results = new Map<string, PromptCardWriterResult>();
  const prepare = vi.fn<PromptCardWriterCoordinator["prepare"]>(
    async (id, createdAt, candidates) => ({
      id,
      kind: "prompt-card-writer",
      createdAt,
      sources: candidates.map(({ candidate: item }, index) => ({
        candidateId: item.id,
        concept: item.concept,
        style: item.style,
        sourceImage: {
          filename: `${String(index + 1).repeat(64)}.png`,
          path: `profile-sources/${String(index + 1).repeat(64)}.png`,
          contentType: "image/png",
          width: 100,
          height: 100,
          byteLength: 1024,
        },
      })),
    }),
  );
  const enqueue = vi.fn<PromptCardWriterCoordinator["enqueue"]>(async (job) => {
    work.set(job.id, job);
  });
  const coordinator: PromptCardWriterCoordinator = {
    prepare,
    prepareCustom: vi.fn(async () => {
      throw new Error("Custom writer preparation is outside this fixture");
    }),
    enqueue,
    readWork: async (jobId) => work.get(jobId) ?? null,
    readResult: async (jobId) => results.get(jobId) ?? null,
    archive: async (jobId) => {
      work.delete(jobId);
      results.delete(jobId);
    },
  };
  return {
    coordinator,
    prepare,
    enqueue,
    setResult(result: PromptCardWriterResult) {
      results.set(result.jobId, result);
    },
  };
}

function completedResult(
  jobId: string,
  completedAt = "2026-07-16T01:01:40.000Z",
): GenerationResult {
  return {
    jobId,
    status: "completed",
    completedAt,
    proposal: {
      concept: `${jobId} generated concept`,
      visualPrompt: `${jobId} standalone square image`,
      styleTags: ["paper craft", "warm daylight"],
      reasoningSummary: `${jobId} generated reasoning`,
    },
    asset: {
      candidateId: `challenger-${jobId}`,
      filename: `challenger-${jobId}.png`,
      imageUrl: `/api/assets/challenger-${jobId}.png`,
      contentType: "image/png",
      width: 1024,
      height: 1024,
      byteLength: 2048,
    },
  };
}

function verifier() {
  const verify = vi.fn<AssetStore["verify"]>(async () => {});
  return { assetVerifier: { verify }, verify };
}

function ids(...values: string[]) {
  let index = 0;
  return () => values[index++] ?? `job-${index}`;
}

function serviceFor(options: {
  game?: GameState;
  challengers?: ChallengerState;
  gameRepository?: GameRepository;
  challengerRepository?: ChallengerRepository;
  queue?: ReturnType<typeof mailbox>;
  assets?: ReturnType<typeof verifier>;
  now?: () => string;
  createId?: () => string;
  random?: () => number;
  bufferTarget?: number;
  leaderboardProfiles?: ReturnType<typeof leaderboardProfiles>;
  promptCardEditor?: ReturnType<typeof promptCardEditor>;
  promptCardBlender?: ReturnType<typeof promptCardBlender>;
  promptCardWriter?: ReturnType<typeof promptCardWriter>;
}) {
  const game = options.game ?? gameState();
  const gameRepository =
    options.gameRepository ?? new MemoryGameRepository(game);
  const challengerRepository =
    options.challengerRepository ??
    new MemoryChallengerRepository(
      options.challengers ?? challengerState(game),
    );
  const queue = options.queue ?? mailbox();
  const assets = options.assets ?? verifier();
  const config = {
    ...challengerConfig,
    bufferTarget: options.bufferTarget ?? challengerConfig.bufferTarget,
  };
  const service = new GameService(
    gameRepository,
    challengerRepository,
    queue.generationMailbox,
    assets.assetVerifier,
    config,
    options.now ?? (() => NOW),
    options.createId ??
      ids("refill-1", "refill-2", "refill-3", "refill-4", "refill-5"),
    options.random ?? (() => 0),
    options.leaderboardProfiles?.coordinator,
    options.promptCardEditor?.mailbox,
    options.promptCardBlender?.mailbox,
    options.promptCardWriter?.coordinator,
  );
  return {
    service,
    gameRepository,
    challengerRepository,
    queue,
    assets,
  };
}

describe("GameService challenger buffer", () => {
  it("persists live rule changes, trims the pool, and expands refill capacity", async () => {
    const game = gameState();
    game.round.retainedCandidateId = game.round.leftCandidate.id;
    game.round.winStreak = 1;
    const challengers = challengerState(game);
    const context = serviceFor({
      game,
      challengers,
      createId: ids("rules-refill"),
    });

    const updated = await context.service.updateGameRules({
      bufferTarget: 6,
      poolMaximum: 2,
      championRetirementStreak: 3,
      fallbackMaximumConsecutive: 4,
    });

    expect(updated.gameRules).toEqual({
      bufferTarget: 6,
      poolMaximum: 2,
      championRetirementStreak: 3,
      fallbackMaximumConsecutive: 4,
    });
    await expect(context.gameRepository.load()).resolves.toMatchObject({
      gameRules: updated.gameRules,
    });
    const persistedChallengers = await context.challengerRepository.load();
    expect(
      persistedChallengers?.ratings.filter((item) => item.poolMember),
    ).toHaveLength(2);
    expect(persistedChallengers?.refillJobs).toHaveLength(1);
    expect(context.queue.enqueue).toHaveBeenCalledOnce();
  });

  it("retires a champion at the configured streak limit", async () => {
    const game = gameState({
      gameRules: {
        bufferTarget: 5,
        poolMaximum: 50,
        championRetirementStreak: 2,
        fallbackMaximumConsecutive: 10,
      },
    });
    game.round.retainedCandidateId = game.round.leftCandidate.id;
    game.round.winStreak = 1;
    const context = serviceFor({ game });

    const selected = await context.service.select("left", 3);

    expect(selected.round).toMatchObject({
      leftCandidate: { id: "buffer-1" },
      rightCandidate: { id: "buffer-2" },
      retainedCandidateId: null,
      winStreak: 0,
    });
  });

  it("blends two immutable cards into one approval-gated child", async () => {
    const cards = [
      {
        id: "card-1",
        title: "Copper nocturne",
        prompt: "A severe copper-lit industrial editorial portrait.",
        negativePrompt: "readable text",
        weight: 1,
        tags: ["portrait", "copper"],
        parents: [] as string[],
        active: true,
        createdAt: NOW,
        stats: { wins: 0, rejects: 0 },
      },
      {
        id: "card-2",
        title: "Glass botany",
        prompt: "Translucent botanical structures in soft green daylight.",
        negativePrompt: "hard shadows",
        weight: 1,
        tags: ["botanical", "glass"],
        parents: [] as string[],
        active: true,
        createdAt: NOW,
        stats: { wins: 0, rejects: 0 },
      },
    ];
    const blender = promptCardBlender();
    const context = serviceFor({
      game: gameState({
        promptDeck: { enabled: true, cards, verdicts: [], suggestions: [] },
      }),
      promptCardBlender: blender,
      createId: ids("blend-1", "suggestion-1", "child-1"),
    });

    const requested = await context.service.requestPromptCardBlend(
      ["card-1", "card-2"],
      0.5,
    );
    expect(blender.enqueuePromptCardBlender).toHaveBeenCalledOnce();
    expect(requested.promptDeck?.blendJob).toMatchObject({
      jobId: "blend-1",
      cardIds: ["card-1", "card-2"],
      expectedJob: { kind: "prompt-card-blender", ratio: 0.5 },
    });
    expect(requested.promptDeck?.cards).toEqual(cards);

    blender.setResult({
      jobId: "blend-1",
      kind: "prompt-card-blender",
      status: "completed",
      completedAt: NOW,
      cardIds: ["card-1", "card-2"],
      proposal: {
        title: "Copper glasshouse",
        prompt:
          "A copper-lit editorial portrait inside a translucent botanical glasshouse.",
        negativePrompt: "readable text, hard shadows",
        tags: ["portrait", "copper", "botanical", "glass"],
        reasoningSummary: "Balances the two source directions.",
      },
    });
    const suggested = await context.service.reconcile();
    expect(suggested?.promptDeck?.blendJob).toBeNull();
    expect(suggested?.promptDeck?.suggestions?.[0]).toMatchObject({
      id: "suggestion-1",
      parentCardId: "card-1",
      parentCardIds: ["card-1", "card-2"],
    });

    const accepted = await context.service.updatePromptDeck({
      kind: "suggestion",
      suggestionId: "suggestion-1",
      action: "accept",
    });
    expect(accepted.promptDeck?.cards).toHaveLength(3);
    expect(accepted.promptDeck?.cards[2]).toMatchObject({
      id: "child-1",
      title: "Copper glasshouse",
      parents: ["card-1", "card-2"],
    });
  });

  it("writes an approval-gated card from three generated favorites", async () => {
    const game = gameState({
      promptDeck: {
        enabled: false,
        cards: [],
        verdicts: [],
        suggestions: [],
      },
    });
    const favorites = ["favorite-1", "favorite-2", "favorite-3"].map((id) =>
      rating(candidate(id), {
        source: "generated",
        favorite: true,
        poolMember: false,
      }),
    );
    const writer = promptCardWriter();
    const context = serviceFor({
      game,
      challengers: challengerState(game, {
        ratings: [
          rating(game.round.leftCandidate),
          rating(game.round.rightCandidate),
          ...favorites,
        ],
      }),
      promptCardWriter: writer,
      createId: ids("writer-1", "suggestion-1", "child-1"),
    });

    const requested = await context.service.requestPromptCardWriter(
      favorites.map(({ candidate: item }) => item.id),
    );
    expect(writer.prepare).toHaveBeenCalledOnce();
    expect(writer.enqueue).toHaveBeenCalledOnce();
    expect(requested.promptDeck?.writerJob).toMatchObject({
      jobId: "writer-1",
      sourceCandidateIds: ["favorite-1", "favorite-2", "favorite-3"],
      sourceImageDigests: ["1".repeat(64), "2".repeat(64), "3".repeat(64)],
      expectedJob: { kind: "prompt-card-writer" },
    });

    writer.setResult({
      jobId: "writer-1",
      kind: "prompt-card-writer",
      status: "completed",
      completedAt: NOW,
      sourceCandidateIds: ["favorite-1", "favorite-2", "favorite-3"],
      sourceImageDigests: ["1".repeat(64), "2".repeat(64), "3".repeat(64)],
      proposal: {
        title: "Favorite synthesis",
        prompt:
          "A tactile editorial scene that synthesizes the selected lighting, scale, and material qualities.",
        negativePrompt: "exact copies, readable text, logos",
        tags: ["editorial", "tactile"],
        reasoningSummary:
          "Extracts shared qualities without copying any selected source.",
      },
    });
    const suggested = await context.service.reconcile();
    expect(suggested?.promptDeck?.writerJob).toBeNull();
    expect(suggested?.promptDeck?.suggestions?.[0]).toMatchObject({
      id: "suggestion-1",
      sourceCandidateIds: ["favorite-1", "favorite-2", "favorite-3"],
    });

    const accepted = await context.service.updatePromptDeck({
      kind: "suggestion",
      suggestionId: "suggestion-1",
      action: "accept",
    });
    expect(accepted.promptDeck?.cards[0]).toMatchObject({
      id: "child-1",
      title: "Favorite synthesis",
      parents: [],
      sourceCandidateIds: ["favorite-1", "favorite-2", "favorite-3"],
    });
  });

  it("queues two approval-gated editor suggestions after four recent card rejections", async () => {
    const card = {
      id: "card-1",
      title: "Copper nocturne",
      prompt: "A severe copper-lit industrial editorial portrait.",
      negativePrompt: "readable text",
      weight: 1,
      tags: ["portrait", "copper"],
      parents: [],
      active: true,
      createdAt: NOW,
      stats: { wins: 0, rejects: 4 },
    };
    const game = gameState({
      promptDeck: {
        enabled: true,
        cards: [card],
        verdicts: Array.from({ length: 4 }, (_, index) => ({
          cardId: card.id,
          resultId: `rejected-${index + 1}`,
          verdict: "reject" as const,
          reason: "Selected comparison winner",
          recordedAt: `2026-07-16T00:00:0${index}.000Z`,
        })),
      },
    });
    const editor = promptCardEditor();
    const context = serviceFor({
      game,
      promptCardEditor: editor,
      createId: ids("editor-1", "suggestion-1", "suggestion-2", "child-1"),
    });

    const requested = await context.service.reconcile();
    expect(editor.enqueuePromptCardEditor).toHaveBeenCalledOnce();
    expect(requested?.promptDeck?.editorJob).toMatchObject({
      jobId: "editor-1",
      cardId: "card-1",
    });
    expect(requested?.promptDeck?.cards[0]).toMatchObject({
      editorRejectCheckpoint: 4,
    });

    editor.setResult({
      jobId: "editor-1",
      kind: "prompt-card-editor",
      status: "completed",
      completedAt: NOW,
      cardId: "card-1",
      proposals: [
        {
          title: "Copper nocturne — focused",
          prompt:
            "A focused copper-lit portrait with a quieter industrial background.",
          negativePrompt: "readable text",
          tags: ["portrait", "copper"],
          reasoningSummary: "Simplifies competing background detail.",
        },
        {
          title: "Copper nocturne — oblique",
          prompt:
            "An oblique copper-lit portrait with deliberate negative space.",
          negativePrompt: "readable text",
          tags: ["portrait", "copper"],
          reasoningSummary: "Changes camera angle while preserving the mood.",
        },
      ],
    });
    const suggested = await context.service.reconcile();
    expect(suggested?.promptDeck?.editorJob).toBeNull();
    expect(suggested?.promptDeck?.suggestions).toHaveLength(2);

    const accepted = await context.service.updatePromptDeck({
      kind: "suggestion",
      suggestionId: "suggestion-1",
      action: "accept",
    });
    expect(accepted.promptDeck?.cards).toHaveLength(2);
    expect(accepted.promptDeck?.cards[1]).toMatchObject({
      id: "child-1",
      title: "Copper nocturne — focused",
      parents: ["card-1"],
      stats: { wins: 0, rejects: 0 },
    });
    expect(accepted.promptDeck?.suggestions).toHaveLength(1);
  });

  it("saves, replaces, and deletes named preference presets without changing the active profile", async () => {
    const game = gameState();
    const context = serviceFor({ game, createId: ids("preset-1") });
    const profile = {
      ...preferenceProfileFromSeed(game.preferenceSeed),
      inspiration: "copper edge lighting",
      adaptationLastDecision: 9,
      adaptationSourceWinnerIds: ["winner-1"],
      adaptationSourceRejectedIds: ["rejected-1"],
    };

    const saved = await context.service.savePreferencePreset(
      " Copper study ",
      profile,
    );
    expect(saved.preferencePresets).toEqual([
      {
        id: "preset-1",
        name: "Copper study",
        createdAt: NOW,
        updatedAt: NOW,
        profile: {
          ...profile,
          adaptationLastDecision: 0,
          adaptationSourceWinnerIds: [],
          adaptationSourceRejectedIds: [],
        },
      },
    ]);
    expect(saved.preferenceProfile).toEqual(
      preferenceProfileFromSeed(game.preferenceSeed),
    );
    expect(context.queue.enqueue).not.toHaveBeenCalled();

    const replacement = {
      ...profile,
      inspiration: "ultraviolet rim lighting",
    };
    const replaced = await context.service.savePreferencePreset(
      "copper STUDY",
      replacement,
    );
    expect(replaced.preferencePresets).toEqual([
      expect.objectContaining({
        id: "preset-1",
        name: "copper STUDY",
        profile: {
          ...replacement,
          adaptationLastDecision: 0,
          adaptationSourceWinnerIds: [],
          adaptationSourceRejectedIds: [],
        },
      }),
    ]);

    const deleted = await context.service.deletePreferencePreset("preset-1");
    expect(deleted.preferencePresets).toEqual([]);
  });

  it("draws weighted prompt cards and records generated-card verdicts", async () => {
    const base = gameState();
    const game = gameState({
      round: {
        ...base.round,
        leftCandidate: { ...base.round.leftCandidate, promptCardId: "card-1" },
      },
    });
    game.preferenceRevisions = [
      {
        createdAt: NOW,
        source: "manual",
        profile: {
          ...game.preferenceProfile!,
          avoid: "preserve explicit exclusions",
        },
      },
    ];
    const context = serviceFor({
      game,
      createId: ids("card-1", "refill-1"),
      random: () => 0,
    });

    await context.service.createPromptCard({
      title: "Copper nocturne",
      prompt: "A severe copper-lit industrial editorial portrait.",
      negativePrompt: "readable text",
      weight: 1,
      tags: ["portrait", "copper"],
    });
    await context.service.updatePromptDeck({ kind: "deck", enabled: true });
    const updated = await context.service.select(
      "left",
      game.round.roundNumber,
    );

    expect(updated.promptDeck).toMatchObject({
      enabled: true,
      cards: [
        {
          id: "card-1",
          weight: 1.1,
          stats: { wins: 1, rejects: 0 },
        },
      ],
      verdicts: [
        {
          cardId: "card-1",
          resultId: game.round.leftCandidate.id,
          verdict: "win",
        },
      ],
    });
    expect(context.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        promptCard: expect.objectContaining({
          id: "card-1",
          title: "Copper nocturne",
        }),
      }),
    );
  });

  it("caches leaderboard image analysis and includes it in adaptive refills", async () => {
    const base = gameState();
    const game = gameState({
      preferenceProfile: {
        ...preferenceProfileFromSeed(base.preferenceSeed),
        adaptationMode: "adaptive",
      },
    });
    const analysis = leaderboardProfiles();
    const context = serviceFor({
      game,
      challengers: challengerState(game),
      leaderboardProfiles: analysis,
      createId: ids("analysis-1", "refill-1"),
    });

    await context.service.reconcile();

    expect(analysis.enqueue).toHaveBeenCalledOnce();
    await expect(context.challengerRepository.load()).resolves.toMatchObject({
      leaderboardProfileJob: {
        jobId: "analysis-1",
        fingerprint: analysis.fingerprint,
      },
      leaderboardProfileAttemptedFingerprint: analysis.fingerprint,
    });

    analysis.setResult({
      jobId: "analysis-1",
      kind: "leaderboard-profile",
      status: "completed",
      completedAt: "2026-07-16T01:01:00.000Z",
      fingerprint: analysis.fingerprint,
      profile: {
        themes: "architectural portrait studies",
        inspiration: "diagonal window light and low-angle framing",
        mediaTypes: "editorial photography",
        visualStyle: "dramatic, geometric, and tactile",
        colorPalette: "violet, charcoal, and pale gold",
        contentLevel: "family-friendly",
        avoid: "logos and readable text",
      },
      reasoningSummary: "Shared traits across the strongest pool images.",
    });

    await context.service.reconcile();

    const cached = await context.challengerRepository.load();
    expect(cached).toMatchObject({
      leaderboardProfileJob: null,
      leaderboardVisualProfile: {
        fingerprint: analysis.fingerprint,
        profile: {
          inspiration: "diagonal window light and low-angle framing",
        },
      },
    });
    expect(analysis.archive).toHaveBeenCalledWith("analysis-1");

    await context.service.select("left", 3);

    expect(context.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "refill-1",
        kind: "refill",
        leaderboardVisualProfile: cached?.leaderboardVisualProfile,
      }),
    );
    expect(analysis.prepare).toHaveBeenCalledOnce();
  });

  it("adopts a model-authored profile revision only after its candidate wins", async () => {
    const baseProfile = preferenceProfileFromSeed(
      "industrial, gothic, natural, and surprising",
    );
    const game = gameState({
      preferenceProfile: {
        ...baseProfile,
        inspiration: "Keep the lighting stark.",
        adaptationMode: "adaptive",
        adaptationStrength: "unfettered",
        adaptationLastDecision: 0,
      },
      history: Array.from({ length: 4 }, (_, index) => ({
        winnerId: `prior-winner-${index}`,
        loserId: `prior-loser-${index}`,
        winnerPrompt: `prior winner prompt ${index}`,
        loserPrompt: `prior loser prompt ${index}`,
        winnerConcept: `prior winner concept ${index}`,
        loserConcept: `prior loser concept ${index}`,
        selectedAt: `2026-07-1${index + 1}T00:00:00.000Z`,
      })),
      round: {
        ...gameState().round,
        roundNumber: 5,
        leftCandidate: {
          ...candidate("left"),
          preferenceRevision: {
            themes: "Clearly adult alternative portrait studies",
            inspiration:
              "Favor ultraviolet rim light and severe off-axis framing.",
            mediaTypes: "large-format photography",
            visualStyle: "severe and cinematic",
            colorPalette: "ultraviolet and oxblood",
            contentLevel: "adult-allowed",
            avoid: "readable text",
          },
        },
      },
    });
    const context = serviceFor({
      game,
      challengers: challengerState(game),
      bufferTarget: 2,
      createId: ids("adaptive-refill-1", "adaptive-refill-2"),
    });

    const updated = await context.service.select("left", 5);

    expect(updated.preferenceProfile).toMatchObject({
      themes: "Clearly adult alternative portrait studies",
      inspiration: "Favor ultraviolet rim light and severe off-axis framing.",
      mediaTypes: "large-format photography",
      adaptationMode: "adaptive",
      adaptationStrength: "unfettered",
      adaptationLastDecision: 5,
      adaptationSourceWinnerIds: ["left"],
      adaptationSourceRejectedIds: [],
    });
    expect(updated.preferenceSeed).toContain(
      "Inspiration: Favor ultraviolet rim light and severe off-axis framing.",
    );
    expect(updated.preferenceSeed).toContain(
      "Themes and subjects: Clearly adult alternative portrait studies",
    );
    expect(updated.preferenceRevisions).toMatchObject([
      {
        source: "initial",
        profile: { inspiration: "Keep the lighting stark." },
      },
      {
        source: "adaptive",
        profile: {
          inspiration:
            "Favor ultraviolet rim light and severe off-axis framing.",
        },
      },
    ]);
    expect(
      context.queue.enqueue.mock.calls.map(
        ([job]) => job.preferenceProfile?.adaptationMode,
      ),
    ).toEqual(["adaptive", "adaptive"]);
    expect(
      context.queue.enqueue.mock.calls.map(([job]) => job.preferenceSeed),
    ).toEqual([updated.preferenceSeed, updated.preferenceSeed]);
  });

  it("adopts validated leaderboard guidance when an imported winner reaches an Unfettered checkpoint", async () => {
    const baseProfile = preferenceProfileFromSeed(
      "industrial, gothic, natural, and surprising",
    );
    const importedWinner = candidate("imported-winner");
    const game = gameState({
      preferenceProfile: {
        ...baseProfile,
        adaptationMode: "adaptive",
        adaptationStrength: "unfettered",
        adaptationLastDecision: 0,
        contentLevel: "adult-allowed",
        avoid: "preserve explicit exclusions",
      },
      history: Array.from({ length: 4 }, (_, index) => ({
        winnerId: `prior-winner-${index}`,
        loserId: `prior-loser-${index}`,
        winnerPrompt: `prior winner prompt ${index}`,
        loserPrompt: `prior loser prompt ${index}`,
        winnerConcept: `prior winner concept ${index}`,
        loserConcept: `prior loser concept ${index}`,
        selectedAt: `2026-07-1${index + 1}T00:00:00.000Z`,
      })),
      round: {
        ...gameState().round,
        roundNumber: 5,
        leftCandidate: importedWinner,
      },
    });
    const challengers = challengerState(game);
    challengers.ratings = challengers.ratings.map((item) =>
      item.candidate.id === importedWinner.id
        ? {
            ...item,
            source: "imported",
            importItemId: "import-item-winner",
          }
        : item,
    );
    challengers.leaderboardVisualProfile = {
      fingerprint: "c".repeat(64),
      sourceCandidateIds: ["leader-1", "leader-2"],
      profile: {
        themes: "Layered nocturnal figures in reflective architectural space",
        inspiration: "Overlapping silhouettes and restrained edge light",
        mediaTypes: "painterly mixed-media illustration",
        visualStyle: "low-key, cinematic, tactile, and subtly surreal",
        colorPalette: "deep indigo, charcoal, teal, and sparse amber",
        contentLevel: "family-friendly",
        avoid: "readable text, logos, and exact copies",
      },
      reasoningSummary: "Shared qualities across recent pool leaders.",
      analyzedAt: NOW,
    };
    const context = serviceFor({
      game,
      challengers,
      bufferTarget: 2,
      createId: ids("import-adaptive-1", "import-adaptive-2"),
    });

    const updated = await context.service.select("left", 5);

    expect(updated.preferenceProfile).toMatchObject({
      themes: "Layered nocturnal figures in reflective architectural space",
      contentLevel: "adult-allowed",
      adaptationStrength: "unfettered",
      adaptationLastDecision: 5,
      adaptationSourceWinnerIds: ["imported-winner"],
    });
    expect(updated.preferenceProfile?.avoid).toBe(
      "preserve explicit exclusions",
    );
  });

  it("records a generated loser as negative adaptive evidence for future jobs", async () => {
    const baseProfile = preferenceProfileFromSeed(
      "industrial, gothic, natural, and surprising",
    );
    const game = gameState({
      preferenceProfile: { ...baseProfile, adaptationMode: "adaptive" },
    });
    const initialChallengers = challengerState(game);
    const context = serviceFor({
      game,
      challengers: {
        ...initialChallengers,
        ratings: initialChallengers.ratings.map((item) =>
          item.candidate.id === game.round.rightCandidate.id
            ? { ...item, source: "generated" }
            : item,
        ),
      },
      createId: ids("negative-evidence-refill"),
    });

    const updated = await context.service.select("left", 3);

    expect(updated.preferenceSeed).toBe(game.preferenceSeed);
    expect(updated.preferenceProfile).toMatchObject({
      adaptationMode: "adaptive",
      adaptationSourceWinnerIds: [],
      adaptationSourceRejectedIds: ["right"],
    });
    expect(context.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        preferenceProfile: expect.objectContaining({
          adaptationSourceRejectedIds: ["right"],
        }),
        selectionHistory: expect.arrayContaining([
          expect.objectContaining({ loserId: "right" }),
        ]),
      }),
    );
  });

  it("replaces buffered capacity when preferences change", async () => {
    const game = gameState({
      round: {
        ...gameState().round,
        retainedCandidateId: "left",
        winStreak: 1,
      },
    });
    const staleJob: GenerationJob = {
      id: "old-refill",
      kind: "refill",
      createdAt: NOW,
      roundNumber: game.round.roundNumber,
      winnerSide: "left",
      retainedWinner: game.round.leftCandidate,
      rejectedCandidate: game.round.rightCandidate,
      selectionHistory: game.history,
      recentConcepts: [],
      preferenceSeed: game.preferenceSeed,
      sessionId: "session-1",
      pinnedWinnerId: "left",
    };
    const challengers = challengerState(game, {
      ready: challengerState(game).ready.slice(0, 2),
      refillJobs: [
        {
          jobId: staleJob.id,
          pinnedWinnerId: "left",
          enqueuedAt: NOW,
          expectedJob: staleJob,
        },
      ],
    });
    const queue = mailbox();
    queue.setWork(staleJob);
    const context = serviceFor({
      game,
      challengers,
      queue,
      bufferTarget: 3,
      createId: ids("new-refill-1", "new-refill-2"),
    });

    await context.service.updatePreferenceSeed(
      "photographic portraits of clearly adult alternative women",
    );

    const persisted = await context.challengerRepository.load();
    expect(persisted?.ready).toEqual([]);
    expect(persisted?.refillJobs.map(({ jobId }) => jobId)).toEqual([
      "old-refill",
      "new-refill-1",
      "new-refill-2",
    ]);
    expect(
      (persisted?.ready.length ?? 0) + (persisted?.refillJobs.length ?? 0),
    ).toBe(3);
    expect(queue.enqueue).toHaveBeenCalledTimes(2);
    expect(queue.enqueue.mock.calls.map(([job]) => job.preferenceSeed)).toEqual(
      Array(2).fill(
        "photographic portraits of clearly adult alternative women",
      ),
    );
  });

  it("replaces buffered capacity when only adaptation freedom changes", async () => {
    const profile = preferenceProfileFromSeed(
      "industrial, gothic, natural, and surprising",
    );
    const game = gameState({
      preferenceProfile: profile,
      round: {
        ...gameState().round,
        retainedCandidateId: "left",
        winStreak: 1,
      },
    });
    const context = serviceFor({
      game,
      challengers: challengerState(game),
      bufferTarget: 2,
      createId: ids("adaptive-1", "adaptive-2"),
    });

    await context.service.updatePreferenceSeed(game.preferenceSeed, {
      ...profile,
      adaptationMode: "adaptive",
      adaptationStrength: "unfettered",
    });

    expect((await context.challengerRepository.load())?.ready).toEqual([]);
    expect(
      context.queue.enqueue.mock.calls.map(
        ([job]) => job.preferenceProfile?.adaptationMode,
      ),
    ).toEqual(["adaptive", "adaptive"]);
  });

  it("starts a candidate-derived variation branch and carries it into refill work", async () => {
    const game = gameState({
      round: {
        ...gameState().round,
        retainedCandidateId: "left",
        winStreak: 1,
      },
    });
    const context = serviceFor({
      game,
      challengers: challengerState(game),
      bufferTarget: 1,
      createId: ids("variation-refill"),
    });
    const profile = preferenceProfileFromSeed(
      "candidate-derived architectural portrait variations",
    );

    const saved = await context.service.updatePreferenceSeed(
      profile.themes,
      profile,
      undefined,
      "right",
    );

    expect(saved.variationSource).toEqual({
      candidateId: "right",
      concept: "right concept",
    });
    expect(saved.preferenceRevisions).toMatchObject([
      {
        createdAt: NOW,
        source: "initial",
        profile: { themes: game.preferenceSeed },
      },
      {
        createdAt: NOW,
        source: "variation",
        profile: { themes: profile.themes },
        variationSource: {
          candidateId: "right",
          concept: "right concept",
        },
      },
    ]);
    expect(context.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "variation-refill",
        variationSource: {
          candidateId: "right",
          concept: "right concept",
        },
      }),
    );
  });

  it("preserves variation parent and preference lineage on generated candidates", async () => {
    const variationSource = {
      candidateId: "left",
      concept: "left concept",
    };
    const game = gameState({ variationSource });
    const refill: GenerationJob = {
      id: "variation-refill",
      kind: "refill",
      createdAt: NOW,
      roundNumber: game.round.roundNumber,
      winnerSide: "left",
      retainedWinner: game.round.leftCandidate,
      rejectedCandidate: game.round.rightCandidate,
      selectionHistory: game.history,
      recentConcepts: [],
      preferenceSeed: game.preferenceSeed,
      variationSource,
      sessionId: "session-1",
      pinnedWinnerId: "left",
    };
    const challengers = challengerState(game, {
      ready: [],
      refillJobs: [
        {
          jobId: refill.id,
          pinnedWinnerId: "left",
          enqueuedAt: NOW,
          expectedJob: refill,
        },
      ],
    });
    const queue = mailbox();
    queue.setWork(refill);
    queue.setResult(completedResult(refill.id));
    const context = serviceFor({
      game,
      challengers,
      queue,
      bufferTarget: 1,
    });

    await context.service.reconcile();

    expect(
      (await context.challengerRepository.load())?.ratings.find(
        ({ candidate: item }) => item.id === "challenger-variation-refill",
      )?.candidate.lineage,
    ).toEqual({
      kind: "variation",
      parentCandidateId: "left",
      parentConcept: "left concept",
      preferenceFingerprint:
        "7475e123d2c54bbfd82c859e9a86edb92187bcab6dc30a7390ff1c68139a433f",
    });
  });

  it("rejects a stale preference editor without overwriting adaptive changes", async () => {
    const currentSeed = "industrial, gothic, natural, and surprising";
    const originalProfile = preferenceProfileFromSeed(currentSeed);
    const game = gameState({
      preferenceSeed: currentSeed,
      preferenceProfile: {
        ...originalProfile,
        adaptationMode: "adaptive",
        adaptationSourceWinnerIds: ["adaptive-winner"],
      },
    });
    const context = serviceFor({ game });

    await expect(
      context.service.updatePreferenceSeed(
        "stale preferences from the still-open editor",
        preferenceProfileFromSeed(
          "stale preferences from the still-open editor",
        ),
        originalProfile,
      ),
    ).rejects.toThrow(
      "Preferences changed while this editor was open. Reopen Preferences and try again.",
    );

    await expect(context.gameRepository.load()).resolves.toEqual(game);
    expect(context.queue.enqueue).not.toHaveBeenCalled();
  });

  it("clears a moderation notice when preferences are saved or the notice is dismissed", async () => {
    const profile = preferenceProfileFromSeed(
      "industrial, gothic, natural, and surprising",
    );
    const game = gameState({
      preferenceProfile: profile,
      generationNotice: {
        kind: "moderation-block",
        jobId: "blocked-refill",
        occurredAt: NOW,
        occurrenceCount: 1,
      },
    });
    const context = serviceFor({ game });

    const saved = await context.service.updatePreferenceSeed(
      game.preferenceSeed,
      profile,
    );
    expect(saved.generationNotice).toBeUndefined();

    await context.gameRepository.save(game);
    const dismissed = await context.service.dismissGenerationNotice();
    expect(dismissed.generationNotice).toBeUndefined();
    expect(
      (await context.gameRepository.load())?.generationNotice,
    ).toBeUndefined();
  });

  it("reconciles a pre-feature profile-less generation work file", async () => {
    const game = gameState({
      round: {
        ...gameState().round,
        status: "generating",
        replacingSide: "right",
        retainedCandidateId: "left",
      },
      pendingSelection: {
        kind: "generation",
        winnerSide: "left",
        selectedAt: NOW,
        generationJobId: "legacy-generation",
      },
    });
    const legacyWork: GenerationJob = {
      id: "legacy-generation",
      kind: "challenger",
      createdAt: NOW,
      roundNumber: game.round.roundNumber,
      winnerSide: "left",
      retainedWinner: game.round.leftCandidate,
      rejectedCandidate: game.round.rightCandidate,
      selectionHistory: game.history,
      recentConcepts: ["recent loser concept", "recent winner concept"],
      preferenceSeed: game.preferenceSeed,
    };
    const queue = mailbox();
    queue.setWork(legacyWork);
    queue.setResult(completedResult(legacyWork.id));
    const context = serviceFor({ game, queue });

    const recovered = await context.service.reconcile();

    expect(recovered?.round).toMatchObject({
      status: "idle",
      leftCandidate: { id: "left" },
      rightCandidate: { id: "challenger-legacy-generation" },
    });
    expect(context.assets.verify).toHaveBeenCalledOnce();
    expect(queue.archive).toHaveBeenCalledWith("legacy-generation");
  });

  it("discards a completed refill from an earlier preference seed", async () => {
    const game = gameState({
      preferenceSeed:
        "photographic portraits of clearly adult alternative women",
      round: {
        ...gameState().round,
        retainedCandidateId: "left",
        winStreak: 1,
      },
    });
    const staleJob: GenerationJob = {
      id: "old-refill",
      kind: "refill",
      createdAt: NOW,
      roundNumber: game.round.roundNumber,
      winnerSide: "left",
      retainedWinner: game.round.leftCandidate,
      rejectedCandidate: game.round.rightCandidate,
      selectionHistory: game.history,
      recentConcepts: [],
      preferenceSeed: "the old preference seed",
      sessionId: "session-1",
      pinnedWinnerId: "left",
    };
    const challengers = challengerState(game, {
      ready: [],
      refillJobs: [
        {
          jobId: staleJob.id,
          pinnedWinnerId: "left",
          enqueuedAt: NOW,
          expectedJob: staleJob,
        },
      ],
    });
    const queue = mailbox();
    queue.setWork(staleJob);
    queue.setResult(completedResult(staleJob.id));
    const context = serviceFor({
      game,
      challengers,
      queue,
      bufferTarget: 1,
      createId: ids("replacement-refill"),
    });

    await context.service.reconcile();

    expect(context.assets.verify).not.toHaveBeenCalled();
    expect(queue.archive).toHaveBeenCalledWith("old-refill");
    expect(
      (await context.challengerRepository.load())?.refillJobs,
    ).toMatchObject([
      {
        jobId: "replacement-refill",
        expectedJob: {
          preferenceSeed: game.preferenceSeed,
        },
      },
    ]);
  });

  it("backfills existing zero-win generated candidates during reconciliation", async () => {
    const game = gameState();
    const overlooked = candidate("overlooked");
    const challengers = challengerState(game, {
      ratings: [
        ...challengerState(game).ratings,
        rating(overlooked, {
          source: "generated",
          poolMember: false,
          losses: 2,
        }),
      ],
    });
    const context = serviceFor({ game, challengers });

    await context.service.reconcile();

    expect(
      (await context.challengerRepository.load())?.ratings.find(
        ({ candidate: item }) => item.id === overlooked.id,
      ),
    ).toMatchObject({ wins: 0, losses: 2, poolMember: true });
  });

  it.each(["left", "right"] as const)(
    "preserves the exact %s winner and immediately consumes one FIFO head",
    async (winnerSide) => {
      const game = gameState();
      const originalWinner =
        winnerSide === "left"
          ? game.round.leftCandidate
          : game.round.rightCandidate;
      const originalWinnerSnapshot = structuredClone(originalWinner);
      const challengers = challengerState(game);
      const head = challengers.ready[0].candidate;
      const context = serviceFor({ game, challengers });

      const selected = await context.service.select(winnerSide, 3);

      expect(
        winnerSide === "left"
          ? selected.round.leftCandidate
          : selected.round.rightCandidate,
      ).toBe(originalWinner);
      expect(originalWinner).toEqual(originalWinnerSnapshot);
      expect(
        winnerSide === "left"
          ? selected.round.rightCandidate
          : selected.round.leftCandidate,
      ).toEqual(head);
      expect(selected.round.status).toBe("idle");
      expect(selected.round.roundNumber).toBe(4);
      expect(selected.pendingSelection).toBeUndefined();

      const persisted = await context.challengerRepository.load();
      expect(persisted?.ready.map(({ candidate: item }) => item.id)).toEqual([
        "buffer-2",
        "buffer-3",
        "buffer-4",
        "buffer-5",
      ]);
      expect(persisted?.refillJobs).toEqual([
        {
          jobId: "refill-1",
          pinnedWinnerId: originalWinner.id,
          enqueuedAt: NOW,
          expectedJob: context.queue.enqueue.mock.calls[0][0],
        },
      ]);
      expect(context.queue.enqueue).toHaveBeenCalledTimes(1);
      expect(context.queue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "refill-1",
          kind: "refill",
          sessionId: "session-1",
          pinnedWinnerId: originalWinner.id,
          retainedWinner: originalWinnerSnapshot,
          preferenceSeed: game.preferenceSeed,
        }),
      );
      expect(
        context.queue.enqueue.mock.calls.some(
          ([job]) => job.kind === "challenger",
        ),
      ).toBe(false);

      const winnerRating = persisted?.ratings.find(
        ({ candidate: item }) => item.id === originalWinner.id,
      );
      const loserRating = persisted?.ratings.find(
        ({ candidate: item }) =>
          item.id !== originalWinner.id && ["left", "right"].includes(item.id),
      );
      expect(winnerRating).toMatchObject({ rating: 1016, wins: 1 });
      expect(loserRating).toMatchObject({ rating: 984, losses: 1 });
    },
  );

  it("raises only the lower Elo score on a tie and clears both candidates", async () => {
    const game = gameState({
      preferenceProfile: {
        ...preferenceProfileFromSeed(
          "industrial, gothic, natural, and surprising",
        ),
        adaptationMode: "adaptive",
      },
    });
    const challengers = challengerState(game, {
      ratings: [
        rating(game.round.leftCandidate, { rating: 900 }),
        rating(game.round.rightCandidate, { rating: 1100 }),
        ...challengerState(game).ready.map(({ candidate: item }) =>
          rating(item),
        ),
      ],
    });
    const context = serviceFor({ game, challengers });

    const tied = await context.service.tie(3);

    expect(tied.round).toMatchObject({
      status: "idle",
      roundNumber: 4,
      leftCandidate: { id: "buffer-1" },
      rightCandidate: { id: "buffer-2" },
      retainedCandidateId: null,
      winStreak: 0,
    });
    expect(tied.history.at(-1)).toMatchObject({
      outcome: "tie",
      leftId: "left",
      rightId: "right",
    });
    expect(tied.preferenceProfile?.adaptationSourceWinnerIds).toEqual([]);
    expect(tied.preferenceProfile?.adaptationSourceRejectedIds).toEqual([]);

    const persisted = await context.challengerRepository.load();
    expect(
      persisted?.ratings.find(({ candidate: item }) => item.id === "left"),
    ).toMatchObject({ rating: 924.311902, wins: 0, losses: 0 });
    expect(
      persisted?.ratings.find(({ candidate: item }) => item.id === "right"),
    ).toMatchObject({ rating: 1100, wins: 0, losses: 0 });
    expect(persisted?.ready.map(({ candidate: item }) => item.id)).toEqual([
      "buffer-3",
      "buffer-4",
      "buffer-5",
    ]);
    expect(context.queue.enqueue).toHaveBeenCalledTimes(2);
    expect(context.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "refill",
        comparisonOutcome: "tie",
        pinnedWinnerId: "left",
        leaderboardEvidence: expect.objectContaining({
          poolSize: 7,
          entries: expect.arrayContaining([
            expect.objectContaining({
              rank: 1,
              candidateId: "right",
              rating: 1100,
              wins: 0,
              losses: 0,
            }),
          ]),
        }),
      }),
    );
  });

  it("leaves equal Elo scores unchanged on a tie", async () => {
    const game = gameState();
    const context = serviceFor({ game, challengers: challengerState(game) });

    await context.service.tie(3);

    const persisted = await context.challengerRepository.load();
    expect(
      persisted?.ratings
        .filter(({ candidate: item }) => ["left", "right"].includes(item.id))
        .map(({ rating: value, wins, losses }) => ({ value, wins, losses })),
    ).toEqual([
      { value: 1000, wins: 0, losses: 0 },
      { value: 1000, wins: 0, losses: 0 },
    ]);
  });

  it("records both candidates as rejected without changing Elo", async () => {
    const game = gameState({
      preferenceProfile: {
        ...preferenceProfileFromSeed(
          "industrial, gothic, natural, and surprising",
        ),
        adaptationMode: "adaptive",
      },
    });
    const challengers = challengerState(game, {
      ratings: [
        rating(game.round.leftCandidate, {
          rating: 900,
          source: "generated",
        }),
        rating(game.round.rightCandidate, {
          rating: 1100,
          source: "generated",
        }),
        ...challengerState(game).ready.map(({ candidate: item }) =>
          rating(item),
        ),
      ],
    });
    const context = serviceFor({ game, challengers });

    const rejected = await context.service.bothLose(3);

    expect(rejected.round).toMatchObject({
      status: "idle",
      roundNumber: 4,
      leftCandidate: { id: "buffer-1" },
      rightCandidate: { id: "buffer-2" },
      retainedCandidateId: null,
      winStreak: 0,
    });
    expect(rejected.history.at(-1)).toMatchObject({
      outcome: "both-lose",
      leftId: "left",
      rightId: "right",
    });
    expect(rejected.preferenceProfile).toMatchObject({
      adaptationSourceWinnerIds: [],
      adaptationSourceRejectedIds: ["left", "right"],
    });

    await context.service.reconcile();
    const persisted = await context.challengerRepository.load();
    expect(
      persisted?.ratings.find(({ candidate: item }) => item.id === "left"),
    ).toMatchObject({
      rating: 900,
      wins: 0,
      losses: 1,
      poolMember: false,
      poolEligible: false,
    });
    expect(
      persisted?.ratings.find(({ candidate: item }) => item.id === "right"),
    ).toMatchObject({
      rating: 1100,
      wins: 0,
      losses: 1,
      poolMember: false,
      poolEligible: false,
    });
    expect(context.queue.enqueue).toHaveBeenCalledTimes(2);
    expect(context.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "refill",
        comparisonOutcome: "both-lose",
      }),
    );
  });

  it("keeps tied cards visible until two generated replacements are ready", async () => {
    const game = gameState();
    const challengers = challengerState(game, { ready: [] });
    const context = serviceFor({
      game,
      challengers,
      bufferTarget: 3,
      createId: ids("tie-refill-1", "tie-refill-2", "tie-refill-3"),
    });

    const waiting = await context.service.tie(3);
    expect(waiting.round.status).toBe("generating");
    expect(waiting.pendingSelection).toMatchObject({ kind: "tie" });
    expect(context.queue.enqueue).toHaveBeenCalledTimes(3);

    context.queue.setResult(completedResult("tie-refill-1"));
    expect((await context.service.reconcile())?.round.status).toBe(
      "generating",
    );
    context.queue.setResult(completedResult("tie-refill-2"));
    const completed = await context.service.reconcile();
    expect(completed?.round).toMatchObject({
      status: "idle",
      leftCandidate: { id: "challenger-tie-refill-1" },
      rightCandidate: { id: "challenger-tie-refill-2" },
    });
  });

  it("loads two distinct pool images when a tied round has an empty queue", async () => {
    let currentNow = NOW;
    const now = () => currentNow;
    const game = gameState();
    const poolA = candidate("pool-a");
    const poolB = candidate("pool-b");
    const challengers = challengerState(game, {
      ready: [],
      ratings: [
        rating(game.round.leftCandidate),
        rating(game.round.rightCandidate),
        rating(poolA),
        rating(poolB),
      ],
    });
    const context = serviceFor({
      game,
      challengers,
      now,
      random: () => 0,
      bufferTarget: 2,
      createId: ids("tie-refill-1", "tie-refill-2"),
    });

    const waiting = await context.service.tie(3);
    expect(waiting.round).toMatchObject({
      status: "generating",
      leftCandidate: { id: "left" },
      rightCandidate: { id: "right" },
    });
    await expect(context.challengerRepository.load()).resolves.toMatchObject({
      nextFallbackAt: "2026-07-16T01:00:03.000Z",
      consecutiveFallbackDraws: 0,
    });

    currentNow = "2026-07-16T01:00:03.000Z";
    const completed = await context.service.reconcile();
    expect(completed?.round).toMatchObject({
      status: "idle",
      roundNumber: 4,
      leftCandidate: { id: "pool-a" },
      rightCandidate: { id: "pool-b" },
    });
    await expect(context.challengerRepository.load()).resolves.toMatchObject({
      ready: [],
      consecutiveFallbackDraws: 2,
      nextFallbackAt: null,
      pendingSelectionBaseline: null,
    });
  });

  it("combines one queued image with one pool image after a tie", async () => {
    let currentNow = NOW;
    const now = () => currentNow;
    const game = gameState();
    const queued = candidate("queued");
    const fallback = candidate("fallback");
    const challengers = challengerState(game, {
      ready: [
        {
          candidate: queued,
          source: "seed",
          importItemId: null,
          pinnedWinnerId: null,
          enqueuedAt: NOW,
        },
      ],
      ratings: [
        rating(game.round.leftCandidate),
        rating(game.round.rightCandidate),
        rating(queued),
        rating(fallback),
      ],
    });
    const context = serviceFor({
      game,
      challengers,
      now,
      random: () => 0,
      bufferTarget: 2,
      createId: ids("tie-refill-1"),
    });

    expect((await context.service.tie(3)).round.status).toBe("generating");
    currentNow = "2026-07-16T01:00:03.000Z";
    const completed = await context.service.reconcile();

    expect(completed?.round).toMatchObject({
      status: "idle",
      leftCandidate: { id: "queued" },
      rightCandidate: { id: "fallback" },
    });
    await expect(context.challengerRepository.load()).resolves.toMatchObject({
      ready: [],
      consecutiveFallbackDraws: 1,
      nextFallbackAt: null,
    });
  });

  it("retires a ten-win champion and consumes two FIFO heads", async () => {
    const game = gameState();
    game.round.retainedCandidateId = game.round.leftCandidate.id;
    game.round.winStreak = 9;
    const challengers = challengerState(game);
    const context = serviceFor({ game, challengers });

    const selected = await context.service.select("left", 3);

    expect(selected.round).toMatchObject({
      status: "idle",
      roundNumber: 4,
      leftCandidate: { id: "buffer-1" },
      rightCandidate: { id: "buffer-2" },
      retainedCandidateId: null,
      winStreak: 0,
    });
    expect(selected.history.at(-1)).toMatchObject({
      winnerId: "left",
      loserId: "right",
      selectedAt: NOW,
    });
    const persisted = await context.challengerRepository.load();
    expect(persisted?.ready.map(({ candidate: item }) => item.id)).toEqual([
      "buffer-3",
      "buffer-4",
      "buffer-5",
    ]);
    expect(context.queue.enqueue).toHaveBeenCalledTimes(2);
    expect(
      persisted?.ratings.find(({ candidate: item }) => item.id === "left"),
    ).toMatchObject({ wins: 1, rating: 1016 });
  });

  it("keeps both retired cards visible until two generated replacements are ready", async () => {
    const game = gameState();
    game.round.retainedCandidateId = game.round.rightCandidate.id;
    game.round.winStreak = 9;
    const challengers = challengerState(game, {
      ready: [],
      ratings: [
        rating(game.round.leftCandidate),
        rating(game.round.rightCandidate),
        rating(candidate("fallback")),
      ],
    });
    const context = serviceFor({
      game,
      challengers,
      bufferTarget: 3,
      createId: ids("refill-1", "refill-2", "refill-3"),
    });

    const waiting = await context.service.select("right", 3);

    expect(waiting.round).toMatchObject({
      status: "generating",
      replacingSide: null,
      leftCandidate: { id: "left" },
      rightCandidate: { id: "right" },
    });
    expect(waiting.pendingSelection).toMatchObject({
      kind: "retirement",
      winnerSide: "right",
    });
    expect(context.queue.enqueue).toHaveBeenCalledTimes(3);

    context.queue.setResult(completedResult("refill-1"));
    const oneReady = await context.service.reconcile();
    expect(oneReady?.round.status).toBe("generating");
    expect(oneReady?.round.leftCandidate.id).toBe("left");
    expect(oneReady?.round.rightCandidate.id).toBe("right");

    context.queue.setResult(completedResult("refill-2"));
    const completed = await context.service.reconcile();
    expect(completed?.round).toMatchObject({
      status: "idle",
      roundNumber: 4,
      leftCandidate: { id: "challenger-refill-1" },
      rightCandidate: { id: "challenger-refill-2" },
      retainedCandidateId: null,
      winStreak: 0,
    });
    expect(completed?.history).toHaveLength(game.history.length + 1);
  });

  it("keeps stale ready and in-flight work while new deficit jobs pin to the new winner", async () => {
    const game = gameState();
    const staleReady = [
      {
        candidate: candidate("stale-head"),
        source: "generated" as const,
        importItemId: null,
        pinnedWinnerId: "old-winner",
        enqueuedAt: "2026-07-15T23:00:00.000Z",
      },
      {
        candidate: candidate("stale-tail"),
        source: "generated" as const,
        importItemId: null,
        pinnedWinnerId: "old-winner",
        enqueuedAt: "2026-07-15T23:01:00.000Z",
      },
    ];
    const staleJob = {
      id: "old-refill",
      kind: "refill" as const,
      createdAt: "2026-07-15T23:02:00.000Z",
      roundNumber: 2,
      winnerSide: "left" as const,
      retainedWinner: candidate("old-winner"),
      rejectedCandidate: candidate("old-loser"),
      selectionHistory: [],
      recentConcepts: [],
      preferenceSeed: game.preferenceSeed,
      sessionId: "session-1",
      pinnedWinnerId: "old-winner",
    };
    const challengers = challengerState(game, {
      ready: staleReady,
      refillJobs: [
        {
          jobId: "old-refill",
          pinnedWinnerId: "old-winner",
          enqueuedAt: "2026-07-15T23:02:00.000Z",
          expectedJob: staleJob,
        },
      ],
      ratings: [
        rating(game.round.leftCandidate),
        rating(game.round.rightCandidate, {
          source: "generated",
          poolMember: false,
        }),
        ...staleReady.map(({ candidate: item }) =>
          rating(item, { source: "generated", poolMember: false }),
        ),
      ],
    });
    const queue = mailbox();
    queue.setWork(staleJob);
    const context = serviceFor({
      game,
      challengers,
      queue,
      bufferTarget: 4,
      createId: ids("new-refill-1", "new-refill-2"),
    });

    await context.service.select("right", 3);

    const persisted = await context.challengerRepository.load();
    const enqueuedJobs = context.queue.enqueue.mock.calls.map(([job]) => job);
    expect(persisted?.ready).toEqual([staleReady[1]]);
    expect(persisted?.refillJobs).toEqual([
      challengers.refillJobs[0],
      {
        jobId: "new-refill-1",
        pinnedWinnerId: "right",
        enqueuedAt: NOW,
        expectedJob: enqueuedJobs[0],
      },
      {
        jobId: "new-refill-2",
        pinnedWinnerId: "right",
        enqueuedAt: NOW,
        expectedJob: enqueuedJobs[1],
      },
    ]);
    expect(await queue.readWork("old-refill")).toEqual(staleJob);
    expect(queue.enqueue).toHaveBeenCalledTimes(2);
    expect(
      queue.enqueue.mock.calls.map(([job]) =>
        job.kind === "refill" ? job.pinnedWinnerId : null,
      ),
    ).toEqual(["right", "right"]);
    expect(
      persisted?.ratings.find(({ candidate: item }) => item.id === "right"),
    ).toMatchObject({ wins: 1, poolMember: true });
  });

  it("admits an unrated generated loser into a non-full reusable pool", async () => {
    const game = gameState();
    game.round.leftCandidate = {
      ...game.round.leftCandidate,
      imageUrl: "/seed-assets/left.png",
    };
    const ready = challengerState(game).ready;
    const challengers = challengerState(game, {
      ready,
      ratings: [
        rating(game.round.leftCandidate),
        ...ready.map(({ candidate: item }) => rating(item)),
      ],
    });
    const context = serviceFor({ game, challengers });

    await context.service.select("left", 3);

    expect(
      (await context.challengerRepository.load())?.ratings.find(
        ({ candidate: item }) => item.id === "right",
      ),
    ).toMatchObject({ source: "generated", poolMember: true, losses: 1 });
  });

  it("serializes concurrent selections so only one consumes the FIFO head", async () => {
    const game = gameState();
    const challengers = challengerState(game, {
      ready: [challengerState(game).ready[0]],
    });
    const gameRepository = new MemoryGameRepository(game);
    const challengerRepository = new MemoryChallengerRepository(challengers);
    const queue = mailbox();
    const first = serviceFor({
      gameRepository,
      challengerRepository,
      queue,
      bufferTarget: 1,
      createId: ids("first-refill"),
    }).service;
    const second = serviceFor({
      gameRepository,
      challengerRepository,
      queue,
      bufferTarget: 1,
      createId: ids("second-refill"),
    }).service;

    const outcomes = await Promise.allSettled([
      first.select("left", 3),
      second.select("right", 3),
    ]);

    expect(
      outcomes.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = outcomes.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.any(SelectionConflictError),
    });
    expect((await challengerRepository.load())?.ready).toEqual([]);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("replays the prepared FIFO head when the completed game save fails", async () => {
    const game = gameState();
    const backingGame = new MemoryGameRepository(game);
    let failCompletedSave = true;
    const gameRepository: GameRepository = {
      load: () => backingGame.load(),
      clear: () => backingGame.clear(),
      withLock: (operation) => backingGame.withLock(operation),
      save: async (state) => {
        if (failCompletedSave && state.round.status === "idle") {
          failCompletedSave = false;
          throw new Error("game disk unavailable");
        }
        await backingGame.save(state);
      },
    };
    const context = serviceFor({ game, gameRepository });

    await expect(context.service.select("left", 3)).rejects.toThrow(
      "game disk unavailable",
    );
    await expect(backingGame.load()).resolves.toMatchObject({
      round: { status: "generating", roundNumber: 3 },
      pendingSelection: { kind: "buffer", winnerSide: "left" },
    });
    const prepared = await context.challengerRepository.load();
    expect(prepared?.ready[0].candidate.id).toBe("buffer-2");
    expect(prepared?.preparedDequeues).toMatchObject([
      { candidate: { id: "buffer-1" }, replacementSlot: "single" },
    ]);
    expect(prepared?.refillJobs).toMatchObject([{ jobId: "refill-1" }]);

    const recovered = await context.service.reconcile();

    expect(recovered?.round).toMatchObject({
      status: "idle",
      roundNumber: 4,
      rightCandidate: { id: "buffer-1" },
    });
    const persisted = await context.challengerRepository.load();
    expect(persisted?.ready.map(({ candidate: item }) => item.id)).toEqual([
      "buffer-2",
      "buffer-3",
      "buffer-4",
      "buffer-5",
    ]);
    expect(
      persisted?.ratings.find(({ candidate: item }) => item.id === "left"),
    ).toMatchObject({ wins: 1, rating: 1016 });
  });

  it("replays both prepared FIFO heads when a retirement save fails", async () => {
    const game = gameState();
    game.round.retainedCandidateId = game.round.leftCandidate.id;
    game.round.winStreak = 9;
    const backingGame = new MemoryGameRepository(game);
    let failCompletedSave = true;
    const gameRepository: GameRepository = {
      load: () => backingGame.load(),
      clear: () => backingGame.clear(),
      withLock: (operation) => backingGame.withLock(operation),
      save: async (state) => {
        if (failCompletedSave && state.round.status === "idle") {
          failCompletedSave = false;
          throw new Error("game disk unavailable");
        }
        await backingGame.save(state);
      },
    };
    const context = serviceFor({ game, gameRepository });

    await expect(context.service.select("left", 3)).rejects.toThrow(
      "game disk unavailable",
    );
    await expect(backingGame.load()).resolves.toMatchObject({
      round: { status: "generating", roundNumber: 3 },
      pendingSelection: { kind: "retirement", winnerSide: "left" },
    });
    const prepared = await context.challengerRepository.load();
    expect(
      prepared?.ready.slice(0, 2).map(({ candidate: item }) => item.id),
    ).toEqual(["buffer-3", "buffer-4"]);
    expect(
      prepared?.preparedDequeues?.map(({ candidate: item }) => item.id),
    ).toEqual(["buffer-1", "buffer-2"]);

    const recovered = await context.service.reconcile();
    expect(recovered?.round).toMatchObject({
      status: "idle",
      leftCandidate: { id: "buffer-1" },
      rightCandidate: { id: "buffer-2" },
      retainedCandidateId: null,
      winStreak: 0,
    });
  });

  it("replays an unsaved comparison exactly once after service restart", async () => {
    const game = gameState();
    const generatedWinner = game.round.rightCandidate;
    const initialChallengers = challengerState(game, {
      ratings: [
        rating(game.round.leftCandidate),
        rating(generatedWinner, {
          source: "generated",
          poolMember: false,
        }),
        ...challengerState(game).ready.map(({ candidate: item }) =>
          rating(item),
        ),
      ],
    });
    const gameRepository = new MemoryGameRepository(game);
    const backingChallengers = new MemoryChallengerRepository(
      initialChallengers,
    );
    let failComparisonSave = true;
    const challengerRepository: ChallengerRepository = {
      load: () => backingChallengers.load(),
      clearSession: (sessionId) => backingChallengers.clearSession(sessionId),
      withLock: (operation) => backingChallengers.withLock(operation),
      save: async (state) => {
        if (failComparisonSave) {
          failComparisonSave = false;
          throw new Error("challenger disk unavailable");
        }
        await backingChallengers.save(state);
      },
    };
    const queue = mailbox();
    const first = serviceFor({
      game,
      gameRepository,
      challengerRepository,
      queue,
      createId: ids("failed-attempt", "restart-refill"),
    });

    await expect(first.service.select("right", 3)).rejects.toThrow(
      "challenger disk unavailable",
    );
    await expect(gameRepository.load()).resolves.toMatchObject({
      round: { status: "generating", roundNumber: 3 },
      pendingSelection: { kind: "buffer", winnerSide: "right" },
    });

    const restarted = serviceFor({
      gameRepository,
      challengerRepository,
      queue,
      createId: ids("restart-refill"),
    });
    const recovered = await restarted.service.reconcile();
    await restarted.service.reconcile();

    expect(recovered?.round).toMatchObject({
      status: "idle",
      roundNumber: 4,
      leftCandidate: { id: "buffer-1" },
      rightCandidate: { id: generatedWinner.id },
    });
    const persisted = await backingChallengers.load();
    expect(
      persisted?.ratings.find(
        ({ candidate: item }) => item.id === generatedWinner.id,
      ),
    ).toMatchObject({
      rating: 1016,
      wins: 1,
      losses: 0,
      poolMember: true,
    });
    expect(
      persisted?.ratings.find(
        ({ candidate: item }) => item.id === game.round.leftCandidate.id,
      ),
    ).toMatchObject({ rating: 984, wins: 0, losses: 1 });
    expect(recovered?.history).toHaveLength(game.history.length + 1);
  });

  it("waits three seconds before drawing a random eligible fallback", async () => {
    let currentNow = NOW;
    const now = () => currentNow;
    const game = gameState();
    const eligibleA = candidate("eligible-a");
    const eligibleB = candidate("eligible-b");
    const recentWinner = candidate("recent-winner");
    const recentLoser = candidate("recent-loser");
    const challengers = challengerState(game, {
      ready: [],
      ratings: [
        rating(game.round.leftCandidate),
        rating(game.round.rightCandidate),
        rating(recentWinner),
        rating(recentLoser),
        rating(eligibleA),
        rating(eligibleB),
      ],
      generationTurnaroundEmaMs: 100_000,
    });
    const context = serviceFor({
      game,
      challengers,
      now,
      random: () => 0.75,
      bufferTarget: 1,
    });

    const selected = await context.service.select("left", 3);

    expect(selected.round.status).toBe("generating");
    await expect(context.challengerRepository.load()).resolves.toMatchObject({
      consecutiveFallbackDraws: 0,
      nextFallbackAt: "2026-07-16T01:00:03.000Z",
      pendingSelectionBaseline: {
        consecutiveFallbackDraws: 0,
        nextFallbackAt: null,
      },
    });

    currentNow = "2026-07-16T01:00:02.999Z";
    expect((await context.service.reconcile())?.round.status).toBe(
      "generating",
    );

    currentNow = "2026-07-16T01:00:03.000Z";
    const completed = await context.service.reconcile();
    expect(completed?.round.rightCandidate.id).toBe("eligible-b");
    expect(completed?.round.status).toBe("idle");
    await expect(context.challengerRepository.load()).resolves.toMatchObject({
      consecutiveFallbackDraws: 1,
      nextFallbackAt: null,
      pendingSelectionBaseline: null,
    });
  });

  it("allows a tenth fallback and hard-stops an eleventh", async () => {
    let currentNow = NOW;
    const now = () => currentNow;
    const game = gameState();
    const challengers = challengerState(game, {
      ready: [],
      ratings: [
        rating(game.round.leftCandidate),
        rating(game.round.rightCandidate),
        rating(candidate("fallback-10")),
        rating(candidate("fallback-11")),
      ],
      consecutiveFallbackDraws: 9,
      nextFallbackAt: null,
    });
    const context = serviceFor({
      game,
      challengers,
      now,
      random: () => 0,
      bufferTarget: 1,
    });
    const waiting = await context.service.select("left", 3);
    expect(waiting.round.status).toBe("generating");
    currentNow = "2026-07-16T01:00:03.000Z";
    const tenth = await context.service.reconcile();
    expect(tenth?.round.rightCandidate.id).toBe("fallback-10");
    expect(tenth?.round.status).toBe("idle");
    await expect(context.challengerRepository.load()).resolves.toMatchObject({
      consecutiveFallbackDraws: 10,
    });

    currentNow = "2026-07-16T01:00:10.000Z";
    const eleventh = await context.service.select("left", 4);
    expect(eleventh.round.status).toBe("generating");
    const stillWaiting = await context.service.reconcile();
    expect(stillWaiting?.round.status).toBe("generating");
    expect(stillWaiting?.round.rightCandidate.id).toBe("fallback-10");
  });

  it("validates a completed refill, updates EMA, and immediately serves a waiting selection", async () => {
    const game = gameState();
    const challengers = challengerState(game, {
      ready: [],
      ratings: [
        rating(game.round.leftCandidate),
        rating(game.round.rightCandidate),
      ],
      consecutiveFallbackDraws: 2,
      nextFallbackAt: "2026-07-16T01:10:00.000Z",
    });
    const context = serviceFor({ game, challengers, bufferTarget: 1 });
    const waiting = await context.service.select("left", 3);
    expect(waiting.round.status).toBe("generating");
    const refill = context.queue.enqueue.mock.calls[0][0];
    context.queue.setResult(
      completedResult(refill.id, "2026-07-16T01:03:20.000Z"),
    );

    const completed = await context.service.reconcile();

    expect(completed?.round.status).toBe("idle");
    expect(completed?.round.leftCandidate).toBe(game.round.leftCandidate);
    expect(completed?.round.rightCandidate).toMatchObject({
      id: `challenger-${refill.id}`,
      imageUrl: `/api/assets/challenger-${refill.id}.png`,
      winCount: 0,
    });
    expect(context.assets.verify).toHaveBeenCalledWith(
      expect.objectContaining({ candidateId: `challenger-${refill.id}` }),
    );
    expect(context.queue.archive).toHaveBeenCalledWith(refill.id);
    const persisted = await context.challengerRepository.load();
    expect(persisted?.generationTurnaroundEmaMs).toBe(125_000);
    expect(persisted).toMatchObject({
      consecutiveFallbackDraws: 0,
      nextFallbackAt: null,
    });
    expect(
      persisted?.ratings.find(
        ({ candidate: item }) => item.id === `challenger-${refill.id}`,
      ),
    ).toMatchObject({
      source: "generated",
      rating: challengerConfig.initialRating,
      poolMember: false,
    });
  });

  it("appends concurrently completed refills in terminal completion order", async () => {
    const game = gameState({
      round: {
        ...gameState().round,
        retainedCandidateId: "left",
        winStreak: 1,
      },
    });
    const jobs: Extract<GenerationJob, { kind: "refill" }>[] = [
      "slow-refill",
      "fast-refill",
    ].map((id) => ({
      id,
      kind: "refill",
      createdAt: NOW,
      roundNumber: 3,
      winnerSide: "left",
      retainedWinner: game.round.leftCandidate,
      rejectedCandidate: game.round.rightCandidate,
      selectionHistory: game.history,
      recentConcepts: [],
      preferenceSeed: game.preferenceSeed,
      sessionId: "session-1",
      pinnedWinnerId: "left",
    }));
    const records = jobs.map((expectedJob) => ({
      jobId: expectedJob.id,
      pinnedWinnerId: expectedJob.pinnedWinnerId,
      enqueuedAt: expectedJob.createdAt,
      expectedJob,
    }));
    const challengers = challengerState(game, {
      ready: [],
      refillJobs: records,
      ratings: [
        rating(game.round.leftCandidate),
        rating(game.round.rightCandidate),
      ],
    });
    const queue = mailbox();
    for (const job of jobs) queue.setWork(job);
    queue.setResult(completedResult("slow-refill", "2026-07-16T01:04:00.000Z"));
    queue.setResult(completedResult("fast-refill", "2026-07-16T01:02:00.000Z"));
    const context = serviceFor({
      game,
      challengers,
      queue,
      bufferTarget: 2,
    });

    await context.service.reconcile();

    expect(
      (await context.challengerRepository.load())?.ready.map(
        ({ candidate: item }) => item.id,
      ),
    ).toEqual(["challenger-fast-refill", "challenger-slow-refill"]);
  });

  it("removes and replaces a failed refill without changing EMA or the waiting round", async () => {
    const game = gameState();
    const challengers = challengerState(game, {
      ready: [],
      ratings: [
        rating(game.round.leftCandidate),
        rating(game.round.rightCandidate),
      ],
    });
    const context = serviceFor({
      game,
      challengers,
      bufferTarget: 1,
      createId: ids("failed-refill", "replacement-refill"),
    });
    const waiting = await context.service.select("right", 3);
    context.queue.setResult({
      jobId: "failed-refill",
      status: "failed",
      completedAt: "2026-07-16T01:01:40.000Z",
      message: "generation interrupted",
      retryable: true,
    });

    const unchanged = await context.service.reconcile();

    expect(unchanged?.round).toEqual(waiting.round);
    expect(unchanged?.history).toEqual(waiting.history);
    await expect(context.challengerRepository.load()).resolves.toMatchObject({
      generationTurnaroundEmaMs: 100_000,
      refillJobs: [
        {
          jobId: "replacement-refill",
          pinnedWinnerId: "right",
        },
      ],
    });
    expect(context.queue.archive).toHaveBeenCalledWith("failed-refill");
    expect(context.queue.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "replacement-refill", kind: "refill" }),
    );
  });

  it("surfaces a moderation-blocked refill while restoring queue capacity", async () => {
    const game = gameState();
    const challengers = challengerState(game, {
      ready: [],
      ratings: [
        rating(game.round.leftCandidate),
        rating(game.round.rightCandidate),
      ],
    });
    const context = serviceFor({
      game,
      challengers,
      bufferTarget: 1,
      createId: ids("blocked-refill", "replacement-refill"),
    });
    await context.service.select("right", 3);
    context.queue.setResult({
      jobId: "blocked-refill",
      status: "failed",
      completedAt: "2026-07-16T01:01:40.000Z",
      message: "Image provider rejected this request",
      retryable: true,
      category: "moderation",
    });

    const notified = await context.service.reconcile();

    expect(notified?.generationNotice).toEqual({
      kind: "moderation-block",
      jobId: "blocked-refill",
      occurredAt: "2026-07-16T01:01:40.000Z",
      occurrenceCount: 1,
    });
    await expect(context.gameRepository.load()).resolves.toMatchObject({
      generationNotice: { jobId: "blocked-refill", occurrenceCount: 1 },
    });
    await expect(context.challengerRepository.load()).resolves.toMatchObject({
      refillJobs: [{ jobId: "replacement-refill" }],
    });
  });

  it("rejects mismatched refill work metadata and restores capacity", async () => {
    const game = gameState();
    const challengers = challengerState(game, {
      ready: [],
      ratings: [
        rating(game.round.leftCandidate),
        rating(game.round.rightCandidate),
      ],
    });
    const context = serviceFor({
      game,
      challengers,
      bufferTarget: 1,
      createId: ids("tampered-refill", "replacement-refill"),
    });
    await context.service.select("left", 3);
    const original = context.queue.enqueue.mock.calls[0][0];
    context.queue.setWork({ ...original, preferenceSeed: "tampered seed" });
    context.queue.setResult(completedResult("tampered-refill"));

    const waiting = await context.service.reconcile();

    expect(waiting?.round.status).toBe("generating");
    expect(context.assets.verify).not.toHaveBeenCalled();
    expect(context.queue.archive).toHaveBeenCalledWith("tampered-refill");
    await expect(context.challengerRepository.load()).resolves.toMatchObject({
      refillJobs: [{ jobId: "replacement-refill" }],
    });
  });

  it.each([
    ["round number", (job: GenerationJob) => ({ ...job, roundNumber: 99 })],
    [
      "winner side",
      (job: GenerationJob) => ({ ...job, winnerSide: "right" as const }),
    ],
    [
      "rejected candidate",
      (job: GenerationJob) => ({
        ...job,
        rejectedCandidate: candidate("tampered-rejected"),
      }),
    ],
    [
      "selection history",
      (job: GenerationJob) => ({ ...job, selectionHistory: [] }),
    ],
    [
      "recent concepts",
      (job: GenerationJob) => ({ ...job, recentConcepts: ["tampered"] }),
    ],
    [
      "preference seed",
      (job: GenerationJob) => ({ ...job, preferenceSeed: "tampered seed" }),
    ],
  ])("rejects tampered %s after service restart", async (_label, tamper) => {
    const game = gameState();
    const gameRepository = new MemoryGameRepository(game);
    const challengerRepository = new MemoryChallengerRepository(
      challengerState(game),
    );
    const queue = mailbox();
    const first = serviceFor({
      gameRepository,
      challengerRepository,
      queue,
      createId: ids("restart-tamper", "replacement-refill"),
    });
    await first.service.select("left", 3);
    const expected = queue.enqueue.mock.calls[0][0];
    queue.setWork(tamper(expected) as GenerationJob);
    queue.setResult(completedResult("restart-tamper"));
    const restartedAssets = verifier();
    const restarted = serviceFor({
      gameRepository,
      challengerRepository,
      queue,
      assets: restartedAssets,
      createId: ids("replacement-refill"),
    });

    await restarted.service.reconcile();

    expect(restartedAssets.verify).not.toHaveBeenCalled();
    expect(queue.archive).toHaveBeenCalledWith("restart-tamper");
    expect(
      (await challengerRepository.load())?.ratings.some(
        ({ candidate: item }) => item.id === "challenger-restart-tamper",
      ),
    ).toBe(false);
  });

  it("re-enqueues the exact persisted refill after restart when publication never happened", async () => {
    const game = gameState();
    const gameRepository = new MemoryGameRepository(game);
    const challengerRepository = new MemoryChallengerRepository(
      challengerState(game),
    );
    const queue = mailbox();
    queue.enqueue.mockRejectedValueOnce(new Error("mailbox unavailable"));
    const first = serviceFor({
      gameRepository,
      challengerRepository,
      queue,
      createId: ids("durable-refill"),
    });

    await expect(first.service.select("left", 3)).rejects.toThrow(
      "mailbox unavailable",
    );
    const expected = structuredClone(queue.enqueue.mock.calls[0][0]);
    queue.enqueue.mockClear();
    const restarted = serviceFor({
      gameRepository,
      challengerRepository,
      queue,
      createId: ids("must-not-replace"),
    });

    await restarted.service.reconcile();

    expect(queue.archive).not.toHaveBeenCalledWith("durable-refill");
    expect(queue.enqueue).toHaveBeenCalledWith(expected);
    expect(await queue.readWork("durable-refill")).toEqual(expected);
    expect((await challengerRepository.load())?.refillJobs).toMatchObject([
      { jobId: "durable-refill" },
    ]);
  });

  it("recovers a lost enqueue acknowledgement from durable refill intent", async () => {
    const game = gameState();
    const context = serviceFor({ game, challengers: challengerState(game) });
    context.queue.enqueue.mockImplementationOnce(async (job) => {
      context.queue.setWork(job);
      throw new Error("lost acknowledgement");
    });

    const selected = await context.service.select("left", 3);

    expect(selected.round.status).toBe("idle");
    expect(await context.queue.readWork("refill-1")).toEqual(
      context.queue.enqueue.mock.calls[0][0],
    );
    await expect(context.challengerRepository.load()).resolves.toMatchObject({
      refillJobs: [{ jobId: "refill-1" }],
    });
  });

  it("retries cleanup without appending or applying a completed refill twice", async () => {
    const game = gameState();
    const challengers = challengerState(game, {
      ready: [],
      ratings: [
        rating(game.round.leftCandidate),
        rating(game.round.rightCandidate),
      ],
    });
    const context = serviceFor({ game, challengers, bufferTarget: 1 });
    await context.service.select("left", 3);
    context.queue.setResult(completedResult("refill-1"));
    context.queue.archive.mockRejectedValueOnce(
      new Error("archive unavailable"),
    );

    await expect(context.service.reconcile()).rejects.toThrow(
      "archive unavailable",
    );
    const afterFailure = await context.challengerRepository.load();
    expect(
      afterFailure?.ratings.filter(
        ({ candidate: item }) => item.id === "challenger-refill-1",
      ),
    ).toHaveLength(1);
    const historyLength = (await context.gameRepository.load())?.history.length;
    expect(historyLength).toBeDefined();

    await expect(context.service.reconcile()).resolves.toMatchObject({
      round: { status: "idle" },
    });
    const afterRetry = await context.challengerRepository.load();
    expect(
      afterRetry?.ratings.filter(
        ({ candidate: item }) => item.id === "challenger-refill-1",
      ),
    ).toHaveLength(1);
    expect((await context.gameRepository.load())?.history).toHaveLength(
      historyLength!,
    );
  });

  it("replays a generated buffer candidate when saving the waiting round fails", async () => {
    const game = gameState();
    const backingGame = new MemoryGameRepository(game);
    let failCompletedSave = false;
    const gameRepository: GameRepository = {
      load: () => backingGame.load(),
      clear: () => backingGame.clear(),
      withLock: (operation) => backingGame.withLock(operation),
      save: async (state) => {
        if (failCompletedSave && state.round.status === "idle") {
          failCompletedSave = false;
          throw new Error("game disk unavailable");
        }
        await backingGame.save(state);
      },
    };
    const challengers = challengerState(game, {
      ready: [],
      ratings: [
        rating(game.round.leftCandidate),
        rating(game.round.rightCandidate),
      ],
      consecutiveFallbackDraws: 2,
    });
    const context = serviceFor({
      game,
      gameRepository,
      challengers,
      bufferTarget: 1,
    });
    await context.service.select("left", 3);
    failCompletedSave = true;
    context.queue.setResult(completedResult("refill-1"));

    await expect(context.service.reconcile()).rejects.toThrow(
      "game disk unavailable",
    );
    await expect(backingGame.load()).resolves.toMatchObject({
      round: { status: "generating" },
      pendingSelection: { kind: "buffer" },
    });
    await expect(context.challengerRepository.load()).resolves.toMatchObject({
      ready: [],
      preparedDequeues: [
        {
          candidate: { id: "challenger-refill-1" },
          replacementSlot: "single",
        },
      ],
      refillJobs: [{ jobId: "refill-1" }],
    });

    const recovered = await context.service.reconcile();

    expect(recovered?.round).toMatchObject({
      status: "idle",
      rightCandidate: { id: "challenger-refill-1" },
    });
    expect(recovered?.history).toHaveLength(game.history.length + 1);
    expect(context.queue.archive).toHaveBeenCalledWith("refill-1");
  });
});
