import { isDeepStrictEqual } from "node:util";
import type { ChallengerState } from "@/domain/challenger-state";
import {
  preferenceProfileFromSeed,
  type Candidate,
  type GameRules,
  type GameStartState,
  type GameState,
} from "@/domain/game";
import {
  deriveActivationDisplayReceiptId,
  type ImportItem,
  type ImportSession,
} from "@/domain/import-session";
import type { ChallengerRepository } from "./challenger-repository";
import { summarizeImportSupply } from "./candidate-dequeue-service";
import { createCandidateRating } from "./game-comparison";
import type {
  ImportActivationIntent,
  ImportActivationIntentRepository,
} from "./import-activation-intent-repository";
import type { ImportSessionRepository } from "./import-session-repository";
import type { InitialBootstrapRepository } from "./initial-bootstrap";
import type { GameRepository, GameRepositoryEnvelope } from "./repository";
import { StateLockCoordinator } from "./state-lock-coordinator";

type RevisionedGameRepository = GameRepository & {
  loadEnvelope(): Promise<GameRepositoryEnvelope | null>;
  saveEnvelope(envelope: GameRepositoryEnvelope): Promise<void>;
};

interface ImportActivationServiceOptions {
  coordinator: StateLockCoordinator;
  intentRepository: ImportActivationIntentRepository;
  importSessionRepository: ImportSessionRepository;
  gameRepository: RevisionedGameRepository;
  challengerRepository: ChallengerRepository;
  bootstrapRepository: InitialBootstrapRepository;
  preferenceSeed: string;
  gameRules: GameRules;
  initialRating: number;
  initialGenerationTurnaroundMs?: number;
  verifyCandidateAsset: (
    candidate: Candidate,
    source: "imported" | "generated",
  ) => Promise<void>;
  archiveSupersededJob: (jobId: string) => Promise<void>;
  createId?: () => string;
  now?: () => string;
}

interface ActivationCandidate {
  candidate: Candidate;
  source: "imported" | "generated";
  importItemId: string | null;
  completedAt: string;
  durableId: string;
}

const allLocks = [
  "activation-intent",
  "import-session",
  "game",
  "challenger",
  "initial-bootstrap",
] as const;

export class ImportActivationService {
  private readonly createId: () => string;
  private readonly now: () => string;

