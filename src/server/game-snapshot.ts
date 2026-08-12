import { isDeepStrictEqual } from "node:util";
import type { Candidate, GameState } from "@/domain/game";
import type {
  CandidateRating,
  ChallengerState,
  PendingComparisonReceipt,
  PreparedCandidateDequeue,
} from "@/domain/challenger-state";
import {
  deriveActivationDisplayReceiptId,
  deriveDequeueOperationId,
  parseImportSession,
  type ImportedAssetMetadata,
  type ImportedCandidateAnnotation,
  type ImportSession,
} from "@/domain/import-session";
import { z } from "zod";
import type { GenerationMailbox } from "./agent-mailbox";
import {
  parseChallengerState,
  type ChallengerRepository,
} from "./challenger-repository";
import type { InitialBootstrapRepository } from "./initial-bootstrap";
import type { ImportSessionRepository } from "./import-session-repository";
import { parseGameState, type GameRepository } from "./repository";
import type { StateLockCoordinator } from "./state-lock-coordinator";

export const GAME_SNAPSHOT_FORMAT = "diptych-picker-game";
export const GAME_SNAPSHOT_VERSION = 2;
export const LEGACY_GAME_SNAPSHOT_VERSION = 1;
export const MAX_GAME_SNAPSHOT_BYTES = 25 * 1024 * 1024;

export interface GameSnapshot {
  format: typeof GAME_SNAPSHOT_FORMAT;
  version: typeof LEGACY_GAME_SNAPSHOT_VERSION | typeof GAME_SNAPSHOT_VERSION;
  exportedAt: string;
  game: GameState;
  challengers: ChallengerState;
  importSession?: SnapshotImportSession | null;
}

export interface SnapshotImportItem {
  id: string;
  normalizedDigest: string;
  status: "ready" | "removed" | "served";
  asset: ImportedAssetMetadata;
  annotation: ImportedCandidateAnnotation | null;
  candidateId: string | null;
  approvedAt: string;
  readyAt: string | null;
  servedAt: string | null;
}

export type SnapshotImportServedReceipt =
  | {
      kind: "activation-display";
      replacementSlot: "initial-left" | "initial-right";
      importItemId: string;
      candidate: Candidate;
      servedAt: string;
    }
  | {
      kind: "dequeue";
      originalReceipt: PendingComparisonReceipt;
      replacementSlot: "single" | "pair-left" | "pair-right";
      importItemId: string;
      candidate: Candidate;
      roundNumber: number;
      servedAt: string;
    };

export interface SnapshotImportSession {
  status: "active" | "completed";
  createdAt: string;
  sealedAt: string;
  activatedAt: string;
  items: SnapshotImportItem[];
  servedReceipts: SnapshotImportServedReceipt[];
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
  importSessionRepository?: ImportSessionRepository;
  verifyImportedAsset?: (asset: ImportedAssetMetadata) => Promise<void>;
  stateLockCoordinator?: StateLockCoordinator;
  now?: () => string;
  createId?: () => string;
}

const snapshotEnvelopeSchema = z
  .object({
    format: z.literal(GAME_SNAPSHOT_FORMAT),
    version: z.union([
      z.literal(LEGACY_GAME_SNAPSHOT_VERSION),
      z.literal(GAME_SNAPSHOT_VERSION),
    ]),
    exportedAt: z.string().datetime({ offset: true }),
    game: z.unknown(),
    challengers: z.unknown(),
    importSession: z.unknown().nullable().optional(),
  })
  .strict();

