import { isDeepStrictEqual } from "node:util";
import {
  drawFallback,
  drawFallbackBatch,
  popReady,
  admitGeneratedCandidate,
  backfillGeneratedPool,
  recordGenerationTurnaround,
  refillJobMatchesGenerationPreferences,
  summarizeLeaderboardPreferenceEvidence,
  updateElo,
  type BufferedCandidate,
  type CandidateRating,
  type ChallengerState,
  type LeaderboardVisualProfile,
  type PendingComparisonReceipt,
  type PendingSelectionBaseline,
  type RefillJobRecord,
} from "@/domain/challenger-state";
import {
  beginChampionRetirement,
  beginBothLose,
  beginBufferedSelection,
  beginTie,
  applyWinnerPreferenceRevision,
  candidateAt,
  composePreferenceSeed,
  completeChampionRetirement,
  completeBothLose,
  completeSelection,
  completeTie,
  failSelection,
  oppositeSide,
  recentConcepts,
  recordRejectedPreferenceEvidence,
  preferenceProfileFromSeed,
  willRetireChampion,
  type Candidate,
  type GameState,
  type PreferenceProfile,
  type Side,
} from "@/domain/game";
import type {
  GenerationJob,
  GenerationMailbox,
  GenerationResult,
} from "./agent-mailbox";
import type { ChallengerRepository } from "./challenger-repository";
import { challengerConfig } from "./challenger-config";
import type { LeaderboardProfileCoordinator } from "./leaderboard-profile-service";
import type { AssetStore } from "./providers";
import type { GameRepository } from "./repository";

export class SelectionConflictError extends Error {}
export class MissingGameError extends Error {}

export interface GameServiceConfig {
  bufferTarget: number;
  poolMaximum: number;
  initialRating: number;
  eloKFactor: number;
  turnaroundEmaAlpha: number;
  initialTurnaroundMs: number;
  fallbackDelayMs: number;
  fallbackMaximumConsecutive: number;
}

interface RefillContext {
  game: GameState;
  winnerSide: Side;
  retainedWinner: Candidate;
  rejectedCandidate: Candidate;
  comparisonOutcome?: "tie" | "both-lose";
}

interface CapacityResult {
  state: ChallengerState;
  jobs: GenerationJob[];
}

interface RefillObservation {
  record: RefillJobRecord;
  work: GenerationJob | null;
  result: GenerationResult | null;
  recordIndex: number;
}

export class GameService {
  private reconciliation: Promise<GameState | null> | null = null;

  constructor(
    private readonly gameRepository: GameRepository,
    private readonly challengerRepository: ChallengerRepository,
    private readonly mailbox: GenerationMailbox,
    private readonly assetVerifier: Pick<AssetStore, "verify">,
    private readonly config: GameServiceConfig = challengerConfig,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly random: () => number = Math.random,
    private readonly leaderboardProfiles?: LeaderboardProfileCoordinator,
  ) {}

  async assertIdle(): Promise<void> {
    await this.gameRepository.withLock(async () => {
      if ((await this.gameRepository.load())?.round.status === "generating") {
        throw new SelectionConflictError(
          "A challenger is already being generated",
        );
      }
    });
  }

  async dismissGenerationNotice(): Promise<GameState> {
    return this.gameRepository.withLock(async () => {
      const current = await this.gameRepository.load();
      if (!current) {
        throw new MissingGameError("Start a game before dismissing a notice");
      }
      const updated = this.withoutGenerationNotice(current);
      if (updated !== current) await this.gameRepository.save(updated);
      return updated;
    });
  }

  async updatePreferenceSeed(
    preferenceSeed: string,
    preferenceProfile: PreferenceProfile = preferenceProfileFromSeed(
      preferenceSeed,
    ),
    expectedPreferenceProfile?: PreferenceProfile,
  ): Promise<GameState> {
    return this.withStateLocks(async () => {
      const [current, challengers] = await Promise.all([
        this.gameRepository.load(),
        this.challengerRepository.load(),
      ]);
      if (!current) {
        throw new MissingGameError("Start a game before editing preferences");
      }
      if (
        expectedPreferenceProfile !== undefined &&
        !isDeepStrictEqual(
          current.preferenceProfile ??
            preferenceProfileFromSeed(current.preferenceSeed),
          expectedPreferenceProfile,
        )
      ) {
        throw new SelectionConflictError(
          "Preferences changed while this editor was open. Reopen Preferences and try again.",
        );
      }
      if (current.round.status === "generating") {
        throw new SelectionConflictError(
          "A challenger is already being generated",
        );
      }

      const updated = this.withoutGenerationNotice({
        ...current,
        preferenceSeed,
        preferenceProfile,
      });
      await this.gameRepository.save(updated);
      const generationPreferencesChanged =
        current.preferenceSeed !== preferenceSeed ||
        (current.preferenceProfile?.adaptationMode ?? "static") !==
          preferenceProfile.adaptationMode ||
        (current.preferenceProfile?.adaptationStrength ?? "guided") !==
          (preferenceProfile.adaptationStrength ?? "guided");
      if (!challengers || !generationPreferencesChanged) {
        return updated;
      }

      // Ready candidates and completed refill results were proposed against
      // the previous brief. Keep unfinished records until their workers reach
      // a terminal state, but exclude them from replacement capacity and
      // discard their eventual results during reconciliation.
      let refreshed: ChallengerState = { ...challengers, ready: [] };
      const context = this.refillContext(updated, refreshed);
      const capacity: CapacityResult = context
        ? this.addRefillCapacity(refreshed, context)
        : { state: refreshed, jobs: [] };
      refreshed = capacity.state;
      await this.challengerRepository.save(refreshed);
      await this.ensureJobsEnqueued(capacity.jobs);
      return updated;
    });
  }

