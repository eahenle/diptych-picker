import type { GameState } from "@/domain/game";
import {
  createPromptCardBlendRequest,
  createPromptCard,
  emptyPromptDeck,
  type CreatePromptCardInput,
} from "@/domain/prompt-deck";
import type {
  PromptCardBlenderMailbox,
  PromptCardBlenderJob,
  PromptCardWriterJob,
} from "./agent-mailbox";
import type { ChallengerRepository } from "./challenger-repository";
import { MissingGameError, PromptDeckError } from "./game-service-errors";
import type { PromptCardWriterCoordinator } from "./prompt-card-writer-service";
import type { GameRepository } from "./repository";

type PromptDeckUpdate =
  | { kind: "deck"; enabled: boolean }
  | { kind: "card"; cardId: string; active?: boolean; weight?: number }
  | {
      kind: "suggestion";
      suggestionId: string;
      action: "accept" | "discard";
    };

interface PromptDeckJobPublisher {
  ensureBlenderEnqueued(job: PromptCardBlenderJob): Promise<void>;
  ensureWriterEnqueued(job: PromptCardWriterJob): Promise<void>;
}

interface PromptDeckServiceOptions {
  gameRepository: GameRepository;
  challengerRepository: ChallengerRepository;
  jobPublisher: PromptDeckJobPublisher;
  blender?: PromptCardBlenderMailbox;
  writer?: PromptCardWriterCoordinator;
  createId: () => string;
  now: () => string;
}

export class PromptDeckService {
  constructor(private readonly options: PromptDeckServiceOptions) {}

  async create(input: CreatePromptCardInput): Promise<GameState> {
    return this.options.gameRepository.withLock(async () => {
      const current = await this.options.gameRepository.load();
      if (!current) {
        throw new MissingGameError("Start a game before creating prompt cards");
      }
      const promptDeck = current.promptDeck ?? emptyPromptDeck();
      if (promptDeck.cards.length >= 50) {
        throw new PromptDeckError(
          "Archive or reuse a prompt card before adding another (maximum 50).",
        );
      }
      if (
        input.parents?.some(
          (parentId) => !promptDeck.cards.some((card) => card.id === parentId),
        )
      ) {
        throw new PromptDeckError(
          "Every prompt-card parent must exist in the current deck.",
        );
      }
      const updated: GameState = {
        ...current,
        promptDeck: {
          ...promptDeck,
          cards: [
            ...promptDeck.cards,
            createPromptCard(
              input,
              this.options.createId(),
              this.options.now(),
            ),
          ],
        },
      };
      await this.options.gameRepository.save(updated);
      return updated;
    });
  }

  async requestBlend(
    cardIds: [string, string],
    ratio: number,
  ): Promise<GameState> {
    return this.options.gameRepository.withLock(async () => {
      const current = await this.options.gameRepository.load();
      if (!current) {
        throw new MissingGameError("Start a game before blending prompt cards");
      }
      if (!this.options.blender) {
        throw new PromptDeckError("Prompt-card blending is unavailable.");
      }
      const promptDeck = current.promptDeck ?? emptyPromptDeck();
      if (promptDeck.blendJob) {
        throw new PromptDeckError(
          "Wait for the current prompt-card blend before starting another.",
        );
      }
      if (new Set(cardIds).size !== 2) {
        throw new PromptDeckError("Choose two distinct prompt cards to blend.");
      }
      if (!Number.isFinite(ratio) || ratio < 0.1 || ratio > 0.9) {
        throw new PromptDeckError("Blend ratio must be between 10% and 90%.");
      }
      const cards = cardIds.map((cardId) =>
        promptDeck.cards.find((card) => card.id === cardId),
      );
      if (!cards[0] || !cards[1]) {
        throw new PromptDeckError(
          "Both prompt cards must exist in the current deck.",
        );
      }
      const jobId = this.options.createId();
      const createdAt = this.options.now();
      const job = createPromptCardBlendRequest(
        [cards[0], cards[1]],
        ratio,
        jobId,
        createdAt,
      );
      const updated: GameState = {
        ...current,
        promptDeck: {
          ...promptDeck,
          blendJob: {
            jobId,
            cardIds,
            enqueuedAt: createdAt,
            expectedJob: job,
          },
        },
      };
      await this.options.gameRepository.save(updated);
      await this.options.jobPublisher.ensureBlenderEnqueued(job);
      return updated;
    });
  }