  constructor(private readonly options: ImportActivationServiceOptions) {
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async reconcile(): Promise<GameStartState | null> {
    const staged = await this.options.coordinator.withStateLocks(
      allLocks,
      async () => {
        const existing = await this.options.intentRepository.load();
        if (existing?.phase === "cleaned") {
          await this.verifyCleanedLocked(existing);
          await this.options.intentRepository.clear(existing.id);
          const game = await this.options.gameRepository.load();
          return { intent: null, game };
        }

        if (existing?.phase === "prepared") {
          const targetState = await this.targetStateLocked(existing);
          if (!targetState.anyNext) {
            if (!targetState.allOld) {
              throw new Error(
                "Prepared activation targets changed outside the journal",
              );
            }
            const cleaned: ImportActivationIntent = {
              ...existing,
              phase: "cleaned",
              outcome: "rollback",
              cleanedAt: this.now(),
            };
            await this.options.intentRepository.save(cleaned);
            return {
              intent: null,
              game: await this.options.gameRepository.load(),
            };
          }
        }

        let intent = existing;
        if (!intent) {
          intent = await this.prepareLocked();
          if (!intent) {
            return {
              intent: null,
              game: await this.options.gameRepository.load(),
            };
          }
        }
        if (intent.phase === "prepared") {
          intent = {
            ...intent,
            phase: "writing",
            outcome: "commit",
          };
          await this.options.intentRepository.save(intent);
        }
        if (intent.phase === "writing") {
          await this.installTargetsLocked(intent);
          intent = {
            ...intent,
            phase: "committed",
            committedAt: this.now(),
          };
          await this.options.intentRepository.save(intent);
        }
        return { intent, game: intent.next.game.state };
      },
    );

    if (!staged.intent) {
      return staged.game ? { status: "ready", game: staged.game } : null;
    }

    let intent = staged.intent;
    if (intent.phase === "committed") {
      for (const jobId of intent.supersededJobIds) {
        if (intent.archivedSupersededJobIds.includes(jobId)) continue;
        await this.options.archiveSupersededJob(jobId);
        intent = await this.options.intentRepository.withLock(async () => {
          const current = await this.options.intentRepository.load();
          if (!current || current.id !== intent.id) {
            throw new Error("Activation intent changed during mailbox cleanup");
          }
          if (current.archivedSupersededJobIds.includes(jobId)) return current;
          const updated = {
            ...current,
            archivedSupersededJobIds: [
              ...current.archivedSupersededJobIds,
              jobId,
            ],
          };
          await this.options.intentRepository.save(updated);
          return updated;
        });
      }
    }

    await this.options.coordinator.withStateLocks(allLocks, async () => {
      const current = await this.options.intentRepository.load();
      if (!current || current.id !== intent.id) {
        throw new Error("Activation intent disappeared before cleanup");
      }
      await this.verifyCommittedTargetsLocked(current);
      if (current.phase !== "cleaned") {
        await this.options.intentRepository.save({
          ...current,
          phase: "cleaned",
          outcome: "commit",
          cleanedAt: this.now(),
        });
      }
    });

    return { status: "ready", game: intent.next.game.state };
  }

  private async prepareLocked(): Promise<ImportActivationIntent | null> {
    const session = await this.options.importSessionRepository.load();
    if (
      !session ||
      session.status !== "preparing" ||
      !session.sealedAt ||
      session.initialFillJobs.some(({ status }) => status === "pending")
    ) {
      return null;
    }
    const candidates = activationCandidates(session);
    if (candidates.length < 5) return null;
    await Promise.all(
      candidates.map(({ candidate, source }) =>
        this.options.verifyCandidateAsset(candidate, source),
      ),
    );

    const currentGame = await this.options.gameRepository.loadEnvelope();
    const currentChallengers = await this.options.challengerRepository.load();
    const currentBootstrap = await this.options.bootstrapRepository.load();
    const intentId = this.createId();
    const gameRevisionId = this.createId();
    const challengerSessionId = this.createId();
    const activatedAt = this.now();
    const displayed = candidates.slice(0, 2) as [
      ActivationCandidate,
      ActivationCandidate,
    ];
    let nextImport: ImportSession = {
      ...session,
      status: "active",
      activatedAt,
    };
    for (const [index, entry] of displayed.entries()) {
      if (entry.source !== "imported" || !entry.importItemId) continue;
      const replacementSlot = index === 0 ? "initial-left" : "initial-right";
      nextImport = {
        ...nextImport,
        items: nextImport.items.map((item) =>
          item.id === entry.importItemId
            ? { ...item, status: "served" as const, servedAt: activatedAt }
            : item,
        ),
        servedReceipts: [
          ...nextImport.servedReceipts,
          {
            kind: "activation-display" as const,
            activationDisplayReceiptId: deriveActivationDisplayReceiptId(
              intentId,
              session.id,
              replacementSlot,
            ),
            activationIntentId: intentId,
            importSessionId: session.id,
            replacementSlot,
            importItemId: entry.importItemId,
            candidateId: entry.candidate.id,
            candidate: entry.candidate,
            provenance: "imported" as const,
            servedAt: activatedAt,
          },
        ],
      };
    }
    if (summarizeImportSupply(nextImport).terminal) {
      nextImport = { ...nextImport, status: "completed" };
    }

    const game: GameState = {
      round: {
        leftCandidate: displayed[0].candidate,
        rightCandidate: displayed[1].candidate,
        status: "idle",
        replacingSide: null,
        roundNumber: 1,
        retainedCandidateId: null,
        winStreak: 0,
      },
      history: [],
      preferenceSeed: this.options.preferenceSeed,
      preferenceProfile: preferenceProfileFromSeed(this.options.preferenceSeed),
      preferenceRevisions: [
        {
          createdAt: activatedAt,
          source: "initial",
          profile: preferenceProfileFromSeed(this.options.preferenceSeed),
        },
      ],
      gameRules: this.options.gameRules,
    };
    const queued = candidates.slice(2);
    const challengers: ChallengerState = {
      version: 1,
      sessionId: challengerSessionId,
      ready: queued
        .filter(({ source }) => source === "generated")
        .map((entry) => bufferedCandidate(entry)),
      importQueue: queued
        .filter(({ source }) => source === "imported")
        .map((entry) => bufferedCandidate(entry)),
      refillJobs: [],
      leaderboardProfileJob: null,
      leaderboardVisualProfile: null,
      leaderboardProfileAttemptedFingerprint: null,
      pendingComparison: null,
      preparedDequeues: [],
      pendingSelectionBaseline: null,
      ratings: displayed.map((entry) =>
        createCandidateRating(
          entry.candidate,
          entry.source,
          false,
          this.options.initialRating,
          entry.importItemId,
        ),
      ),
      generationTurnaroundEmaMs:
        this.options.initialGenerationTurnaroundMs ?? 300_000,
      consecutiveFallbackDraws: 0,
      nextFallbackAt: null,
    };
    const supersededJobIds = collectSupersededJobIds(
      currentGame?.state ?? null,
      currentChallengers,
      currentBootstrap,
    );
    const intent: ImportActivationIntent = {
      id: intentId,
      expectedOld: {
        importSessionId: session.id,
        gameRevisionId: currentGame?.revisionId ?? null,
        challengerSessionId: currentChallengers?.sessionId ?? null,
        bootstrapBatchId: currentBootstrap?.batchId ?? null,
      },
      next: {
        game: { revisionId: gameRevisionId, state: game },
        challengers,
        bootstrap: null,
        importSession: nextImport,
      },
      supersededJobIds,
      archivedSupersededJobIds: [],
      phase: "prepared",
      outcome: "undecided",
      preparedAt: activatedAt,
      committedAt: null,
      cleanedAt: null,
    };
    await this.options.intentRepository.save(intent);
    return intent;
  }

  private async installTargetsLocked(intent: ImportActivationIntent) {
    const currentGame = await this.options.gameRepository.loadEnvelope();
    if (
      currentGame &&
      currentGame.revisionId !== intent.expectedOld.gameRevisionId &&
      !isDeepStrictEqual(currentGame, {
        version: 1,
        ...intent.next.game,
      })
    ) {
      throw new Error("Game changed outside the activation journal");
    }
    if (!currentGame && intent.expectedOld.gameRevisionId !== null) {
      throw new Error("Expected game disappeared during activation");
    }
    await this.options.gameRepository.saveEnvelope({
      version: 1,
      ...intent.next.game,
    });

    const currentChallengers = await this.options.challengerRepository.load();
    if (
      currentChallengers &&
      currentChallengers.sessionId !== intent.expectedOld.challengerSessionId &&
      !isDeepStrictEqual(currentChallengers, intent.next.challengers)
    ) {
      throw new Error(
        "Challenger state changed outside the activation journal",
      );
    }
    if (
      !currentChallengers &&
      intent.expectedOld.challengerSessionId !== null
    ) {
      throw new Error(
        "Expected challenger state disappeared during activation",
      );
    }
    await this.options.challengerRepository.save(intent.next.challengers);

    const currentBootstrap = await this.options.bootstrapRepository.load();
    if (
      currentBootstrap &&
      currentBootstrap.batchId !== intent.expectedOld.bootstrapBatchId &&
      !isDeepStrictEqual(currentBootstrap, intent.next.bootstrap)
    ) {
      throw new Error(
        "Initial bootstrap changed outside the activation journal",
      );
    }
    if (!currentBootstrap && intent.expectedOld.bootstrapBatchId !== null) {
      throw new Error(
        "Expected initial bootstrap disappeared during activation",
      );
    }
    await this.options.bootstrapRepository.clear();

    const currentImport = await this.options.importSessionRepository.load();
    if (
      !currentImport ||
      (currentImport.id !== intent.expectedOld.importSessionId &&
        !isDeepStrictEqual(currentImport, intent.next.importSession))
    ) {
      throw new Error("Import session changed outside the activation journal");
    }
    await this.options.importSessionRepository.save(intent.next.importSession);
  }

  private async targetStateLocked(intent: ImportActivationIntent) {
    const [game, challengers, bootstrap, session] = await Promise.all([
      this.options.gameRepository.loadEnvelope(),
      this.options.challengerRepository.load(),
      this.options.bootstrapRepository.load(),
      this.options.importSessionRepository.load(),
    ]);
    return {
      anyNext:
        isDeepStrictEqual(game, { version: 1, ...intent.next.game }) ||
        isDeepStrictEqual(challengers, intent.next.challengers) ||
        isDeepStrictEqual(bootstrap, intent.next.bootstrap) ||
        isDeepStrictEqual(session, intent.next.importSession),
      allOld:
        (game?.revisionId ?? null) === intent.expectedOld.gameRevisionId &&
        (challengers?.sessionId ?? null) ===
          intent.expectedOld.challengerSessionId &&
        (bootstrap?.batchId ?? null) === intent.expectedOld.bootstrapBatchId &&
        (session?.id ?? null) === intent.expectedOld.importSessionId,
    };
  }

  private async verifyCommittedTargetsLocked(intent: ImportActivationIntent) {
    const [game, challengers, bootstrap, session] = await Promise.all([
      this.options.gameRepository.loadEnvelope(),
      this.options.challengerRepository.load(),
      this.options.bootstrapRepository.load(),
      this.options.importSessionRepository.load(),
    ]);
    if (
      !isDeepStrictEqual(game, { version: 1, ...intent.next.game }) ||
      !isDeepStrictEqual(challengers, intent.next.challengers) ||
      !isDeepStrictEqual(bootstrap, intent.next.bootstrap) ||
      !isDeepStrictEqual(session, intent.next.importSession)
    ) {
      throw new Error("Committed activation targets do not match the journal");
    }
  }

  private async verifyCleanedLocked(intent: ImportActivationIntent) {
    if (intent.outcome === "commit") {
      await this.verifyCommittedTargetsLocked(intent);
      return;
    }
    const [game, challengers, bootstrap, session] = await Promise.all([
      this.options.gameRepository.loadEnvelope(),
      this.options.challengerRepository.load(),
      this.options.bootstrapRepository.load(),
      this.options.importSessionRepository.load(),
    ]);
    if (
      game?.revisionId !== intent.expectedOld.gameRevisionId ||
      challengers?.sessionId !== intent.expectedOld.challengerSessionId ||
      bootstrap?.batchId !== intent.expectedOld.bootstrapBatchId ||
      session?.id !== intent.expectedOld.importSessionId
    ) {
      throw new Error(
        "Rolled-back activation targets no longer match expected state",
      );
    }
  }
}

function activationCandidates(session: ImportSession): ActivationCandidate[] {
  const imported = session.items
    .filter(
      (
        item,
      ): item is ImportItem & {
        candidateId: string;
        annotation: NonNullable<ImportItem["annotation"]>;
      } =>
        item.status === "ready" &&
        item.candidateId !== null &&
        item.annotation !== null,
    )
    .map((item) => ({
      candidate: {
        id: item.candidateId,
        imageUrl: item.asset.url,
        prompt: item.annotation.prompt,
        concept: item.annotation.concept,
        style: item.annotation.style,
        createdAt: item.readyAt ?? item.approvedAt,
        winCount: 0,
        reasoningSummary: item.annotation.reasoningSummary,
      },
      source: "imported" as const,
      importItemId: item.id,
      completedAt: item.readyAt ?? item.approvedAt,
      durableId: item.id,
    }));
  const generated = session.initialFillJobs
    .filter(
      (
        job,
      ): job is typeof job & { candidate: Candidate; completedAt: string } =>
        job.status === "ready" &&
        job.candidate !== null &&
        job.completedAt !== null,
    )
    .map((job) => ({
      candidate: job.candidate,
      source: "generated" as const,
      importItemId: null,
      completedAt: job.completedAt,
      durableId: job.id,
    }));
  return [...imported, ...generated].sort(
    (left, right) =>
      Date.parse(left.completedAt) - Date.parse(right.completedAt) ||
      left.durableId.localeCompare(right.durableId),
  );
}

function bufferedCandidate(entry: ActivationCandidate) {
  return {
    candidate: entry.candidate,
    source: entry.source,
    importItemId: entry.importItemId,
    pinnedWinnerId: null,
    enqueuedAt: entry.completedAt,
  };
}

function collectSupersededJobIds(
  game: GameState | null,
  challengers: ChallengerState | null,
  bootstrap: Awaited<ReturnType<InitialBootstrapRepository["load"]>>,
): string[] {
  const ids = [
    ...(challengers?.refillJobs.map(({ jobId }) => jobId) ?? []),
    challengers?.leaderboardProfileJob?.jobId,
    ...(bootstrap?.jobs.map(({ id }) => id) ?? []),
    game?.pendingSelection?.kind === "generation"
      ? game.pendingSelection.generationJobId
      : undefined,
    game?.mailboxCleanupJobId,
    game?.promptDeck?.editorJob?.jobId,
    game?.promptDeck?.blendJob?.jobId,
    game?.promptDeck?.writerJob?.jobId,
  ].filter((id): id is string => Boolean(id));
  return [...new Set(ids)].sort();
}