  async select(
    winnerSide: Side,
    expectedRoundNumber: number,
  ): Promise<GameState> {
    return this.withStateLocks(async () => {
      const current = await this.gameRepository.load();
      if (!current) {
        throw new MissingGameError("Start a game before choosing an image");
      }
      if (current.round.roundNumber !== expectedRoundNumber) {
        throw new SelectionConflictError(
          "The round changed before this selection arrived",
        );
      }

      const challengerState = await this.challengerRepository.load();
      if (!challengerState) {
        throw new MissingGameError(
          "Start a game before choosing a buffered challenger",
        );
      }

      const selectedAt = this.now();
      const retirement = willRetireChampion(current, winnerSide);
      const inFlight = retirement
        ? beginChampionRetirement(current, winnerSide, selectedAt)
        : beginBufferedSelection(current, winnerSide, selectedAt);
      if (!inFlight) {
        throw new SelectionConflictError(
          "A challenger is already being generated",
        );
      }

      const retainedWinner = candidateAt(current.round, winnerSide);
      const rejectedCandidate = candidateAt(
        current.round,
        oppositeSide(winnerSide),
      );
      let nextChallengers = this.recordComparison(
        {
          ...challengerState,
          pendingSelectionBaseline:
            this.pendingSelectionBaseline(challengerState),
        },
        retainedWinner,
        rejectedCandidate,
        this.comparisonReceipt(current, winnerSide, selectedAt),
      );
      let preparedReadyHeads: BufferedCandidate[] = [];
      let nextGame = inFlight;
      if (retirement) {
        if (nextChallengers.ready.length >= 2) {
          preparedReadyHeads = nextChallengers.ready.slice(0, 2);
          const leftDraw = popReady(nextChallengers);
          const rightDraw = popReady(leftDraw.state);
          nextChallengers = rightDraw.state;
          nextGame = completeChampionRetirement(
            inFlight,
            leftDraw.candidate!,
            rightDraw.candidate!,
          );
        }
      } else {
        let draw = popReady(nextChallengers);
        if (draw.candidate) {
          preparedReadyHeads = nextChallengers.ready.slice(0, 1);
          nextChallengers = draw.state;
          nextGame = completeSelection(inFlight, draw.candidate);
        } else {
          draw = this.drawFallback(nextChallengers, current);
          nextChallengers = draw.state;
          if (draw.candidate)
            nextGame = completeSelection(inFlight, draw.candidate);
        }
      }

      const adapted = this.applyAdaptivePreferences(nextGame, nextChallengers);
      nextGame = adapted.game;
      nextChallengers = adapted.challengers;
      const capacity = this.addRefillCapacity(nextChallengers, {
        game: nextGame,
        winnerSide,
        retainedWinner,
        rejectedCandidate,
      });
      const durableChallengers =
        preparedReadyHeads.length > 0
          ? {
              ...capacity.state,
              ready: [...preparedReadyHeads, ...capacity.state.ready],
            }
          : capacity.state;
      // Persist a replayable selection before committing either side of the
      // cross-repository transition. A prepared FIFO head remains durable
      // until the completed game round is safely stored.
      await this.gameRepository.save(inFlight);
      await this.challengerRepository.save(durableChallengers);
      await this.gameRepository.save(nextGame);
      if (nextGame.round.status === "idle") {
        await this.challengerRepository.save({
          ...capacity.state,
          pendingComparison: null,
          pendingSelectionBaseline: null,
        });
      }
      await this.ensureJobsEnqueued(capacity.jobs);
      return nextGame;
    });
  }

  async tie(expectedRoundNumber: number): Promise<GameState> {
    return this.replacePair(expectedRoundNumber, "tie");
  }

  async bothLose(expectedRoundNumber: number): Promise<GameState> {
    return this.replacePair(expectedRoundNumber, "both-lose");
  }

  private async replacePair(
    expectedRoundNumber: number,
    outcome: "tie" | "both-lose",
  ): Promise<GameState> {
    return this.withStateLocks(async () => {
      const current = await this.gameRepository.load();
      if (!current) {
        throw new MissingGameError(
          outcome === "tie"
            ? "Start a game before declaring a tie"
            : "Start a game before rejecting both candidates",
        );
      }
      if (current.round.roundNumber !== expectedRoundNumber) {
        throw new SelectionConflictError(
          outcome === "tie"
            ? "The round changed before this tie arrived"
            : "The round changed before this dual rejection arrived",
        );
      }

      const challengerState = await this.challengerRepository.load();
      if (!challengerState) {
        throw new MissingGameError(
          "Start a game before replacing tied candidates",
        );
      }

      const selectedAt = this.now();
      const referenceSide = this.tieReferenceSide(current, challengerState);
      const inFlight =
        outcome === "tie"
          ? beginTie(current, referenceSide, selectedAt)
          : beginBothLose(current, referenceSide, selectedAt);
      if (!inFlight) {
        throw new SelectionConflictError(
          "A challenger is already being generated",
        );
      }

      const left = current.round.leftCandidate;
      const right = current.round.rightCandidate;
      const receipt: PendingComparisonReceipt = {
        kind: outcome,
        selectedAt,
        roundNumber: current.round.roundNumber,
        leftId: left.id,
        rightId: right.id,
      };
      const baseline = {
        ...challengerState,
        pendingSelectionBaseline:
          this.pendingSelectionBaseline(challengerState),
      };
      let nextChallengers =
        outcome === "tie"
          ? this.recordTie(baseline, left, right, receipt)
          : this.recordBothLose(baseline, left, right, receipt);
      let preparedReadyHeads: BufferedCandidate[] = [];
      let nextGame = inFlight;
      const replacements = this.drawPairReplacements(nextChallengers, current);
      nextChallengers = replacements.state;
      if (replacements.candidates) {
        preparedReadyHeads = replacements.readyHeads;
        nextGame =
          outcome === "tie"
            ? completeTie(inFlight, ...replacements.candidates)
            : completeBothLose(inFlight, ...replacements.candidates);
      }

      if (outcome === "both-lose" && nextGame.round.status === "idle") {
        const adapted = this.applyAdaptivePreferences(
          nextGame,
          nextChallengers,
        );
        nextGame = adapted.game;
        nextChallengers = adapted.challengers;
      }

      const reference = candidateAt(current.round, referenceSide);
      const contrasted = candidateAt(
        current.round,
        oppositeSide(referenceSide),
      );
      const capacity = this.addRefillCapacity(nextChallengers, {
        game: nextGame,
        winnerSide: referenceSide,
        retainedWinner: reference,
        rejectedCandidate: contrasted,
        comparisonOutcome: outcome,
      });
      const durableChallengers =
        preparedReadyHeads.length > 0
          ? {
              ...capacity.state,
              ready: [...preparedReadyHeads, ...capacity.state.ready],
            }
          : capacity.state;
      await this.gameRepository.save(inFlight);
      await this.challengerRepository.save(durableChallengers);
      await this.gameRepository.save(nextGame);
      if (nextGame.round.status === "idle") {
        await this.challengerRepository.save({
          ...capacity.state,
          pendingComparison: null,
          pendingSelectionBaseline: null,
        });
      }
      await this.ensureJobsEnqueued(capacity.jobs);
      return nextGame;
    });
  }

