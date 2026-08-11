import { describe, expect, it, vi } from "vitest";
import type { GameState, PromptCard } from "@/domain/game";
import type {
  PromptCardBlenderJob,
  PromptCardBlenderMailbox,
  PromptCardBlenderResult,
  PromptCardEditorJob,
  PromptCardEditorMailbox,
  PromptCardEditorResult,
  PromptCardWriterJob,
  PromptCardWriterResult,
} from "./agent-mailbox";
import { PromptCardReconciler } from "./prompt-card-reconciler";
import type { PromptCardWriterCoordinator } from "./prompt-card-writer-service";
import { MemoryGameRepository } from "./repository";

const NOW = "2026-07-24T12:00:00.000Z";

function card(id: string, overrides: Partial<PromptCard> = {}): PromptCard {
  return {
    id,
    title: `${id} title`,
    prompt: `${id} carries a complete, coherent creative direction.`,
    negativePrompt: "readable text",
    weight: 1,
    tags: [id],
    parents: [],
    active: true,
    createdAt: NOW,
    stats: { wins: 0, rejects: 0 },
    ...overrides,
  };
}

function gameState(
  promptDeck: NonNullable<GameState["promptDeck"]>,
): GameState {
  const candidate = (id: string) => ({
    id,
    imageUrl: `/api/assets/${id}.png`,
    prompt: `${id} prompt`,
    concept: `${id} concept`,
    style: ["editorial"],
    createdAt: NOW,
    winCount: 0,
  });
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
    preferenceSeed: "A complete preference seed for reconciler tests.",
    promptDeck,
  };
}

function fixture() {
  const first = card("card-1", {
    stats: { wins: 0, rejects: 4 },
    editorRejectCheckpoint: 4,
  });
  const second = card("card-2");
  const recentRejections = Array.from({ length: 4 }, (_, index) => ({
    resultId: `reject-${index + 1}`,
    reason: "Selected comparison winner",
    recordedAt: NOW,
  }));
  const editorJob: PromptCardEditorJob = {
    id: "editor-job",
    kind: "prompt-card-editor",
    createdAt: NOW,
    card: {
      id: first.id,
      title: first.title,
      prompt: first.prompt,
      negativePrompt: first.negativePrompt,
      tags: first.tags,
    },
    recentRejections,
  };
  const blenderJob: PromptCardBlenderJob = {
    id: "blender-job",
    kind: "prompt-card-blender",
    createdAt: NOW,
    cards: [first, second].map(
      ({ id, title, prompt, negativePrompt, tags }) => ({
        id,
        title,
        prompt,
        negativePrompt,
        tags,
      }),
    ) as PromptCardBlenderJob["cards"],
    ratio: 0.5,
  };
  const writerJob: PromptCardWriterJob = {
    id: "writer-job",
    kind: "prompt-card-writer",
    createdAt: NOW,
    sources: ["favorite-1", "favorite-2", "favorite-3"].map(
      (candidateId, index) => {
        const filename = `${String(index + 1).repeat(64)}.png`;
        return {
          candidateId,
          concept: `${candidateId} concept`,
          style: ["editorial"],
          sourceImage: {
            filename,
            path: `profile-sources/${filename}`,
            contentType: "image/png" as const,
            width: 1024,
            height: 1024,
            byteLength: 4096,
          },
        };
      },
    ),
  };
  const game = gameState({
    enabled: true,
    cards: [first, second],
    verdicts: recentRejections.map((evidence) => ({
      cardId: first.id,
      verdict: "reject" as const,
      ...evidence,
    })),
    editorJob: {
      jobId: editorJob.id,
      cardId: first.id,
      enqueuedAt: NOW,
      previousRejectCheckpoint: 0,
      expectedJob: editorJob,
    },
    blendJob: {
      jobId: blenderJob.id,
      cardIds: [first.id, second.id],
      enqueuedAt: NOW,
      expectedJob: blenderJob,
    },
    writerJob: {
      jobId: writerJob.id,
      sourceCandidateIds: writerJob.sources.flatMap(({ candidateId }) =>
        candidateId ? [candidateId] : [],
      ),
      enqueuedAt: NOW,
      expectedJob: writerJob,
    },
    suggestions: [],
  });
  return { game, editorJob, blenderJob, writerJob };
}