const timestampSchema = z.string().datetime({ offset: true });
const pendingComparisonReceiptSchema = z.union([
  z
    .object({
      kind: z.literal("selection").optional(),
      selectedAt: timestampSchema,
      roundNumber: z.number().int().positive(),
      winnerSide: z.enum(["left", "right"]),
      winnerId: z.string().trim().min(1),
      loserId: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.enum(["tie", "both-lose"]),
      selectedAt: timestampSchema,
      roundNumber: z.number().int().positive(),
      leftId: z.string().trim().min(1),
      rightId: z.string().trim().min(1),
    })
    .strict(),
]);
const snapshotImportSessionSchema = z
  .object({
    status: z.enum(["active", "completed"]),
    createdAt: timestampSchema,
    sealedAt: timestampSchema,
    activatedAt: timestampSchema,
    items: z.array(
      z
        .object({
          id: z.string().trim().min(1),
          normalizedDigest: z.string().regex(/^[a-f0-9]{64}$/),
          status: z.enum(["ready", "removed", "served"]),
          asset: z.unknown(),
          annotation: z.unknown().nullable(),
          candidateId: z.string().trim().min(1).nullable(),
          approvedAt: timestampSchema,
          readyAt: timestampSchema.nullable(),
          servedAt: timestampSchema.nullable(),
        })
        .strict(),
    ),
    servedReceipts: z.array(
      z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("activation-display"),
            replacementSlot: z.enum(["initial-left", "initial-right"]),
            importItemId: z.string().trim().min(1),
            candidate: z.unknown(),
            servedAt: timestampSchema,
          })
          .strict(),
        z
          .object({
            kind: z.literal("dequeue"),
            originalReceipt: pendingComparisonReceiptSchema,
            replacementSlot: z.enum(["single", "pair-left", "pair-right"]),
            importItemId: z.string().trim().min(1),
            candidate: z.unknown(),
            roundNumber: z.number().int().positive(),
            servedAt: timestampSchema,
          })
          .strict(),
      ]),
    ),
  })
  .strict();

function invalid(message: string): never {
  throw new InvalidGameSnapshotError(message);
}

function parseSnapshotImportSession(value: unknown): SnapshotImportSession {
  const parsed = snapshotImportSessionSchema.parse(value);
  const syntheticSessionId = "snapshot-import-session";
  const syntheticIntentId = "snapshot-activation-intent";
  const validated = parseImportSession({
    version: 1,
    id: syntheticSessionId,
    status: parsed.status,
    createdAt: parsed.createdAt,
    sealedAt: parsed.sealedAt,
    activatedAt: parsed.activatedAt,
    items: parsed.items.map((item) => ({
      ...item,
      asset: item.asset,
      annotationJob: null,
      annotation: item.annotation,
      failureMessage: null,
    })),
    initialFillJobs: [],
    initialFillRetry: null,
    servedReceipts: parsed.servedReceipts.map((receipt) => {
      const candidate = receipt.candidate as Candidate;
      if (receipt.kind === "activation-display") {
        return {
          ...receipt,
          activationDisplayReceiptId: deriveActivationDisplayReceiptId(
            syntheticIntentId,
            syntheticSessionId,
            receipt.replacementSlot,
          ),
          activationIntentId: syntheticIntentId,
          importSessionId: syntheticSessionId,
          candidateId: candidate.id,
          provenance: "imported" as const,
        };
      }
      return {
        ...receipt,
        dequeueOperationId: deriveDequeueOperationId(
          syntheticSessionId,
          "snapshot-challenger-session",
          receipt.originalReceipt,
          receipt.replacementSlot,
        ),
        importSessionId: syntheticSessionId,
        candidateId: candidate.id,
        provenance: "imported" as const,
      };
    }),
  });
  return {
    status: validated.status as "active" | "completed",
    createdAt: validated.createdAt,
    sealedAt: validated.sealedAt!,
    activatedAt: validated.activatedAt!,
    items: validated.items.map((item) => ({
      id: item.id,
      normalizedDigest: item.normalizedDigest,
      status: item.status as "ready" | "removed" | "served",
      asset: item.asset,
      annotation: item.annotation,
      candidateId: item.candidateId,
      approvedAt: item.approvedAt,
      readyAt: item.readyAt ?? null,
      servedAt: item.servedAt,
    })),
    servedReceipts: validated.servedReceipts.map((receipt) =>
      receipt.kind === "activation-display"
        ? {
            kind: receipt.kind,
            replacementSlot: receipt.replacementSlot,
            importItemId: receipt.importItemId,
            candidate: receipt.candidate,
            servedAt: receipt.servedAt,
          }
        : {
            kind: receipt.kind,
            originalReceipt: receipt.originalReceipt,
            replacementSlot: receipt.replacementSlot,
            importItemId: receipt.importItemId,
            candidate: receipt.candidate,
            roundNumber: receipt.roundNumber,
            servedAt: receipt.servedAt,
          },
    ),
  };
}