  async ensureRefillCapacity(): Promise<void> {
    await this.withStateLocks(async () => {
      const [game, challengers] = await Promise.all([
        this.gameRepository.load(),
        this.challengerRepository.load(),
      ]);
      if (!game || !challengers) return;

      const context = this.refillContext(game, challengers);
      if (!context) return;
      const capacity = this.addRefillCapacity(challengers, context);
      if (capacity.jobs.length === 0) return;
      await this.challengerRepository.save(capacity.state);
      await this.ensureJobsEnqueued(capacity.jobs);
    });
  }

  async reconcile(): Promise<GameState | null> {
    if (this.reconciliation) return this.reconciliation;

    const reconciliation = this.withStateLocks(() => this.reconcileLocked());
    this.reconciliation = reconciliation;
    try {
      return await reconciliation;
    } finally {
      if (this.reconciliation === reconciliation) this.reconciliation = null;
    }
  }

  private async reconcileLocked(): Promise<GameState | null> {
    let game = await this.gameRepository.load();
    if (!game) return null;

    if (game.mailboxCleanupJobId) {
      await this.mailbox.archive(game.mailboxCleanupJobId);
      game = this.withoutCleanupMarker(game);
      await this.gameRepository.save(game);
    }

    if (
      game.round.status === "generating" &&
      game.pendingSelection?.kind === "generation"
    ) {
      return this.reconcileLegacySelection(game);
    }

    let challengers = await this.challengerRepository.load();
    if (!challengers) return game;

    const backfilled = backfillGeneratedPool(
      challengers,
      this.config.poolMaximum,
    );
    if (backfilled !== challengers) {
      challengers = backfilled;
      await this.challengerRepository.save(challengers);
    }

    challengers = await this.syncLeaderboardProfile(game, challengers);

    challengers = await this.prepareComparison(game, challengers);

    const prepared = await this.completePreparedSelection(game, challengers);
    game = prepared.game;
    challengers = await this.removeDisplayedCandidatesFromReady(
      prepared.game,
      prepared.challengers,
    );

    const observations = await Promise.all(
      challengers.refillJobs.map(async (record, recordIndex) => {
        const [work, result] = await Promise.all([
          this.mailbox.readWork(record.jobId),
          this.mailbox.readResult(record.jobId),
        ]);
        return { record, work, result, recordIndex };
      }),
    );
    observations.sort((left, right) => {
      const leftCompletedAt = left.result
        ? Date.parse(left.result.completedAt)
        : Number.POSITIVE_INFINITY;
      const rightCompletedAt = right.result
        ? Date.parse(right.result.completedAt)
        : Number.POSITIVE_INFINITY;
      return (
        leftCompletedAt - rightCompletedAt ||
        left.recordIndex - right.recordIndex
      );
    });

    for (const observation of observations) {
      const outcome = await this.reconcileRefillRecord(
        game,
        challengers,
        observation,
      );
      game = outcome.game;
      challengers = outcome.challengers;
    }

    if (
      game.round.status === "generating" &&
      game.pendingSelection?.kind === "buffer"
    ) {
      let draw = popReady(challengers);
      if (!draw.candidate) draw = this.drawFallback(challengers, game);
      challengers = draw.state;
      if (draw.candidate) {
        const adapted = this.applyAdaptivePreferences(
          completeSelection(game, draw.candidate),
          challengers,
        );
        game = adapted.game;
        challengers = adapted.challengers;
        await this.gameRepository.save(game);
        challengers = {
          ...challengers,
          pendingComparison: null,
          pendingSelectionBaseline: null,
        };
        await this.challengerRepository.save(challengers);
      }
    }

    const context = this.refillContext(game, challengers);
    if (context) {
      const capacity = this.addRefillCapacity(challengers, context);
      challengers = capacity.state;
      if (capacity.jobs.length > 0) {
        await this.challengerRepository.save(challengers);
        await this.ensureJobsEnqueued(capacity.jobs);
      }
    }

    return game;
  }

  private async reconcileRefillRecord(
    game: GameState,
    challengers: ChallengerState,
    observation: RefillObservation,
  ): Promise<{ game: GameState; challengers: ChallengerState }> {
    const { record, work, result } = observation;
    const expected = record.expectedJob;

    if (!refillJobMatchesGenerationPreferences(expected, game)) {
      // Do not interrupt a worker that already owns the old request. Once it
      // terminates, archive the result without admitting it to the ready FIFO.
      if (work && !result) return { game, challengers };
      return {
        game,
        challengers: await this.archiveInvalidRefill(challengers, record),
      };
    }

    if (!result) {
      if (!work) {
        await this.ensureEnqueued(expected);
        return { game, challengers };
      }
      if (
        !this.validRefillWork(work, record, challengers.sessionId) ||
        !this.sameJob(work, expected)
      ) {
        return {
          game,
          challengers: await this.archiveInvalidRefill(challengers, record),
        };
      }
      return { game, challengers };
    }

    if (
      result.jobId !== record.jobId ||
      !work ||
      !this.validRefillWork(work, record, challengers.sessionId) ||
      !this.sameJob(work, expected)
    ) {
      return {
        game,
        challengers: await this.archiveInvalidRefill(challengers, record),
      };
    }

    if (result.status === "failed") {
      let notifiedGame = game;
      if (this.isModerationFailure(result)) {
        notifiedGame = {
          ...game,
          generationNotice: {
            kind: "moderation-block",
            jobId: result.jobId,
            occurredAt: result.completedAt,
            occurrenceCount: (game.generationNotice?.occurrenceCount ?? 0) + 1,
          },
        };
        await this.gameRepository.save(notifiedGame);
      }
      return {
        game: notifiedGame,
        challengers: await this.archiveInvalidRefill(challengers, record),
      };
    }

    const generated = this.candidateFromResult(result);
    if (!generated) {
      return {
        game,
        challengers: await this.archiveInvalidRefill(challengers, record),
      };
    }

    const existingRating = challengers.ratings.find(
      ({ candidate }) => candidate.id === generated.id,
    );
    if (existingRating) {
      if (!isDeepStrictEqual(existingRating.candidate, generated)) {
        return {
          game,
          challengers: await this.archiveInvalidRefill(challengers, record),
        };
      }
      const candidateIsReady = challengers.ready.some(
        ({ candidate }) => candidate.id === generated.id,
      );
      const candidateIsDisplayed =
        game.round.leftCandidate.id === generated.id ||
        game.round.rightCandidate.id === generated.id;
      if (!candidateIsReady && !candidateIsDisplayed) {
        return {
          game,
          challengers: await this.archiveInvalidRefill(challengers, record),
        };
      }

      const replayed = await this.completePreparedSelection(game, challengers);
      game = replayed.game;
      challengers = await this.removeDisplayedCandidatesFromReady(
        replayed.game,
        replayed.challengers,
      );
      await this.mailbox.archive(record.jobId);
      const cleaned = this.withoutRefillRecord(challengers, record.jobId);
      await this.challengerRepository.save(cleaned);
      return { game, challengers: cleaned };
    }

    if (this.candidateIdExists(challengers, game, generated.id)) {
      return {
        game,
        challengers: await this.archiveInvalidRefill(challengers, record),
      };
    }

    try {
      await this.assetVerifier.verify(result.asset);
    } catch {
      return {
        game,
        challengers: await this.archiveInvalidRefill(challengers, record),
      };
    }

    let applied = recordGenerationTurnaround(
      {
        ...challengers,
        ready: [
          ...challengers.ready,
          {
            candidate: generated,
            source: "generated",
            pinnedWinnerId: record.pinnedWinnerId,
            enqueuedAt: result.completedAt,
          },
        ],
        ratings: [
          ...challengers.ratings,
          this.newRating(generated, "generated", false),
        ],
      },
      record.enqueuedAt,
      result.completedAt,
      this.config.turnaroundEmaAlpha,
    );

    // Keep the refill record until cleanup succeeds. If archive fails, the
    // rating entry proves this result was already applied on the next pass.
    await this.challengerRepository.save(applied);
    const replayed = await this.completePreparedSelection(game, applied);
    game = replayed.game;
    applied = replayed.challengers;
    await this.mailbox.archive(record.jobId);
    const cleaned = this.withoutRefillRecord(applied, record.jobId);
    await this.challengerRepository.save(cleaned);
    return { game, challengers: cleaned };
  }

