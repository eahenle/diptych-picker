import { isDeepStrictEqual } from "node:util";
import type { Candidate, GameState } from "@/domain/game";
import type {
  CandidateRating,
  ChallengerState,
} from "@/domain/challenger-state";
import { z } from "zod";
import type { GenerationMailbox } from "./agent-mailbox";
import {
  parseChallengerState,
  type ChallengerRepository,
} from "./challenger-repository";
import type { InitialBootstrapRepository } from "./initial-bootstrap";
import { parseGameState, type GameRepository } from "./repository";

export const GAME_SNAPSHOT_FORMAT = "diptych-picker-game";
export const GAME_SNAPSHOT_VERSION = 1;
export const MAX_GAME_SNAPSHOT_BYTES = 25 * 1024 * 1024;

export interface GameSnapshot {
  format: typeof GAME_SNAPSHOT_FORMAT;
  version: typeof GAME_SNAPSHOT_VERSION;
  exportedAt: string;
  game: GameState;
  challengers: ChallengerState;
}

export class GameSnapshotUnavailableError extends Error {}
export class InvalidGameSnapshotError extends Error {}

interface GameSnapshotServiceOptions {
  gameRepository: GameRepository;
  challengerRepository: ChallengerRepository;
  bootstrapRepository: InitialBootstrapRepository;
  mailbox: Pick<GenerationMailbox, "archive">;
  verifyCandidateAsset: (
    candidate: Candidate,
    source: CandidateRating["source"],
  ) => Promise<void>;
  now?: () => string;
  createId?: () => string;
}

const snapshotEnvelopeSchema = z
  .object({
    format: z.literal(GAME_SNAPSHOT_FORMAT),
    version: z.literal(GAME_SNAPSHOT_VERSION),
    exportedAt: z.string().datetime({ offset: true }),
    game: z.unknown(),
    challengers: z.unknown(),
  })
  .strict();

function invalid(message: string): never {
  throw new InvalidGameSnapshotError(message);
}

function validateRestorableState(
  game: GameState,
  challengers: ChallengerState,
): void {
  if (
    game.round.status !== "idle" ||
    game.round.replacingSide !== null ||
    game.pendingSelection ||
    game.mailboxCleanupJobId ||
    game.errorMessage
  ) {
    invalid("Saved games must contain a completed, idle comparison");
  }
  if (
    challengers.refillJobs.length > 0 ||
    challengers.pendingComparison !== null ||
    challengers.pendingSelectionBaseline ||
    challengers.nextFallbackAt !== null
  ) {
    invalid("Saved games cannot contain in-flight generation work");
  }

  const displayed = [
    game.round.leftCandidate,
    game.round.rightCandidate,
  ] as const;
  if (displayed[0].id === displayed[1].id) {
    invalid("The displayed candidates must be distinct");
  }

  const ratings = new Map<string, CandidateRating>();
  for (const rating of challengers.ratings) {
    if (ratings.has(rating.candidate.id)) {
      invalid(`Candidate ${rating.candidate.id} has duplicate rating records`);
    }
    ratings.set(rating.candidate.id, rating);
    const expectedPrefix =
      rating.source === "curated" ? "/seed-assets/" : "/api/assets/";
    if (!rating.candidate.imageUrl.startsWith(expectedPrefix)) {
      invalid(
        `Candidate ${rating.candidate.id} has an invalid ${rating.source} asset URL`,
      );
    }
    if (
      rating.source === "generated" &&
      !(
        rating.candidate.imageUrl ===
          `/api/assets/${rating.candidate.id}.png` ||
        /^\/api\/assets\/[a-f0-9]{64}\.png$/.test(rating.candidate.imageUrl)
      )
    ) {
      invalid(`Candidate ${rating.candidate.id} has a non-canonical asset URL`);
    }
  }

  const currentIds = new Set(displayed.map(({ id }) => id));
  const readyIds = new Set<string>();
  for (const buffered of challengers.ready) {
    if (currentIds.has(buffered.candidate.id)) {
      invalid(`Displayed candidate ${buffered.candidate.id} is also buffered`);
    }
    if (readyIds.has(buffered.candidate.id)) {
      invalid(`Candidate ${buffered.candidate.id} is buffered more than once`);
    }
    readyIds.add(buffered.candidate.id);
    const rating = ratings.get(buffered.candidate.id);
    if (!rating || !isDeepStrictEqual(rating.candidate, buffered.candidate)) {
      invalid(
        `Buffered candidate ${buffered.candidate.id} has no matching rating`,
      );
    }
    const expectedSource = rating.source === "curated" ? "seed" : "generated";
    if (buffered.source !== expectedSource) {
      invalid(
        `Buffered candidate ${buffered.candidate.id} has a source mismatch`,
      );
    }
  }

  for (const candidate of displayed) {
    const rating = ratings.get(candidate.id);
    if (!rating || !isDeepStrictEqual(rating.candidate, candidate)) {
      invalid(`Displayed candidate ${candidate.id} has no matching rating`);
    }
  }
}