function snapshotImportSession(
  session: ImportSession,
  preparedDequeues: PreparedCandidateDequeue[],
): SnapshotImportSession {
  const rolledBackItemIds = new Set(
    preparedDequeues
      .filter(({ provenance }) => provenance === "imported")
      .map(({ importItemId }) => importItemId)
      .filter((id): id is string => Boolean(id)),
  );
  const items = session.items.map((item): SnapshotImportItem => {
    if (item.status === "annotating" || item.status === "failed") {
      throw new GameSnapshotUnavailableError(
        "Activated imported candidates are not fully resolved",
      );
    }
    const rollBack = rolledBackItemIds.has(item.id);
    return {
      id: item.id,
      normalizedDigest: item.normalizedDigest,
      status: rollBack ? "ready" : item.status,
      asset: item.asset,
      annotation: item.annotation,
      candidateId: item.candidateId,
      approvedAt: item.approvedAt,
      readyAt: item.readyAt ?? null,
      servedAt: rollBack ? null : item.servedAt,
    };
  });
  const servedReceipts = session.servedReceipts
    .filter((receipt) => {
      if (receipt.kind !== "dequeue") return true;
      return !preparedDequeues.some(
        (prepared) =>
          prepared.provenance === "imported" &&
          prepared.importItemId === receipt.importItemId &&
          prepared.replacementSlot === receipt.replacementSlot &&
          isDeepStrictEqual(prepared.originalReceipt, receipt.originalReceipt),
      );
    })
    .map((receipt): SnapshotImportServedReceipt =>
      receipt.kind === "activation-display"
        ? {
            kind: receipt.kind,
            replacementSlot: receipt.replacementSlot,
            importItemId: receipt.importItemId,
            candidate: receipt.candidate,
            servedAt: receipt.servedAt,
          }
        : {
            kind: receipt.kind,
            originalReceipt: receipt.originalReceipt,
            replacementSlot: receipt.replacementSlot,
            importItemId: receipt.importItemId,
            candidate: receipt.candidate,
            roundNumber: receipt.roundNumber,
            servedAt: receipt.servedAt,
          },
    );
  return {
    status: items.some(({ status }) => status === "ready")
      ? "active"
      : "completed",
    createdAt: session.createdAt,
    sealedAt: session.sealedAt!,
    activatedAt: session.activatedAt!,
    items,
    servedReceipts,
  };
}

function restoreImportSession(
  snapshot: SnapshotImportSession,
  importSessionId: string,
  activationIntentId: string,
  challengerSessionId: string,
): ImportSession {
  return parseImportSession({
    version: 1,
    id: importSessionId,
    status: snapshot.status,
    createdAt: snapshot.createdAt,
    sealedAt: snapshot.sealedAt,
    activatedAt: snapshot.activatedAt,
    items: snapshot.items.map((item) => ({
      ...item,
      annotationJob: null,
      failureMessage: null,
    })),
    initialFillJobs: [],
    initialFillRetry: null,
    servedReceipts: snapshot.servedReceipts.map((receipt) => {
      if (receipt.kind === "activation-display") {
        return {
          ...receipt,
          activationDisplayReceiptId: deriveActivationDisplayReceiptId(
            activationIntentId,
            importSessionId,
            receipt.replacementSlot,
          ),
          activationIntentId,
          importSessionId,
          candidateId: receipt.candidate.id,
          provenance: "imported" as const,
        };
      }
      return {
        ...receipt,
        dequeueOperationId: deriveDequeueOperationId(
          importSessionId,
          challengerSessionId,
          receipt.originalReceipt,
          receipt.replacementSlot,
        ),
        importSessionId,
        candidateId: receipt.candidate.id,
        provenance: "imported" as const,
      };
    }),
  });
}