  private async archiveInvalidRefill(
    state: ChallengerState,
    record: RefillJobRecord,
  ): Promise<ChallengerState> {
    await this.mailbox.archive(record.jobId);
    const cleaned = this.withoutRefillRecord(state, record.jobId);
    await this.challengerRepository.save(cleaned);
    return cleaned;
  }

  private async syncLeaderboardProfile(
    game: GameState,
    state: ChallengerState,
  ): Promise<ChallengerState> {
    const coordinator = this.leaderboardProfiles;
    if (!coordinator) return state;

    let next = state;
    const record = next.leaderboardProfileJob;
    if (record) {
      const [work, result] = await Promise.all([
        coordinator.readWork(record.jobId),
        coordinator.readResult(record.jobId),
      ]);
      if (!result) {
        if (!work)
          await this.ensureLeaderboardProfileEnqueued(record.expectedJob);
        else if (!isDeepStrictEqual(work, record.expectedJob)) {
          await coordinator.archive(record.jobId);
          next = {
            ...next,
            leaderboardProfileJob: null,
            leaderboardProfileAttemptedFingerprint: null,
          };
          await this.challengerRepository.save(next);
        }
        return next;
      }

      let visualProfile = next.leaderboardVisualProfile ?? null;
      let attemptedFingerprint: string | null =
        next.leaderboardProfileAttemptedFingerprint ?? record.fingerprint;
      if (
        work &&
        isDeepStrictEqual(work, record.expectedJob) &&
        result.status === "completed" &&
        result.kind === "leaderboard-profile" &&
        result.fingerprint === record.fingerprint
      ) {
        visualProfile = {
          fingerprint: result.fingerprint,
          sourceCandidateIds: record.expectedJob.sources.map(
            ({ candidateId }) => candidateId,
          ),
          profile: result.profile,
          reasoningSummary: result.reasoningSummary,
          analyzedAt: result.completedAt,
        };
      } else if (!work || !isDeepStrictEqual(work, record.expectedJob)) {
        attemptedFingerprint = null;
      }
      await coordinator.archive(record.jobId);
      next = {
        ...next,
        leaderboardProfileJob: null,
        leaderboardVisualProfile: visualProfile,
        leaderboardProfileAttemptedFingerprint: attemptedFingerprint,
      };
      await this.challengerRepository.save(next);
    }

    if (
      (game.preferenceProfile?.adaptationMode ?? "static") !== "adaptive" ||
      next.leaderboardProfileJob
    ) {
      return next;
    }
    const desired = coordinator.desired(next);
    if (
      !desired ||
      next.leaderboardVisualProfile?.fingerprint === desired.fingerprint ||
      next.leaderboardProfileAttemptedFingerprint === desired.fingerprint
    ) {
      return next;
    }

    const id = this.createId();
    const createdAt = this.now();
    let job: Parameters<LeaderboardProfileCoordinator["enqueue"]>[0];
    try {
      job = await coordinator.prepare(id, createdAt, desired);
    } catch (error) {
      console.warn("Leaderboard visual analysis could not be prepared", error);
      next = {
        ...next,
        leaderboardProfileAttemptedFingerprint: desired.fingerprint,
      };
      await this.challengerRepository.save(next);
      return next;
    }
    next = {
      ...next,
      leaderboardProfileJob: {
        jobId: id,
        fingerprint: desired.fingerprint,
        enqueuedAt: createdAt,
        expectedJob: job,
      },
      leaderboardProfileAttemptedFingerprint: desired.fingerprint,
    };
    await this.challengerRepository.save(next);
    await this.ensureLeaderboardProfileEnqueued(job);
    return next;
  }

  private currentLeaderboardVisualProfile(
    state: ChallengerState,
    game: GameState,
  ): LeaderboardVisualProfile | undefined {
    if ((game.preferenceProfile?.adaptationMode ?? "static") !== "adaptive") {
      return undefined;
    }
    const desired = this.leaderboardProfiles?.desired(state);
    const visualProfile = state.leaderboardVisualProfile ?? undefined;
    return desired && visualProfile?.fingerprint === desired.fingerprint
      ? visualProfile
      : undefined;
  }

  private async ensureLeaderboardProfileEnqueued(
    job: Parameters<LeaderboardProfileCoordinator["enqueue"]>[0],
  ): Promise<void> {
    const coordinator = this.leaderboardProfiles;
    if (!coordinator) return;
    try {
      await coordinator.enqueue(job);
    } catch (error) {
      const work = await coordinator.readWork(job.id);
      if (work && isDeepStrictEqual(work, job)) return;
      throw error;
    }
  }