function mailboxes(options: {
  editorWork?: PromptCardEditorJob | null;
  editorResult?: PromptCardEditorResult | null;
  blenderWork?: PromptCardBlenderJob | null;
  blenderResult?: PromptCardBlenderResult | null;
  writerWork?: PromptCardWriterJob | null;
  writerResult?: PromptCardWriterResult | null;
}) {
  const enqueueEditor = vi.fn(async () => undefined);
  const archiveEditor = vi.fn(async () => undefined);
  const editor: PromptCardEditorMailbox = {
    enqueuePromptCardEditor: enqueueEditor,
    readPromptCardEditorWork: async () => options.editorWork ?? null,
    readPromptCardEditorResult: async () => options.editorResult ?? null,
    archivePromptCardEditor: archiveEditor,
  };
  const enqueueBlender = vi.fn(async () => undefined);
  const archiveBlender = vi.fn(async () => undefined);
  const blender: PromptCardBlenderMailbox = {
    enqueuePromptCardBlender: enqueueBlender,
    readPromptCardBlenderWork: async () => options.blenderWork ?? null,
    readPromptCardBlenderResult: async () => options.blenderResult ?? null,
    archivePromptCardBlender: archiveBlender,
  };
  const enqueueWriter = vi.fn(async () => undefined);
  const archiveWriter = vi.fn(async () => undefined);
  const writer: PromptCardWriterCoordinator = {
    prepare: vi.fn(async () => {
      throw new Error("Writer preparation is outside reconciliation");
    }),
    prepareCustom: vi.fn(async () => {
      throw new Error("Writer preparation is outside reconciliation");
    }),
    enqueue: enqueueWriter,
    readWork: async () => options.writerWork ?? null,
    readResult: async () => options.writerResult ?? null,
    archive: archiveWriter,
  };
  return {
    editor,
    blender,
    writer,
    enqueueEditor,
    enqueueBlender,
    enqueueWriter,
    archiveEditor,
    archiveBlender,
    archiveWriter,
  };
}

function createIds(...ids: string[]) {
  let index = 0;
  return () => ids[index++] ?? `id-${index}`;
}