  async requestWriter(candidateIds: string[]): Promise<GameState> {
    return this.withStateLocks(async () => {
      const [current, challengers] = await Promise.all([
        this.options.gameRepository.load(),
        this.options.challengerRepository.load(),
      ]);
      if (!current || !challengers) {
        throw new MissingGameError(
          "Start a game before writing prompt cards from images",
        );
      }
      const writer = this.options.writer;
      if (!writer) {
        throw new PromptDeckError("Prompt-card writing is unavailable.");
      }
      if (
        candidateIds.length < 3 ||
        candidateIds.length > 5 ||
        new Set(candidateIds).size !== candidateIds.length
      ) {
        throw new PromptDeckError(
          "Choose three to five distinct generated favorites.",
        );
      }
      const promptDeck = current.promptDeck ?? emptyPromptDeck();
      if (promptDeck.writerJob) {
        throw new PromptDeckError(
          "Wait for the current image-set draft before starting another.",
        );
      }
      const candidates = candidateIds.map((candidateId) =>
        challengers.ratings.find(
          (rating) => rating.candidate.id === candidateId,
        ),
      );
      if (
        candidates.some(
          (candidate) =>
            !candidate ||
            candidate.source !== "generated" ||
            !candidate.favorite,
        )
      ) {
        throw new PromptDeckError(
          "Prompt-card sources must be current generated favorites.",
        );
      }
      const jobId = this.options.createId();
      const createdAt = this.options.now();
      const job = await writer.prepare(
        jobId,
        createdAt,
        candidates as NonNullable<(typeof candidates)[number]>[],
      );
      const updated: GameState = {
        ...current,
        promptDeck: {
          ...promptDeck,
          writerJob: {
            jobId,
            sourceCandidateIds: [...candidateIds],
            enqueuedAt: createdAt,
            expectedJob: job,
          },
        },
      };
      await this.options.gameRepository.save(updated);
      await this.options.jobPublisher.ensureWriterEnqueued(job);
      return updated;
    });
  }

  async update(update: PromptDeckUpdate): Promise<GameState> {
    return this.options.gameRepository.withLock(async () => {
      const current = await this.options.gameRepository.load();
      if (!current) {
        throw new MissingGameError(
          "Start a game before editing the prompt deck",
        );
      }
      const promptDeck = current.promptDeck ?? emptyPromptDeck();
      if (update.kind === "suggestion") {
        const suggestion = (promptDeck.suggestions ?? []).find(
          (item) => item.id === update.suggestionId,
        );
        if (!suggestion) {
          throw new PromptDeckError("That prompt-card suggestion is gone.");
        }
        if (update.action === "accept" && promptDeck.cards.length >= 50) {
          throw new PromptDeckError(
            "Archive or reuse a prompt card before accepting another (maximum 50).",
          );
        }
        const updated: GameState = {
          ...current,
          promptDeck: {
            ...promptDeck,
            cards:
              update.action === "accept"
                ? [
                    ...promptDeck.cards,
                    createPromptCard(
                      {
                        title: suggestion.title,
                        prompt: suggestion.prompt,
                        negativePrompt: suggestion.negativePrompt,
                        weight: 1,
                        tags: suggestion.tags,
                        parents: suggestion.parentCardIds ?? [
                          ...(suggestion.parentCardId
                            ? [suggestion.parentCardId]
                            : []),
                        ],
                        sourceCandidateIds: suggestion.sourceCandidateIds,
                      },
                      this.options.createId(),
                      this.options.now(),
                    ),
                  ]
                : promptDeck.cards,
            suggestions: (promptDeck.suggestions ?? []).filter(
              (item) => item.id !== suggestion.id,
            ),
          },
        };
        await this.options.gameRepository.save(updated);
        return updated;
      }
      if (update.kind === "deck") {
        if (
          update.enabled &&
          !promptDeck.cards.some((card) => card.active && card.weight > 0)
        ) {
          throw new PromptDeckError(
            "Activate at least one prompt card before enabling weighted draws.",
          );
        }
        const updated = {
          ...current,
          promptDeck: { ...promptDeck, enabled: update.enabled },
        };
        await this.options.gameRepository.save(updated);
        return updated;
      }

      let found = false;
      const cards = promptDeck.cards.map((card) => {
        if (card.id !== update.cardId) return card;
        found = true;
        return {
          ...card,
          ...(update.active !== undefined ? { active: update.active } : {}),
          ...(update.weight !== undefined ? { weight: update.weight } : {}),
        };
      });
      if (!found) {
        throw new PromptDeckError("That prompt card no longer exists.");
      }
      const hasActive = cards.some((card) => card.active && card.weight > 0);
      const updated: GameState = {
        ...current,
        promptDeck: {
          ...promptDeck,
          enabled: promptDeck.enabled && hasActive,
          cards,
        },
      };
      await this.options.gameRepository.save(updated);
      return updated;
    });
  }

  private withStateLocks<T>(operation: () => Promise<T>): Promise<T> {
    return this.options.gameRepository.withLock(() =>
      this.options.challengerRepository.withLock(operation),
    );
  }
}