  private addRefillCapacity(
    state: ChallengerState,
    context: RefillContext,
  ): CapacityResult {
    const jobs: GenerationJob[] = [];
    const records: RefillJobRecord[] = [];
    const leaderboardVisualProfile = this.currentLeaderboardVisualProfile(
      state,
      context.game,
    );
    const deficit = Math.max(
      0,
      this.config.bufferTarget - state.ready.length - state.refillJobs.length,
    );

    for (let index = 0; index < deficit; index += 1) {
      const id = this.createId();
      if (
        state.refillJobs.some(({ jobId }) => jobId === id) ||
        records.some(({ jobId }) => jobId === id)
      ) {
        throw new Error(`Duplicate refill job ID ${id}`);
      }
      const createdAt = this.now();
      const job: GenerationJob = {
        id,
        kind: "refill",
        createdAt,
        roundNumber: context.game.round.roundNumber,
        winnerSide: context.winnerSide,
        retainedWinner: context.retainedWinner,
        rejectedCandidate: context.rejectedCandidate,
        selectionHistory: context.game.history.slice(-12),
        recentConcepts: recentConcepts(context.game, 10),
        leaderboardEvidence: summarizeLeaderboardPreferenceEvidence(state),
        ...(leaderboardVisualProfile ? { leaderboardVisualProfile } : {}),
        preferenceSeed: context.game.preferenceSeed,
        preferenceProfile:
          context.game.preferenceProfile ??
          preferenceProfileFromSeed(context.game.preferenceSeed),
        sessionId: state.sessionId,
        pinnedWinnerId: context.retainedWinner.id,
        comparisonOutcome: context.comparisonOutcome,
      };
      jobs.push(job);
      records.push({
        jobId: id,
        pinnedWinnerId: context.retainedWinner.id,
        enqueuedAt: createdAt,
        expectedJob: job,
      });
    }

    return {
      state:
        records.length === 0
          ? state
          : { ...state, refillJobs: [...state.refillJobs, ...records] },
      jobs,
    };
  }

  private recordComparison(
    state: ChallengerState,
    winner: Candidate,
    loser: Candidate,
    receipt: PendingComparisonReceipt,
  ): ChallengerState {
    let ratings = state.ratings;
    const winnerItem = ratings.find(
      ({ candidate }) => candidate.id === winner.id,
    );
    if (!winnerItem) {
      const source = this.sourceOf(winner);
      ratings = [
        ...ratings,
        this.newRating(winner, source, source === "curated"),
      ];
    }
    const loserItem = ratings.find(
      ({ candidate }) => candidate.id === loser.id,
    );
    if (!loserItem) {
      const source = this.sourceOf(loser);
      ratings = [
        ...ratings,
        this.newRating(loser, source, source === "curated"),
      ];
    }

    const ratedWinner = ratings.find(
      ({ candidate }) => candidate.id === winner.id,
    )!;
    const ratedLoser = ratings.find(
      ({ candidate }) => candidate.id === loser.id,
    )!;
    const nextRatings = updateElo(
      ratedWinner.rating,
      ratedLoser.rating,
      this.config.eloKFactor,
    );
    const updated: ChallengerState = {
      ...state,
      pendingComparison: receipt,
      ratings: ratings.map((item) => {
        if (item === ratedWinner) {
          return {
            ...item,
            rating: nextRatings.winner,
            wins: item.wins + 1,
          };
        }
        if (item === ratedLoser) {
          return {
            ...item,
            rating: nextRatings.loser,
            losses: item.losses + 1,
          };
        }
        return item;
      }),
    };
    const withLoser = admitGeneratedCandidate(
      updated,
      loser.id,
      this.config.poolMaximum,
    );
    return admitGeneratedCandidate(
      withLoser,
      winner.id,
      this.config.poolMaximum,
    );
  }

  private recordTie(
    state: ChallengerState,
    left: Candidate,
    right: Candidate,
    receipt: PendingComparisonReceipt,
  ): ChallengerState {
    let ratings = state.ratings;
    for (const candidate of [left, right]) {
      if (!ratings.some((item) => item.candidate.id === candidate.id)) {
        const source = this.sourceOf(candidate);
        ratings = [
          ...ratings,
          this.newRating(candidate, source, source === "curated"),
        ];
      }
    }

    const ratedLeft = ratings.find(
      ({ candidate }) => candidate.id === left.id,
    )!;
    const ratedRight = ratings.find(
      ({ candidate }) => candidate.id === right.id,
    )!;
    let lower: CandidateRating | null = null;
    let higher: CandidateRating | null = null;
    if (ratedLeft.rating < ratedRight.rating) {
      lower = ratedLeft;
      higher = ratedRight;
    } else if (ratedRight.rating < ratedLeft.rating) {
      lower = ratedRight;
      higher = ratedLeft;
    }
    const lowerRating =
      lower && higher
        ? updateElo(lower.rating, higher.rating, this.config.eloKFactor).winner
        : null;
    const updated: ChallengerState = {
      ...state,
      pendingComparison: receipt,
      ratings: ratings.map((item) =>
        item === lower ? { ...item, rating: lowerRating! } : item,
      ),
    };
    const withLeft = admitGeneratedCandidate(
      updated,
      left.id,
      this.config.poolMaximum,
    );
    return admitGeneratedCandidate(withLeft, right.id, this.config.poolMaximum);
  }

  private recordBothLose(
    state: ChallengerState,
    left: Candidate,
    right: Candidate,
    receipt: PendingComparisonReceipt,
  ): ChallengerState {
    let ratings = state.ratings;
    for (const candidate of [left, right]) {
      if (!ratings.some((item) => item.candidate.id === candidate.id)) {
        const source = this.sourceOf(candidate);
        ratings = [
          ...ratings,
          this.newRating(candidate, source, source === "curated"),
        ];
      }
    }

    const rejectedIds = new Set([left.id, right.id]);
    return {
      ...state,
      pendingComparison: receipt,
      ratings: ratings.map((item) =>
        rejectedIds.has(item.candidate.id)
          ? {
              ...item,
              losses: item.losses + 1,
              poolMember: false,
              poolEligible: false,
            }
          : item,
      ),
    };
  }

  private tieReferenceSide(game: GameState, state: ChallengerState): Side {
    const leftRating =
      state.ratings.find(
        ({ candidate }) => candidate.id === game.round.leftCandidate.id,
      )?.rating ?? this.config.initialRating;
    const rightRating =
      state.ratings.find(
        ({ candidate }) => candidate.id === game.round.rightCandidate.id,
      )?.rating ?? this.config.initialRating;
    return rightRating < leftRating ? "right" : "left";
  }