describe("PromptCardReconciler", () => {
  it("reconciles editor, blender, and writer completions in stable order", async () => {
    const { game, editorJob, blenderJob, writerJob } = fixture();
    const queues = mailboxes({
      editorWork: editorJob,
      editorResult: {
        jobId: editorJob.id,
        kind: "prompt-card-editor",
        status: "completed",
        completedAt: NOW,
        cardId: "card-1",
        proposals: [
          {
            title: "Editor one",
            prompt: "A focused editorial treatment with restrained detail.",
            negativePrompt: "readable text",
            tags: ["focused"],
            reasoningSummary: "Responds to repeated rejection evidence.",
          },
          {
            title: "Editor two",
            prompt:
              "An oblique editorial treatment with generous negative space.",
            negativePrompt: "readable text",
            tags: ["oblique"],
            reasoningSummary:
              "Offers a distinct response to the same evidence.",
          },
        ],
      },
      blenderWork: blenderJob,
      blenderResult: {
        jobId: blenderJob.id,
        kind: "prompt-card-blender",
        status: "completed",
        completedAt: NOW,
        cardIds: ["card-1", "card-2"],
        proposal: {
          title: "Blended card",
          prompt: "A coherent blend of both immutable source directions.",
          negativePrompt: "readable text",
          tags: ["blend"],
          reasoningSummary: "Balances both cards at the requested ratio.",
        },
      },
      writerWork: writerJob,
      writerResult: {
        jobId: writerJob.id,
        kind: "prompt-card-writer",
        status: "completed",
        completedAt: NOW,
        sourceCandidateIds: ["favorite-1", "favorite-2", "favorite-3"],
        proposal: {
          title: "Written card",
          prompt: "A transferable synthesis of all three immutable favorites.",
          negativePrompt: "exact copies, readable text",
          tags: ["written"],
          reasoningSummary: "Uses only qualities shared across the source set.",
        },
      },
    });
    const repository = new MemoryGameRepository(game);
    const save = vi.spyOn(repository, "save");
    const reconciler = new PromptCardReconciler({
      repository,
      editor: queues.editor,
      blender: queues.blender,
      writer: queues.writer,
      createId: createIds(
        "editor-suggestion-1",
        "editor-suggestion-2",
        "blend-suggestion",
        "writer-suggestion",
      ),
      now: () => NOW,
    });

    const result = await reconciler.reconcile(game);

    expect(result.promptDeck).toMatchObject({
      editorJob: null,
      blendJob: null,
      writerJob: null,
    });
    expect(result.promptDeck?.suggestions?.map(({ id }) => id)).toEqual([
      "editor-suggestion-1",
      "editor-suggestion-2",
      "blend-suggestion",
      "writer-suggestion",
    ]);
    expect(result.promptDeck?.suggestions?.[2]).toMatchObject({
      parentCardIds: ["card-1", "card-2"],
    });
    expect(result.promptDeck?.suggestions?.[3]).toMatchObject({
      sourceCandidateIds: ["favorite-1", "favorite-2", "favorite-3"],
    });
    expect(save).toHaveBeenCalledTimes(3);
    expect(queues.archiveEditor).toHaveBeenCalledWith(editorJob.id);
    expect(queues.archiveBlender).toHaveBeenCalledWith(blenderJob.id);
    expect(queues.archiveWriter).toHaveBeenCalledWith(writerJob.id);
  });

  it("reconciles text-only writer output with exact digest lineage", async () => {
    const sourceTextDigest =
      "754548edd47f62ef35b5aece43e6394f34ec4cba060743b9f37d80abe0f78ed5";
    const writerJob: PromptCardWriterJob = {
      id: "text-writer",
      kind: "prompt-card-writer",
      createdAt: NOW,
      sources: [],
      guidance: "A quiet ultraviolet architectural nocturne.",
      sourceTextDigest,
    };
    const game = gameState({
      enabled: false,
      cards: [],
      verdicts: [],
      writerJob: {
        jobId: writerJob.id,
        sourceCandidateIds: [],
        sourceImageDigests: [],
        sourceTextDigest,
        enqueuedAt: NOW,
        expectedJob: writerJob,
      },
      suggestions: [],
    });
    const queues = mailboxes({
      writerWork: writerJob,
      writerResult: {
        jobId: writerJob.id,
        kind: "prompt-card-writer",
        status: "completed",
        completedAt: NOW,
        sourceCandidateIds: [],
        sourceImageDigests: [],
        sourceTextDigest,
        proposal: {
          title: "Guided nocturne",
          prompt:
            "A quiet ultraviolet architectural nocturne with negative space.",
          negativePrompt: "readable text",
          tags: ["ultraviolet"],
          reasoningSummary: "Translates the exact supplied guidance.",
        },
      },
    });
    const repository = new MemoryGameRepository(game);
    const reconciler = new PromptCardReconciler({
      repository,
      writer: queues.writer,
      createId: () => "text-suggestion",
      now: () => NOW,
    });

    const result = await reconciler.reconcile(game);

    expect(result.promptDeck?.writerJob).toBeNull();
    expect(result.promptDeck?.suggestions?.[0]).toMatchObject({
      id: "text-suggestion",
      sourceTextDigest,
      title: "Guided nocturne",
    });
    expect(result.promptDeck?.suggestions?.[0]).not.toHaveProperty(
      "sourceCandidateIds",
    );
    expect(result.promptDeck?.suggestions?.[0]).not.toHaveProperty(
      "sourceImageDigests",
    );
  });

  it("re-enqueues every missing durable job without rewriting game state", async () => {
    const { game, editorJob, blenderJob, writerJob } = fixture();
    const queues = mailboxes({});
    const repository = new MemoryGameRepository(game);
    const save = vi.spyOn(repository, "save");
    const reconciler = new PromptCardReconciler({
      repository,
      editor: queues.editor,
      blender: queues.blender,
      writer: queues.writer,
      createId: createIds(),
      now: () => NOW,
    });

    const result = await reconciler.reconcile(game);

    expect(result).toBe(game);
    expect(queues.enqueueEditor).toHaveBeenCalledWith(editorJob);
    expect(queues.enqueueBlender).toHaveBeenCalledWith(blenderJob);
    expect(queues.enqueueWriter).toHaveBeenCalledWith(writerJob);
    expect(save).not.toHaveBeenCalled();
  });

  it("clears only mismatched work and restores the editor checkpoint", async () => {
    const { game, editorJob, blenderJob, writerJob } = fixture();
    const queues = mailboxes({
      editorWork: {
        ...editorJob,
        card: { ...editorJob.card, title: "Tampered" },
      },
      blenderWork: blenderJob,
      writerWork: {
        ...writerJob,
        sources: writerJob.sources.slice().reverse(),
      },
    });
    const repository = new MemoryGameRepository(game);
    const reconciler = new PromptCardReconciler({
      repository,
      editor: queues.editor,
      blender: queues.blender,
      writer: queues.writer,
      createId: createIds(),
      now: () => NOW,
    });

    const result = await reconciler.reconcile(game);

    expect(result.promptDeck?.editorJob).toBeNull();
    expect(result.promptDeck?.cards[0].editorRejectCheckpoint).toBe(0);
    expect(result.promptDeck?.blendJob?.jobId).toBe(blenderJob.id);
    expect(result.promptDeck?.writerJob).toBeNull();
    expect(result.promptDeck?.suggestions).toEqual([]);
    expect(queues.archiveEditor).toHaveBeenCalledWith(editorJob.id);
    expect(queues.archiveBlender).not.toHaveBeenCalled();
    expect(queues.archiveWriter).toHaveBeenCalledWith(writerJob.id);
  });
});