function validateRestorableState(
  game: GameState,
  challengers: ChallengerState,
  importSession: SnapshotImportSession | null,
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
    (challengers.preparedDequeues?.length ?? 0) > 0 ||
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
      rating.source !== "curated" &&
      !(
        (rating.source === "generated" &&
          rating.candidate.imageUrl ===
            `/api/assets/${rating.candidate.id}.png`) ||
        /^\/api\/assets\/[a-f0-9]{64}\.png$/.test(rating.candidate.imageUrl)
      )
    ) {
      invalid(`Candidate ${rating.candidate.id} has a non-canonical asset URL`);
    }
    if (
      rating.source === "imported" &&
      (!importSession ||
        !rating.importItemId ||
        !importSession.items.some(
          (item) =>
            item.id === rating.importItemId &&
            item.candidateId === rating.candidate.id,
        ))
    ) {
      invalid(
        `Imported candidate ${rating.candidate.id} has no matching import item`,
      );
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

  for (const buffered of challengers.importQueue) {
    if (
      buffered.source !== "imported" ||
      !buffered.importItemId ||
      currentIds.has(buffered.candidate.id) ||
      readyIds.has(buffered.candidate.id)
    ) {
      invalid(`Imported queue candidate ${buffered.candidate.id} is invalid`);
    }
    readyIds.add(buffered.candidate.id);
    const item = importSession?.items.find(
      ({ id }) => id === buffered.importItemId,
    );
    if (
      !item ||
      item.status !== "ready" ||
      item.candidateId !== buffered.candidate.id ||
      item.asset.url !== buffered.candidate.imageUrl
    ) {
      invalid(
        `Imported queue candidate ${buffered.candidate.id} has no ready item`,
      );
    }
  }

  if (!importSession && challengers.importQueue.length > 0) {
    invalid("Imported challenger supply requires snapshot import state");
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
    if (
      envelope.version === LEGACY_GAME_SNAPSHOT_VERSION &&
      envelope.importSession !== undefined
    ) {
      invalid("Legacy saved games cannot contain imported session state");
    }
    const importSession = envelope.importSession
      ? parseSnapshotImportSession(envelope.importSession)
      : null;
    validateRestorableState(game, challengers, importSession);
    return {
      format: envelope.format,
      version: envelope.version,
      exportedAt: envelope.exportedAt,
      game,
      challengers,
      ...(envelope.version === GAME_SNAPSHOT_VERSION ? { importSession } : {}),
    };
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
    return this.withStateLocks(async () => {
      const [game, challengers, importSession] = await Promise.all([
        this.options.gameRepository.load(),
        this.options.challengerRepository.load(),
        this.options.importSessionRepository?.load() ?? Promise.resolve(null),
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
          importQueue: baseline.importQueue ?? challengers.importQueue,
          pendingComparison: null,
          preparedDequeues: [],
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
                    editorRejectCheckpoint: editorJob.previousRejectCheckpoint,
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

      if (stableGame.promptDeck?.writerJob) {
        stableGame = {
          ...stableGame,
          promptDeck: {
            ...stableGame.promptDeck,
            writerJob: null,
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
          preparedDequeues: [],
          pendingSelectionBaseline: null,
          nextFallbackAt: null,
        },
        importSession:
          importSession?.activatedAt &&
          (importSession.status === "active" ||
            importSession.status === "completed")
            ? snapshotImportSession(
                importSession,
                challengers.preparedDequeues ?? [],
              )
            : null,
      });
    });
  }

  async import(value: unknown): Promise<GameState> {
    const snapshot = parseGameSnapshot(value);
    try {
      for (const { candidate, source } of snapshot.challengers.ratings) {
        await this.options.verifyCandidateAsset(candidate, source);
      }
      if (snapshot.importSession && this.options.verifyImportedAsset) {
        for (const { asset } of snapshot.importSession.items) {
          await this.options.verifyImportedAsset(asset);
        }
      }
    } catch {
      throw new InvalidGameSnapshotError(
        "This save references image assets that are unavailable on this installation",
      );
    }

    return this.withStateLocks(async () => {
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
        ...(bootstrap?.jobs.map(({ id }) => this.options.mailbox.archive(id)) ??
          []),
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
        ...(currentGame?.promptDeck?.writerJob
          ? [
              this.options.mailbox.archive(
                currentGame.promptDeck.writerJob.jobId,
              ),
            ]
          : []),
      ]);
      await this.options.bootstrapRepository.clear();

      const challengerSessionId = this.createId();
      const restoredChallengers = parseChallengerState({
        ...snapshot.challengers,
        sessionId: challengerSessionId,
        refillJobs: [],
        pendingComparison: null,
        preparedDequeues: [],
        pendingSelectionBaseline: null,
        nextFallbackAt: null,
      });
      if (snapshot.importSession && this.options.importSessionRepository) {
        const importSessionId = this.createId();
        const restoreIntentId = this.createId();
        await this.options.importSessionRepository.save(
          restoreImportSession(
            snapshot.importSession,
            importSessionId,
            restoreIntentId,
            challengerSessionId,
          ),
        );
      }
      await this.options.challengerRepository.save(restoredChallengers);
      await this.options.gameRepository.save(snapshot.game);
      return snapshot.game;
    });
  }

  private withStateLocks<T>(operation: () => Promise<T>): Promise<T> {
    if (this.options.stateLockCoordinator) {
      return this.options.stateLockCoordinator.withStateLocks(
        [
          "activation-intent",
          "import-session",
          "game",
          "challenger",
          "initial-bootstrap",
        ],
        operation,
      );
    }
    return this.options.gameRepository.withLock(() =>
      this.options.challengerRepository.withLock(operation),
    );
  }
}