  private comparisonReceipt(
    game: GameState,
    winnerSide: Side,
    selectedAt: string,
  ): PendingComparisonReceipt {
    return {
      selectedAt,
      roundNumber: game.round.roundNumber,
      winnerSide,
      winnerId: candidateAt(game.round, winnerSide).id,
      loserId: candidateAt(game.round, oppositeSide(winnerSide)).id,
    };
  }

  private async prepareComparison(
    game: GameState,
    challengers: ChallengerState,
  ): Promise<ChallengerState> {
    const pending = game.pendingSelection;
    if (
      game.round.status !== "generating" ||
      !pending ||
      (pending.kind !== "buffer" &&
        pending.kind !== "retirement" &&
        pending.kind !== "tie" &&
        pending.kind !== "both-lose")
    ) {
      if (
        challengers.pendingComparison === null &&
        !challengers.pendingSelectionBaseline
      ) {
        return challengers;
      }
      const cleaned = {
        ...challengers,
        pendingComparison: null,
        pendingSelectionBaseline: null,
      };
      await this.challengerRepository.save(cleaned);
      return cleaned;
    }

    const receipt: PendingComparisonReceipt =
      pending.kind === "tie" || pending.kind === "both-lose"
        ? {
            kind: pending.kind,
            selectedAt: pending.selectedAt,
            roundNumber: game.round.roundNumber,
            leftId: game.round.leftCandidate.id,
            rightId: game.round.rightCandidate.id,
          }
        : this.comparisonReceipt(game, pending.winnerSide, pending.selectedAt);
    if (isDeepStrictEqual(challengers.pendingComparison, receipt)) {
      return challengers;
    }
    if (challengers.pendingComparison !== null) {
      throw new Error(
        "Persisted comparison receipt does not match the pending selection",
      );
    }

    const baseline = challengers.pendingSelectionBaseline
      ? challengers
      : {
          ...challengers,
          pendingSelectionBaseline: this.pendingSelectionBaseline(challengers),
        };
    const compared =
      pending.kind === "tie"
        ? this.recordTie(
            baseline,
            game.round.leftCandidate,
            game.round.rightCandidate,
            receipt,
          )
        : pending.kind === "both-lose"
          ? this.recordBothLose(
              baseline,
              game.round.leftCandidate,
              game.round.rightCandidate,
              receipt,
            )
          : this.recordComparison(
              baseline,
              candidateAt(game.round, pending.winnerSide),
              candidateAt(game.round, oppositeSide(pending.winnerSide)),
              receipt,
            );
    await this.challengerRepository.save(compared);
    return compared;
  }

  private refillContext(
    game: GameState,
    challengers: ChallengerState,
  ): RefillContext | null {
    if (
      game.pendingSelection?.kind === "buffer" ||
      game.pendingSelection?.kind === "retirement"
    ) {
      const winnerSide = game.pendingSelection.winnerSide;
      return {
        game,
        winnerSide,
        retainedWinner: candidateAt(game.round, winnerSide),
        rejectedCandidate: candidateAt(game.round, oppositeSide(winnerSide)),
      };
    }

    if (
      game.pendingSelection?.kind === "tie" ||
      game.pendingSelection?.kind === "both-lose"
    ) {
      const referenceSide = game.pendingSelection.referenceSide;
      return {
        game,
        winnerSide: referenceSide,
        retainedWinner: candidateAt(game.round, referenceSide),
        rejectedCandidate: candidateAt(game.round, oppositeSide(referenceSide)),
        comparisonOutcome: game.pendingSelection.kind,
      };
    }

    const retainedId = game.round.retainedCandidateId;
    if (!retainedId) return null;
    const winnerSide: Side | null =
      game.round.leftCandidate.id === retainedId
        ? "left"
        : game.round.rightCandidate.id === retainedId
          ? "right"
          : null;
    if (!winnerSide) return null;

    const lastSelection = game.history.at(-1);
    const rejectedCandidate =
      lastSelection &&
      (lastSelection.outcome === undefined ||
        lastSelection.outcome === "selection")
        ? challengers.ratings.find(
            ({ candidate }) => candidate.id === lastSelection.loserId,
          )?.candidate
        : undefined;
    return {
      game,
      winnerSide,
      retainedWinner: candidateAt(game.round, winnerSide),
      rejectedCandidate:
        rejectedCandidate ?? candidateAt(game.round, oppositeSide(winnerSide)),
    };
  }

  private async completePreparedSelection(
    game: GameState,
    challengers: ChallengerState,
  ): Promise<{ game: GameState; challengers: ChallengerState }> {
    if (game.round.status !== "generating" || !game.pendingSelection) {
      return { game, challengers };
    }

    if (game.pendingSelection.kind === "retirement") {
      if (challengers.ready.length < 2) return { game, challengers };
      const leftDraw = popReady(challengers);
      const rightDraw = popReady(leftDraw.state);
      const adapted = this.applyAdaptivePreferences(
        completeChampionRetirement(
          game,
          leftDraw.candidate!,
          rightDraw.candidate!,
        ),
        rightDraw.state,
      );
      await this.gameRepository.save(adapted.game);
      const finalized = {
        ...adapted.challengers,
        pendingComparison: null,
        pendingSelectionBaseline: null,
      };
      await this.challengerRepository.save(finalized);
      return { game: adapted.game, challengers: finalized };
    }

    if (
      game.pendingSelection.kind === "tie" ||
      game.pendingSelection.kind === "both-lose"
    ) {
      const outcome = game.pendingSelection.kind;
      const replacements = this.drawPairReplacements(challengers, game);
      if (!replacements.candidates) {
        if (replacements.state !== challengers) {
          await this.challengerRepository.save(replacements.state);
        }
        return { game, challengers: replacements.state };
      }
      const completed =
        outcome === "tie"
          ? completeTie(game, ...replacements.candidates)
          : completeBothLose(game, ...replacements.candidates);
      const adapted =
        outcome === "both-lose"
          ? this.applyAdaptivePreferences(completed, replacements.state)
          : { game: completed, challengers: replacements.state };
      await this.gameRepository.save(adapted.game);
      const finalized = {
        ...adapted.challengers,
        pendingComparison: null,
        pendingSelectionBaseline: null,
      };
      await this.challengerRepository.save(finalized);
      return { game: adapted.game, challengers: finalized };
    }

    if (game.pendingSelection.kind !== "buffer") {
      return { game, challengers };
    }

    let draw = popReady(challengers);
    if (!draw.candidate) {
      const currentIds = new Set([
        game.round.leftCandidate.id,
        game.round.rightCandidate.id,
      ]);
      const preparedFallback = challengers.ratings.find(
        ({ candidate, lastServedAt }) =>
          lastServedAt === game.pendingSelection?.selectedAt &&
          !currentIds.has(candidate.id),
      )?.candidate;
      if (preparedFallback) {
        draw = { candidate: preparedFallback, state: challengers };
      }
    }
    if (!draw.candidate) return { game, challengers };

    const adapted = this.applyAdaptivePreferences(
      completeSelection(game, draw.candidate),
      draw.state,
    );
    await this.gameRepository.save(adapted.game);
    const finalized = {
      ...adapted.challengers,
      pendingComparison: null,
      pendingSelectionBaseline: null,
    };
    if (
      adapted.challengers !== challengers ||
      challengers.pendingComparison !== null
    ) {
      await this.challengerRepository.save(finalized);
    }
    return { game: adapted.game, challengers: finalized };
  }

