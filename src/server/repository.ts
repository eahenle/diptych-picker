import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { migrateGameState, type GameState } from "@/domain/game";
import { z } from "zod";
import {
  persistedPreferenceProfileSchema as preferenceProfileSchema,
  preferenceRevisionSchema,
} from "./preference-profile-schema";

export interface GameRepository {
  load(): Promise<GameState | null>;
  save(state: GameState): Promise<void>;
  clear(): Promise<void>;
  withLock<T>(operation: () => Promise<T>): Promise<T>;
}

interface RepositoryLockOptions {
  lockTimeoutMs?: number;
  staleLockMs?: number;
  retryDelayMs?: number;
}

interface LockOwner {
  pid: number;
  token: string;
  acquiredAt: string;
}

export class RepositoryLockTimeoutError extends Error {}

const candidateLineageSchema = z
  .object({
    kind: z.literal("variation"),
    parentCandidateId: z.string().trim().min(1),
    parentConcept: z.string().trim().min(1),
    preferenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const candidateSchema = z
  .object({
    id: z.string().trim().min(1),
    imageUrl: z.string().trim().min(1),
    prompt: z.string().trim().min(1),
    concept: z.string().trim().min(1),
    style: z.array(z.string().trim().min(1)),
    createdAt: z.string().trim().min(1),
    winCount: z.number().int().nonnegative(),
    reasoningSummary: z.string().optional(),
    preferenceRevision: preferenceRevisionSchema.optional(),
    promptCardId: z.string().trim().min(1).optional(),
    lineage: candidateLineageSchema.optional(),
  })
  .strict();

const pendingSelectionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("generation"),
      winnerSide: z.enum(["left", "right"]),
      selectedAt: z.string().trim().min(1),
      generationJobId: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("buffer"),
      winnerSide: z.enum(["left", "right"]),
      selectedAt: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("retirement"),
      winnerSide: z.enum(["left", "right"]),
      selectedAt: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tie"),
      referenceSide: z.enum(["left", "right"]),
      selectedAt: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("both-lose"),
      referenceSide: z.enum(["left", "right"]),
      selectedAt: z.string().trim().min(1),
    })
    .strict(),
]);

const selectionHistorySchema = z.union([
  z
    .object({
      outcome: z.literal("selection").optional(),
      winnerId: z.string().trim().min(1),
      loserId: z.string().trim().min(1),
      winnerPrompt: z.string().trim().min(1),
      loserPrompt: z.string().trim().min(1),
      winnerConcept: z.string().trim().min(1),
      loserConcept: z.string().trim().min(1),
      selectedAt: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      outcome: z.enum(["tie", "both-lose"]),
      leftId: z.string().trim().min(1),
      rightId: z.string().trim().min(1),
      leftPrompt: z.string().trim().min(1),
      rightPrompt: z.string().trim().min(1),
      leftConcept: z.string().trim().min(1),
      rightConcept: z.string().trim().min(1),
      selectedAt: z.string().trim().min(1),
    })
    .strict(),
]);

