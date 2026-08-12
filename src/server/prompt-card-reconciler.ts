import { isDeepStrictEqual } from "node:util";
import type { GameState } from "@/domain/game";
import { preparePromptCardEditorJob } from "@/domain/prompt-deck";
import type {
  PromptCardBlenderMailbox,
  PromptCardEditorMailbox,
} from "./agent-mailbox";
import type { PromptCardWriterCoordinator } from "./prompt-card-writer-service";
import type { GameRepository } from "./repository";

interface PromptCardReconcilerOptions {
  repository: GameRepository;
  editor?: PromptCardEditorMailbox;
  blender?: PromptCardBlenderMailbox;
  writer?: PromptCardWriterCoordinator;
  createId: () => string;
  now: () => string;
}

export class PromptCardReconciler {
  constructor(private readonly options: PromptCardReconcilerOptions) {}

  async reconcile(game: GameState): Promise<GameState> {
    let next = await this.reconcileEditor(game);
    next = await this.syncBlender(next);
    return this.syncWriter(next);
  }

  async reconcileEditor(game: GameState): Promise<GameState> {
    const mailbox = this.options.editor;
    if (!mailbox || !game.promptDeck) return game;
    let next = game;
    let deck = game.promptDeck;
    const record = deck.editorJob;
    if (record) {
      const [work, result] = await Promise.all([
        mailbox.readPromptCardEditorWork(record.jobId),
        mailbox.readPromptCardEditorResult(record.jobId),
      ]);
      if (!result) {
        if (!work) {
          await this.ensureEditorEnqueued(record.expectedJob);
        } else if (!isDeepStrictEqual(work, record.expectedJob)) {
          await mailbox.archivePromptCardEditor(record.jobId);
          deck = {
            ...deck,
            cards: deck.cards.map((card) =>
              card.id === record.cardId
                ? {
                    ...card,
                    editorRejectCheckpoint: record.previousRejectCheckpoint,
                  }
                : card,
            ),
            editorJob: null,
          };
          next = { ...next, promptDeck: deck };
          await this.options.repository.save(next);
        }
        return next;
      }

      const validCompleted =
        work &&
        isDeepStrictEqual(work, record.expectedJob) &&
        result.status === "completed" &&
        result.kind === "prompt-card-editor" &&
        result.cardId === record.cardId;
      const suggestions = validCompleted
        ? [
            ...(deck.suggestions ?? []),
            ...result.proposals.map((proposal) => ({
              id: this.options.createId(),
              parentCardId: record.cardId,
              ...proposal,
              createdAt: result.completedAt,
            })),
          ].slice(-10)
        : (deck.suggestions ?? []);
      await mailbox.archivePromptCardEditor(record.jobId);
      deck = {
        ...deck,
        editorJob: null,
        suggestions,
      };
      next = {
        ...next,
        promptDeck: deck,
      };
      await this.options.repository.save(next);
    }

    if (deck.editorJob) return next;
    const prepared = preparePromptCardEditorJob(
      deck,
      this.options.createId,
      this.options.now(),
    );
    if (!prepared) return next;
    next = { ...next, promptDeck: prepared.deck };
    await this.options.repository.save(next);
    await this.ensureEditorEnqueued(prepared.job);
    return next;
  }

  private async ensureEditorEnqueued(
    job: Parameters<PromptCardEditorMailbox["enqueuePromptCardEditor"]>[0],
  ): Promise<void> {
    const mailbox = this.options.editor;
    if (!mailbox) return;
    try {
      await mailbox.enqueuePromptCardEditor(job);
    } catch (error) {
      const work = await mailbox.readPromptCardEditorWork(job.id);
      if (work && isDeepStrictEqual(work, job)) return;
      throw error;
    }
  }