  private applyAdaptivePreferences(
    game: GameState,
    challengers: ChallengerState,
  ): { game: GameState; challengers: ChallengerState } {
    const selection = game.history.at(-1);
    const profile = game.preferenceProfile;
    if (
      !selection ||
      selection.outcome === "tie" ||
      !profile ||
      profile.adaptationMode !== "adaptive"
    ) {
      return { game, challengers };
    }
    let nextProfile = profile;
    if (selection.outcome === "both-lose") {
      for (const rejectedId of [selection.leftId, selection.rightId]) {
        const rejected = challengers.ratings.find(
          ({ candidate }) => candidate.id === rejectedId,
        );
        if (rejected?.source === "generated") {
          nextProfile = recordRejectedPreferenceEvidence(
            nextProfile,
            rejected.candidate.id,
          );
        }
      }
    } else {
      const winner = challengers.ratings.find(
        ({ candidate }) => candidate.id === selection.winnerId,
      );
      const rejected = challengers.ratings.find(
        ({ candidate }) => candidate.id === selection.loserId,
      );
      nextProfile = winner
        ? applyWinnerPreferenceRevision(
            profile,
            winner.candidate,
            game.history.length,
          )
        : profile;
      if (rejected?.source === "generated") {
        nextProfile = recordRejectedPreferenceEvidence(
          nextProfile,
          rejected.candidate.id,
        );
      }
    }
    if (nextProfile === profile) return { game, challengers };
    const composedProfile = composePreferenceSeed(profile);
    const composedNextProfile = composePreferenceSeed(nextProfile);
    const preferenceSeed =
      composedNextProfile === composedProfile
        ? game.preferenceSeed
        : composedNextProfile;
    return {
      game: { ...game, preferenceProfile: nextProfile, preferenceSeed },
      challengers:
        preferenceSeed === game.preferenceSeed
          ? challengers
          : { ...challengers, ready: [] },
    };
  }

  private async removeDisplayedCandidatesFromReady(
    game: GameState,
    challengers: ChallengerState,
  ): Promise<ChallengerState> {
    if (game.round.status !== "idle") return challengers;
    const displayedIds = new Set([
      game.round.leftCandidate.id,
      game.round.rightCandidate.id,
    ]);
    const ready = challengers.ready.filter(
      ({ candidate }) => !displayedIds.has(candidate.id),
    );
    if (ready.length === challengers.ready.length) return challengers;
    const cleaned = { ...challengers, ready };
    await this.challengerRepository.save(cleaned);
    return cleaned;
  }

  private drawFallback(
    state: ChallengerState,
    game: GameState,
  ): ReturnType<typeof drawFallback> {
    const recentCandidateIds = game.history
      .slice(-10)
      .flatMap((decision) =>
        decision.outcome === "tie" || decision.outcome === "both-lose"
          ? [decision.leftId, decision.rightId]
          : [decision.winnerId, decision.loserId],
      );
    return drawFallback(state, {
      now: this.now(),
      currentCandidateIds: [
        game.round.leftCandidate.id,
        game.round.rightCandidate.id,
      ],
      recentCandidateIds,
      random: this.random,
      delayMs: this.config.fallbackDelayMs,
      maximumConsecutiveDraws: this.config.fallbackMaximumConsecutive,
    });
  }

  private drawPairReplacements(
    state: ChallengerState,
    game: GameState,
  ): {
    candidates: [Candidate, Candidate] | null;
    readyHeads: BufferedCandidate[];
    state: ChallengerState;
  } {
    const readyHeads = state.ready.slice(0, 2);
    const fallbackCount = 2 - readyHeads.length;
    if (fallbackCount === 0) {
      const leftDraw = popReady(state);
      const rightDraw = popReady(leftDraw.state);
      return {
        candidates: [leftDraw.candidate!, rightDraw.candidate!],
        readyHeads,
        state: rightDraw.state,
      };
    }

    const recentCandidateIds = game.history
      .slice(-10)
      .flatMap((decision) =>
        decision.outcome === "tie" || decision.outcome === "both-lose"
          ? [decision.leftId, decision.rightId]
          : [decision.winnerId, decision.loserId],
      );
    const fallback = drawFallbackBatch(
      state,
      {
        now: this.now(),
        currentCandidateIds: [
          game.round.leftCandidate.id,
          game.round.rightCandidate.id,
          ...readyHeads.map(({ candidate }) => candidate.id),
        ],
        recentCandidateIds,
        random: this.random,
        delayMs: this.config.fallbackDelayMs,
        maximumConsecutiveDraws: this.config.fallbackMaximumConsecutive,
      },
      fallbackCount,
    );
    if (fallback.candidates.length < fallbackCount) {
      return { candidates: null, readyHeads: [], state: fallback.state };
    }

    return {
      candidates: [
        ...readyHeads.map(({ candidate }) => candidate),
        ...fallback.candidates,
      ] as [Candidate, Candidate],
      readyHeads,
      state: {
        ...fallback.state,
        ready: fallback.state.ready.slice(readyHeads.length),
      },
    };
  }

  private pendingSelectionBaseline(
    state: ChallengerState,
  ): PendingSelectionBaseline {
    return {
      ready: state.ready,
      ratings: state.ratings,
      generationTurnaroundEmaMs: state.generationTurnaroundEmaMs,
      consecutiveFallbackDraws: state.consecutiveFallbackDraws,
      nextFallbackAt: state.nextFallbackAt,
    };
  }