const gameStateSchema: z.ZodType<GameState> = z
  .object({
    round: z
      .object({
        leftCandidate: candidateSchema,
        rightCandidate: candidateSchema,
        status: z.enum(["idle", "generating", "error"]),
        replacingSide: z.enum(["left", "right"]).nullable(),
        roundNumber: z.number().int().positive(),
        retainedCandidateId: z.string().trim().min(1).nullable(),
        winStreak: z.number().int().nonnegative(),
      })
      .strict(),
    history: z.array(selectionHistorySchema),
    preferenceSeed: z.string().trim().min(1),
    preferenceProfile: preferenceProfileSchema.optional(),
    preferenceRevisions: z
      .array(
        z
          .object({
            createdAt: z.string().trim().min(1),
            source: z.enum(["initial", "manual", "variation", "adaptive"]),
            profile: preferenceProfileSchema,
            variationSource: z
              .object({
                candidateId: z.string().trim().min(1),
                concept: z.string().trim().min(1),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(25)
      .optional(),
    preferencePresets: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
            name: z.string().trim().min(1).max(50),
            createdAt: z.string().trim().min(1),
            updatedAt: z.string().trim().min(1),
            profile: preferenceProfileSchema,
          })
          .strict(),
      )
      .max(20)
      .optional(),
    promptDeck: z
      .object({
        enabled: z.boolean(),
        cards: z
          .array(
            z
              .object({
                id: z.string().trim().min(1),
                title: z.string().trim().min(1).max(80),
                prompt: z.string().trim().min(20).max(1_000),
                negativePrompt: z.string().max(500),
                weight: z.number().positive().max(100),
                tags: z.array(z.string().trim().min(1).max(40)).max(8),
                parents: z.array(z.string().trim().min(1)).max(5),
                sourceCandidateIds: z
                  .array(z.string().trim().min(1).max(200))
                  .min(3)
                  .max(5)
                  .optional(),
                active: z.boolean(),
                createdAt: z.string().trim().min(1),
                stats: z
                  .object({
                    wins: z.number().int().nonnegative(),
                    rejects: z.number().int().nonnegative(),
                  })
                  .strict(),
                editorRejectCheckpoint: z
                  .number()
                  .int()
                  .nonnegative()
                  .optional(),
              })
              .strict(),
          )
          .max(50),
        verdicts: z
          .array(
            z
              .object({
                cardId: z.string().trim().min(1),
                resultId: z.string().trim().min(1),
                verdict: z.enum(["win", "reject"]),
                reason: z.string().trim().min(1).max(240),
                recordedAt: z.string().trim().min(1),
              })
              .strict(),
          )
          .max(200),
        editorJob: z
          .object({
            jobId: z.string().trim().min(1),
            cardId: z.string().trim().min(1),
            enqueuedAt: z.string().trim().min(1),
            previousRejectCheckpoint: z.number().int().nonnegative(),
            expectedJob: z
              .object({
                id: z.string().trim().min(1),
                kind: z.literal("prompt-card-editor"),
                createdAt: z.string().trim().min(1),
                card: z
                  .object({
                    id: z.string().trim().min(1),
                    title: z.string().trim().min(1).max(80),
                    prompt: z.string().trim().min(20).max(1_000),
                    negativePrompt: z.string().max(500),
                    tags: z.array(z.string().trim().min(1).max(40)).max(8),
                  })
                  .strict(),
                recentRejections: z
                  .array(
                    z
                      .object({
                        resultId: z.string().trim().min(1),
                        reason: z.string().trim().min(1).max(240),
                        recordedAt: z.string().trim().min(1),
                      })
                      .strict(),
                  )
                  .min(4)
                  .max(12),
              })
              .strict(),
          })
          .strict()
          .nullable()
          .optional(),
        blendJob: z
          .object({
            jobId: z.string().trim().min(1),
            cardIds: z.tuple([
              z.string().trim().min(1),
              z.string().trim().min(1),
            ]),
            enqueuedAt: z.string().trim().min(1),
            expectedJob: z
              .object({
                id: z.string().trim().min(1),
                kind: z.literal("prompt-card-blender"),
                createdAt: z.string().trim().min(1),
                cards: z.tuple([
                  z
                    .object({
                      id: z.string().trim().min(1),
                      title: z.string().trim().min(1).max(80),
                      prompt: z.string().trim().min(20).max(1_000),
                      negativePrompt: z.string().max(500),
                      tags: z.array(z.string().trim().min(1).max(40)).max(8),
                    })
                    .strict(),
                  z
                    .object({
                      id: z.string().trim().min(1),
                      title: z.string().trim().min(1).max(80),
                      prompt: z.string().trim().min(20).max(1_000),
                      negativePrompt: z.string().max(500),
                      tags: z.array(z.string().trim().min(1).max(40)).max(8),
                    })
                    .strict(),
                ]),
                ratio: z.number().min(0.1).max(0.9),
              })
              .strict(),
          })
          .strict()
          .nullable()
          .optional(),
        writerJob: z
          .object({
            jobId: z.string().trim().min(1),
            sourceCandidateIds: z
              .array(z.string().trim().min(1).max(200))
              .min(3)
              .max(5),
            enqueuedAt: z.string().trim().min(1),
            expectedJob: z
              .object({
                id: z.string().trim().min(1),
                kind: z.literal("prompt-card-writer"),
                createdAt: z.string().trim().min(1),
                sources: z
                  .array(
                    z
                      .object({
                        candidateId: z.string().trim().min(1).max(200),
                        concept: z.string().trim().min(1).max(240),
                        style: z.array(z.string().trim().min(1).max(80)).max(4),
                        sourceImage: z
                          .object({
                            filename: z.string().regex(/^[a-f0-9]{64}\.png$/),
                            path: z
                              .string()
                              .regex(/^profile-sources\/[a-f0-9]{64}\.png$/),
                            contentType: z.literal("image/png"),
                            width: z.number().int().positive().max(4096),
                            height: z.number().int().positive().max(4096),
                            byteLength: z.number().int().positive(),
                          })
                          .strict(),
                      })
                      .strict(),
                  )
                  .min(3)
                  .max(5),
              })
              .strict(),
          })
          .strict()
          .nullable()
          .optional(),
        suggestions: z
          .array(
            z
              .object({
                id: z.string().trim().min(1),
                parentCardId: z.string().trim().min(1).optional(),
                parentCardIds: z
                  .array(z.string().trim().min(1))
                  .min(2)
                  .max(2)
                  .optional(),
                sourceCandidateIds: z
                  .array(z.string().trim().min(1).max(200))
                  .min(3)
                  .max(5)
                  .optional(),
                title: z.string().trim().min(1).max(80),
                prompt: z.string().trim().min(20).max(1_000),
                negativePrompt: z.string().max(500),
                tags: z.array(z.string().trim().min(1).max(40)).max(8),
                reasoningSummary: z.string().trim().min(1).max(1_000),
                createdAt: z.string().trim().min(1),
              })
              .strict(),
          )
          .max(10)
          .optional(),
      })
      .strict()
      .superRefine((deck, context) => {
        const ids = new Set<string>();
        for (const [index, card] of deck.cards.entries()) {
          if (ids.has(card.id)) {
            context.addIssue({
              code: "custom",
              path: ["cards", index, "id"],
              message: "Prompt card IDs must be unique",
            });
          }
          if (
            card.editorRejectCheckpoint !== undefined &&
            card.editorRejectCheckpoint > card.stats.rejects
          ) {
            context.addIssue({
              code: "custom",
              path: ["cards", index, "editorRejectCheckpoint"],
              message: "Prompt card editor checkpoint cannot exceed rejects",
            });
          }
          if (
            card.sourceCandidateIds &&
            new Set(card.sourceCandidateIds).size !==
              card.sourceCandidateIds.length
          ) {
            context.addIssue({
              code: "custom",
              path: ["cards", index, "sourceCandidateIds"],
              message: "Prompt card source candidates must be unique",
            });
          }
          ids.add(card.id);
        }
        for (const [index, card] of deck.cards.entries()) {
          if (card.parents.some((parentId) => !ids.has(parentId))) {
            context.addIssue({
              code: "custom",
              path: ["cards", index, "parents"],
              message: "Prompt card parents must exist in the deck",
            });
          }
        }
        for (const [index, verdict] of deck.verdicts.entries()) {
          if (!ids.has(verdict.cardId)) {
            context.addIssue({
              code: "custom",
              path: ["verdicts", index, "cardId"],
              message: "Prompt card verdicts must reference the deck",
            });
          }
        }
        if (
          deck.editorJob &&
          (!ids.has(deck.editorJob.cardId) ||
            deck.editorJob.expectedJob.card.id !== deck.editorJob.cardId ||
            deck.editorJob.expectedJob.id !== deck.editorJob.jobId)
        ) {
          context.addIssue({
            code: "custom",
            path: ["editorJob"],
            message: "Prompt card editor job must reference its deck card",
          });
        }
        if (
          deck.blendJob &&
          (new Set(deck.blendJob.cardIds).size !== 2 ||
            deck.blendJob.cardIds.some((cardId) => !ids.has(cardId)) ||
            deck.blendJob.expectedJob.id !== deck.blendJob.jobId ||
            !isDeepStrictEqual(
              deck.blendJob.expectedJob.cards.map(({ id }) => id),
              deck.blendJob.cardIds,
            ))
        ) {
          context.addIssue({
            code: "custom",
            path: ["blendJob"],
            message: "Prompt card blend job must reference two deck cards",
          });
        }
        if (
          deck.writerJob &&
          (deck.writerJob.expectedJob.id !== deck.writerJob.jobId ||
            !isDeepStrictEqual(
              deck.writerJob.expectedJob.sources.map(
                ({ candidateId }) => candidateId,
              ),
              deck.writerJob.sourceCandidateIds,
            ) ||
            new Set(deck.writerJob.sourceCandidateIds).size !==
              deck.writerJob.sourceCandidateIds.length ||
            deck.writerJob.expectedJob.sources.some(
              ({ sourceImage }) =>
                sourceImage.path !== `profile-sources/${sourceImage.filename}`,
            ))
        ) {
          context.addIssue({
            code: "custom",
            path: ["writerJob"],
            message:
              "Prompt card writer job must reference unique matching candidates",
          });
        }
        const suggestionIds = new Set<string>();
        for (const [index, suggestion] of (deck.suggestions ?? []).entries()) {
          if (suggestionIds.has(suggestion.id)) {
            context.addIssue({
              code: "custom",
              path: ["suggestions", index, "id"],
              message: "Prompt card suggestion IDs must be unique",
            });
          }
          suggestionIds.add(suggestion.id);
          const parentIds =
            suggestion.parentCardIds ??
            (suggestion.parentCardId ? [suggestion.parentCardId] : []);
          const sourceIds = suggestion.sourceCandidateIds ?? [];
          const invalidParentLineage =
            parentIds.length > 0 &&
            (!suggestion.parentCardId ||
              !ids.has(suggestion.parentCardId) ||
              parentIds.some((parentId) => !ids.has(parentId)) ||
              new Set(parentIds).size !== parentIds.length ||
              parentIds[0] !== suggestion.parentCardId);
          const invalidSourceLineage =
            sourceIds.length > 0 &&
            new Set(sourceIds).size !== sourceIds.length;
          if (
            invalidParentLineage ||
            invalidSourceLineage ||
            parentIds.length > 0 === sourceIds.length > 0
          ) {
            context.addIssue({
              code: "custom",
              path: ["suggestions", index],
              message:
                "Prompt card suggestions must reference either deck parents or source candidates",
            });
          }
        }
      })
      .optional(),
    variationSource: z
      .object({
        candidateId: z.string().trim().min(1),
        concept: z.string().trim().min(1),
      })
      .strict()
      .optional(),
    pendingSelection: pendingSelectionSchema.optional(),
    mailboxCleanupJobId: z.string().trim().min(1).optional(),
    errorMessage: z.string().trim().min(1).optional(),
    generationNotice: z
      .object({
        kind: z.literal("moderation-block"),
        jobId: z.string().trim().min(1),
        occurredAt: z.string().trim().min(1),
        occurrenceCount: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

export function parseGameState(value: unknown): GameState {
  return migrateGameState(gameStateSchema.parse(value));
}

export class JsonGameRepository implements GameRepository {
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly filePath: string,
    options: RepositoryLockOptions = {},
  ) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.staleLockMs = options.staleLockMs ?? 30_000;
    this.retryDelayMs = options.retryDelayMs ?? 10;
  }

  async load(): Promise<GameState | null> {
    try {
      const state = JSON.parse(
        await readFile(this.filePath, "utf8"),
      ) as GameState | null;
      return state ? migrateGameState(state) : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(state: GameState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, this.filePath);
  }

  async clear(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, "null\n", "utf8");
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const token = crypto.randomUUID();
    await this.acquireLock(token);
    try {
      return await operation();
    } finally {
      await this.releaseLock(token);
    }
  }

  private async acquireLock(token: string): Promise<void> {
    const lockDirectory = `${this.filePath}.lock`;
    const deadline = Date.now() + this.lockTimeoutMs;
    await mkdir(dirname(this.filePath), { recursive: true });

    while (true) {
      try {
        await mkdir(lockDirectory);
        const owner: LockOwner = {
          pid: process.pid,
          token,
          acquiredAt: new Date().toISOString(),
        };
        await writeFile(
          join(lockDirectory, "owner.json"),
          `${JSON.stringify(owner)}\n`,
          "utf8",
        );
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      if (await this.lockIsStale(lockDirectory)) {
        const staleDirectory = `${lockDirectory}.stale.${token}`;
        try {
          await rename(lockDirectory, staleDirectory);
          await rm(staleDirectory, { recursive: true, force: true });
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }

      if (Date.now() >= deadline) {
        throw new RepositoryLockTimeoutError(
          `Timed out waiting for repository lock ${lockDirectory}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
    }
  }

  private async releaseLock(token: string): Promise<void> {
    const lockDirectory = `${this.filePath}.lock`;
    try {
      const owner = JSON.parse(
        await readFile(join(lockDirectory, "owner.json"), "utf8"),
      ) as LockOwner;
      if (owner.token === token) {
        await rm(lockDirectory, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async lockIsStale(lockDirectory: string): Promise<boolean> {
    let acquiredAt: number;
    let pid: number | undefined;
    try {
      const owner = JSON.parse(
        await readFile(join(lockDirectory, "owner.json"), "utf8"),
      ) as Partial<LockOwner>;
      acquiredAt = Date.parse(owner.acquiredAt ?? "");
      pid = owner.pid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      try {
        acquiredAt = (await stat(lockDirectory)).mtimeMs;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT")
          return false;
        throw statError;
      }
    }

    if (!Number.isFinite(acquiredAt)) return false;
    if (Date.now() - acquiredAt < this.staleLockMs) return false;
    return pid === undefined || !this.processIsAlive(pid);
  }

  private processIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }
}

export class MemoryGameRepository implements GameRepository {
  private lockTail: Promise<void> = Promise.resolve();

  constructor(private state: GameState | null = null) {}

  async load(): Promise<GameState | null> {
    if (!this.state) return null;
    this.state = migrateGameState(this.state);
    return this.state;
  }

  async save(state: GameState): Promise<void> {
    this.state = state;
  }

  async clear(): Promise<void> {
    this.state = null;
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.lockTail;
    this.lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