  private async syncBlender(game: GameState): Promise<GameState> {
    const mailbox = this.options.blender;
    const deck = game.promptDeck;
    const record = deck?.blendJob;
    if (!mailbox || !deck || !record) return game;

    const [work, result] = await Promise.all([
      mailbox.readPromptCardBlenderWork(record.jobId),
      mailbox.readPromptCardBlenderResult(record.jobId),
    ]);
    if (!result) {
      if (!work) {
        await this.ensureBlenderEnqueued(record.expectedJob);
      } else if (!isDeepStrictEqual(work, record.expectedJob)) {
        await mailbox.archivePromptCardBlender(record.jobId);
        const next = {
          ...game,
          promptDeck: { ...deck, blendJob: null },
        };
        await this.options.repository.save(next);
        return next;
      }
      return game;
    }

    const validCompleted =
      work &&
      isDeepStrictEqual(work, record.expectedJob) &&
      result.status === "completed" &&
      result.kind === "prompt-card-blender" &&
      isDeepStrictEqual(result.cardIds, record.cardIds);
    const suggestions = validCompleted
      ? [
          ...(deck.suggestions ?? []),
          {
            id: this.options.createId(),
            parentCardId: record.cardIds[0],
            parentCardIds: record.cardIds,
            ...result.proposal,
            createdAt: result.completedAt,
          },
        ].slice(-10)
      : (deck.suggestions ?? []);
    await mailbox.archivePromptCardBlender(record.jobId);
    const next = {
      ...game,
      promptDeck: {
        ...deck,
        blendJob: null,
        suggestions,
      },
    };
    await this.options.repository.save(next);
    return next;
  }

  async ensureBlenderEnqueued(
    job: Parameters<PromptCardBlenderMailbox["enqueuePromptCardBlender"]>[0],
  ): Promise<void> {
    const mailbox = this.options.blender;
    if (!mailbox) return;
    try {
      await mailbox.enqueuePromptCardBlender(job);
    } catch (error) {
      const work = await mailbox.readPromptCardBlenderWork(job.id);
      if (work && isDeepStrictEqual(work, job)) return;
      throw error;
    }
  }

  private async syncWriter(game: GameState): Promise<GameState> {
    const writer = this.options.writer;
    const deck = game.promptDeck;
    const record = deck?.writerJob;
    if (!writer || !deck || !record) return game;

    const [work, result] = await Promise.all([
      writer.readWork(record.jobId),
      writer.readResult(record.jobId),
    ]);
    if (!result) {
      if (!work) {
        await this.ensureWriterEnqueued(record.expectedJob);
      } else if (!isDeepStrictEqual(work, record.expectedJob)) {
        await writer.archive(record.jobId);
        const next = {
          ...game,
          promptDeck: { ...deck, writerJob: null },
        };
        await this.options.repository.save(next);
        return next;
      }
      return game;
    }

    const validCompleted =
      work &&
      isDeepStrictEqual(work, record.expectedJob) &&
      result.status === "completed" &&
      result.kind === "prompt-card-writer" &&
      isDeepStrictEqual(result.sourceCandidateIds, record.sourceCandidateIds) &&
      (record.sourceImageDigests === undefined
        ? result.sourceImageDigests === undefined ||
          isDeepStrictEqual(
            result.sourceImageDigests,
            writerImageDigests(record.expectedJob),
          )
        : isDeepStrictEqual(
            result.sourceImageDigests,
            record.sourceImageDigests,
          )) &&
      result.sourceTextDigest === record.sourceTextDigest;
    const suggestions = validCompleted
      ? [
          ...(deck.suggestions ?? []),
          {
            id: this.options.createId(),
            ...(record.sourceCandidateIds.length > 0
              ? { sourceCandidateIds: record.sourceCandidateIds }
              : {}),
            ...((result.sourceImageDigests ?? record.sourceImageDigests)?.length
              ? {
                  sourceImageDigests:
                    result.sourceImageDigests ?? record.sourceImageDigests,
                }
              : {}),
            ...(record.sourceTextDigest
              ? { sourceTextDigest: record.sourceTextDigest }
              : {}),
            ...result.proposal,
            createdAt: result.completedAt,
          },
        ].slice(-10)
      : (deck.suggestions ?? []);
    await writer.archive(record.jobId);
    const next = {
      ...game,
      promptDeck: {
        ...deck,
        writerJob: null,
        suggestions,
      },
    };
    await this.options.repository.save(next);
    return next;
  }

  async ensureWriterEnqueued(
    job: Parameters<PromptCardWriterCoordinator["enqueue"]>[0],
  ): Promise<void> {
    const writer = this.options.writer;
    if (!writer) return;
    try {
      await writer.enqueue(job);
    } catch (error) {
      const work = await writer.readWork(job.id);
      if (work && isDeepStrictEqual(work, job)) return;
      throw error;
    }
  }
}

function writerImageDigests(
  job: Parameters<PromptCardWriterCoordinator["enqueue"]>[0],
): string[] {
  return [
    ...new Set(
      job.sources.map(({ sourceImage }) => sourceImage.filename.slice(0, -4)),
    ),
  ];
}