  private candidateFromResult(
    result: Extract<GenerationResult, { status: "completed" }>,
  ): Candidate | null {
    const expectedCandidateId = `challenger-${result.jobId}`;
    if (result.asset.candidateId !== expectedCandidateId) return null;
    return {
      id: result.asset.candidateId,
      imageUrl: result.asset.imageUrl,
      prompt: result.proposal.visualPrompt,
      concept: result.proposal.concept,
      style: result.proposal.styleTags,
      reasoningSummary: result.proposal.reasoningSummary,
      preferenceRevision: result.proposal.preferenceRevision,
      createdAt: result.completedAt,
      winCount: 0,
    };
  }

  private candidateIdExists(
    state: ChallengerState,
    game: GameState,
    candidateId: string,
  ): boolean {
    return (
      game.round.leftCandidate.id === candidateId ||
      game.round.rightCandidate.id === candidateId ||
      state.ready.some(({ candidate }) => candidate.id === candidateId) ||
      state.ratings.some(({ candidate }) => candidate.id === candidateId)
    );
  }

  private newRating(
    candidate: Candidate,
    source: CandidateRating["source"],
    poolMember: boolean,
  ): CandidateRating {
    return {
      candidate,
      rating: this.config.initialRating,
      wins: 0,
      losses: 0,
      source,
      poolMember,
      poolEligible: true,
      lastServedAt: null,
    };
  }

  private sourceOf(candidate: Candidate): CandidateRating["source"] {
    return candidate.imageUrl.startsWith("/seed-assets/")
      ? "curated"
      : "generated";
  }

  private validRefillWork(
    work: GenerationJob,
    record: RefillJobRecord,
    sessionId: string,
  ): boolean {
    return (
      work.kind === "refill" &&
      work.id === record.jobId &&
      work.createdAt === record.enqueuedAt &&
      work.sessionId === sessionId &&
      work.pinnedWinnerId === record.pinnedWinnerId &&
      work.retainedWinner.id === record.pinnedWinnerId
    );
  }

  private withoutRefillRecord(
    state: ChallengerState,
    jobId: string,
  ): ChallengerState {
    return {
      ...state,
      refillJobs: state.refillJobs.filter((record) => record.jobId !== jobId),
    };
  }

  private async ensureJobsEnqueued(jobs: readonly GenerationJob[]) {
    for (const job of jobs) await this.ensureEnqueued(job);
  }

  private async ensureEnqueued(job: GenerationJob): Promise<void> {
    try {
      await this.mailbox.enqueue(job);
    } catch (error) {
      const work = await this.mailbox.readWork(job.id);
      if (work && this.sameJob(work, job)) return;
      throw error;
    }
  }

  private sameJob(left: GenerationJob, right: GenerationJob): boolean {
    return isDeepStrictEqual(left, right);
  }

  private isModerationFailure(
    result: Extract<GenerationResult, { status: "failed" }>,
  ): boolean {
    return (
      result.category === "moderation" ||
      /moderation|content policy|safety (?:policy|filter)|blocked by (?:a )?(?:policy|safety)/i.test(
        result.message,
      )
    );
  }

  private withoutGenerationNotice(game: GameState): GameState {
    if (!game.generationNotice) return game;
    const updated = { ...game };
    delete updated.generationNotice;
    return updated;
  }

  private withStateLocks<T>(operation: () => Promise<T>): Promise<T> {
    return this.gameRepository.withLock(() =>
      this.challengerRepository.withLock(operation),
    );
  }

  private async reconcileLegacySelection(
    current: GameState,
  ): Promise<GameState> {
    const pending = current.pendingSelection;
    if (pending?.kind !== "generation") return current;

    const expectedJob = this.legacyGenerationJob(current);
    const result = await this.mailbox.readResult(pending.generationJobId);
    if (!result) {
      await this.ensureEnqueued(expectedJob);
      return current;
    }
    if (result.jobId !== pending.generationJobId) return current;

    const actualWork = await this.mailbox.readWork(pending.generationJobId);
    let terminal: GameState;
    if (!actualWork || !this.sameJob(actualWork, expectedJob)) {
      terminal = failSelection(
        current,
        "Generation failed: Work metadata does not match the persisted selection",
      );
    } else if (result.status === "failed") {
      terminal = failSelection(current, `Generation failed: ${result.message}`);
    } else {
      const generated = this.candidateFromResult(result);
      if (!generated || this.candidateIdExistsInRound(current, generated.id)) {
        terminal = failSelection(
          current,
          "Generation failed: Challenger result is invalid or collides with the current round",
        );
      } else {
        try {
          await this.assetVerifier.verify(result.asset);
          terminal = completeSelection(current, generated);
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Asset verification failed";
          terminal = failSelection(
            current,
            `Generation failed: Asset verification failed: ${message}`,
          );
        }
      }
    }

    const awaitingCleanup = {
      ...terminal,
      mailboxCleanupJobId: pending.generationJobId,
    };
    await this.gameRepository.save(awaitingCleanup);
    await this.mailbox.archive(pending.generationJobId);
    const cleaned = this.withoutCleanupMarker(awaitingCleanup);
    await this.gameRepository.save(cleaned);
    return cleaned;
  }

  private legacyGenerationJob(state: GameState): GenerationJob {
    const pending = state.pendingSelection;
    if (pending?.kind !== "generation") {
      throw new Error("No pending generation can be enqueued");
    }
    return {
      id: pending.generationJobId,
      kind: "challenger",
      createdAt: pending.selectedAt,
      roundNumber: state.round.roundNumber,
      winnerSide: pending.winnerSide,
      retainedWinner: candidateAt(state.round, pending.winnerSide),
      rejectedCandidate: candidateAt(
        state.round,
        oppositeSide(pending.winnerSide),
      ),
      selectionHistory: state.history.slice(-12),
      recentConcepts: recentConcepts(state, 10),
      preferenceSeed: state.preferenceSeed,
    };
  }

  private candidateIdExistsInRound(state: GameState, candidateId: string) {
    return (
      state.round.leftCandidate.id === candidateId ||
      state.round.rightCandidate.id === candidateId
    );
  }

  private withoutCleanupMarker(state: GameState): GameState {
    const cleaned = { ...state };
    delete cleaned.mailboxCleanupJobId;
    return cleaned;
  }
}