export function parseGameSnapshot(value: unknown): GameSnapshot {
  try {
    const envelope = snapshotEnvelopeSchema.parse(value);
    const game = parseGameState(envelope.game);
    const challengers = parseChallengerState(envelope.challengers);
    validateRestorableState(game, challengers);
    return { ...envelope, game, challengers };
  } catch (error) {
    if (error instanceof InvalidGameSnapshotError) throw error;
    throw new InvalidGameSnapshotError(
      "The selected file is not a valid game save",
    );
  }
}

export class GameSnapshotService {
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(private readonly options: GameSnapshotServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  async export(): Promise<GameSnapshot> {
    return this.options.gameRepository.withLock(async () =>
      this.options.challengerRepository.withLock(async () => {
        const [game, challengers] = await Promise.all([
          this.options.gameRepository.load(),
          this.options.challengerRepository.load(),
        ]);
        if (!game || !challengers) {
          throw new GameSnapshotUnavailableError(
            "Start a game before exporting it",
          );
        }
        let stableGame = game;
        let stableChallengers = challengers;
        if (game.round.status !== "idle") {
          const baseline = challengers.pendingSelectionBaseline;
          if (
            game.round.status !== "generating" ||
            (game.pendingSelection?.kind !== "buffer" &&
              game.pendingSelection?.kind !== "retirement") ||
            !baseline
          ) {
            throw new GameSnapshotUnavailableError(
              "The last stable comparison is not available for export",
            );
          }
          stableGame = {
            ...game,
            round: {
              ...game.round,
              status: "idle",
              replacingSide: null,
            },
          };
          delete stableGame.pendingSelection;
          delete stableGame.errorMessage;
          delete stableGame.mailboxCleanupJobId;
          stableChallengers = {
            ...challengers,
            ...baseline,
            pendingComparison: null,
            pendingSelectionBaseline: null,
          };
        }

        const editorJob = stableGame.promptDeck?.editorJob;
        if (editorJob && stableGame.promptDeck) {
          stableGame = {
            ...stableGame,
            promptDeck: {
              ...stableGame.promptDeck,
              cards: stableGame.promptDeck.cards.map((card) =>
                card.id === editorJob.cardId
                  ? {
                      ...card,
                      editorRejectCheckpoint:
                        editorJob.previousRejectCheckpoint,
                    }
                  : card,
              ),
              editorJob: null,
            },
          };
        }

        if (stableGame.promptDeck?.blendJob) {
          stableGame = {
            ...stableGame,
            promptDeck: {
              ...stableGame.promptDeck,
              blendJob: null,
            },
          };
        }

        return parseGameSnapshot({
          format: GAME_SNAPSHOT_FORMAT,
          version: GAME_SNAPSHOT_VERSION,
          exportedAt: this.now(),
          game: stableGame,
          challengers: {
            ...stableChallengers,
            refillJobs: [],
            pendingComparison: null,
            pendingSelectionBaseline: null,
            nextFallbackAt: null,
          },
        });
      }),
    );
  }

  async import(value: unknown): Promise<GameState> {
    const snapshot = parseGameSnapshot(value);
    try {
      for (const { candidate, source } of snapshot.challengers.ratings) {
        await this.options.verifyCandidateAsset(candidate, source);
      }
    } catch {
      throw new InvalidGameSnapshotError(
        "This save references image assets that are unavailable on this installation",
      );
    }

    return this.options.gameRepository.withLock(async () =>
      this.options.challengerRepository.withLock(async () => {
        const [currentGame, currentChallengers, bootstrap] = await Promise.all([
          this.options.gameRepository.load(),
          this.options.challengerRepository.load(),
          this.options.bootstrapRepository.load(),
        ]);
        if (currentGame?.round.status === "generating") {
          throw new GameSnapshotUnavailableError(
            "Wait for the current comparison to finish before loading a save",
          );
        }

        await Promise.all([
          ...(currentChallengers?.refillJobs.map(({ jobId }) =>
            this.options.mailbox.archive(jobId),
          ) ?? []),
          ...(bootstrap?.jobs.map(({ id }) =>
            this.options.mailbox.archive(id),
          ) ?? []),
          ...(currentGame?.promptDeck?.editorJob
            ? [
                this.options.mailbox.archive(
                  currentGame.promptDeck.editorJob.jobId,
                ),
              ]
            : []),
          ...(currentGame?.promptDeck?.blendJob
            ? [
                this.options.mailbox.archive(
                  currentGame.promptDeck.blendJob.jobId,
                ),
              ]
            : []),
        ]);
        await this.options.bootstrapRepository.clear();

        const restoredChallengers = parseChallengerState({
          ...snapshot.challengers,
          sessionId: this.createId(),
          refillJobs: [],
          pendingComparison: null,
          pendingSelectionBaseline: null,
          nextFallbackAt: null,
        });
        await this.options.challengerRepository.save(restoredChallengers);
        await this.options.gameRepository.save(snapshot.game);
        return snapshot.game;
      }),
    );
  }
}
