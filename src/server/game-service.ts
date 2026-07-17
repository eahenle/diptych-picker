import { isDeepStrictEqual } from "node:util";
import {
  drawFallback,
  popReady,
  promoteWinner,
  recordGenerationTurnaround,
  refillDeficit,
  updateElo,
  type BufferedCandidate,
  type CandidateRating,
  type ChallengerState,
  type PendingComparisonReceipt,
  type RefillJobRecord,
} from "@/domain/challenger-state";
import {
  beginBufferedSelection,
  candidateAt,
  completeSelection,
  failSelection,
  oppositeSide,
  recentConcepts,
  type Candidate,
  type GameState,
  type Side,
} from "@/domain/game";
import type {
  GenerationJob,
  GenerationMailbox,
  GenerationResult,
} from "./agent-mailbox";
import type { ChallengerRepository } from "./challenger-repository";
import { challengerConfig } from "./challenger-config";
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
  fallbackMinimumMs: number;
  fallbackMaximumMs: number;
  fallbackMaximumConsecutive: number;
}

interface RefillContext {
  game: GameState;
  winnerSide: Side;
  retainedWinner: Candidate;
  rejectedCandidate: Candidate;
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

  async updatePreferenceSeed(preferenceSeed: string): Promise<GameState> {
    return this.gameRepository.withLock(async () => {
      const current = await this.gameRepository.load();
      if (!current) {
        throw new MissingGameError("Start a game before editing preferences");
      }
      if (current.round.status === "generating") {
        throw new SelectionConflictError(
          "A challenger is already being generated",
        );
      }

      const updated = { ...current, preferenceSeed };
      await this.gameRepository.save(updated);
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
      const inFlight = beginBufferedSelection(current, winnerSide, selectedAt);
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
        challengerState,
        retainedWinner,
        rejectedCandidate,
        this.comparisonReceipt(current, winnerSide, selectedAt),
      );
      let preparedReadyHead: BufferedCandidate | null = null;
      let draw = popReady(nextChallengers);
      let nextGame = inFlight;
      if (draw.candidate) {
        preparedReadyHead = nextChallengers.ready[0];
        nextChallengers = draw.state;
        nextGame = completeSelection(inFlight, draw.candidate);
      } else {
        draw = this.drawFallback(nextChallengers, current);
        nextChallengers = draw.state;
        if (draw.candidate)
          nextGame = completeSelection(inFlight, draw.candidate);
      }

      const capacity = this.addRefillCapacity(nextChallengers, {
        game: nextGame,
        winnerSide,
        retainedWinner,
        rejectedCandidate,
      });
      const durableChallengers = preparedReadyHead
        ? {
            ...capacity.state,
            ready: [preparedReadyHead, ...capacity.state.ready],
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
        game = completeSelection(game, draw.candidate);
        await this.gameRepository.save(game);
        challengers = { ...challengers, pendingComparison: null };
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
      return {
        game,
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

  private addRefillCapacity(
    state: ChallengerState,
    context: RefillContext,
  ): CapacityResult {
    const jobs: GenerationJob[] = [];
    const records: RefillJobRecord[] = [];
    const deficit = refillDeficit(state, this.config.bufferTarget);

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
        preferenceSeed: context.game.preferenceSeed,
        sessionId: state.sessionId,
        pinnedWinnerId: context.retainedWinner.id,
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
    return promoteWinner(updated, winner.id, this.config.poolMaximum);
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
    if (
      game.round.status !== "generating" ||
      game.pendingSelection?.kind !== "buffer"
    ) {
      if (challengers.pendingComparison === null) return challengers;
      const cleaned = { ...challengers, pendingComparison: null };
      await this.challengerRepository.save(cleaned);
      return cleaned;
    }

    const receipt = this.comparisonReceipt(
      game,
      game.pendingSelection.winnerSide,
      game.pendingSelection.selectedAt,
    );
    if (isDeepStrictEqual(challengers.pendingComparison, receipt)) {
      return challengers;
    }
    if (challengers.pendingComparison !== null) {
      throw new Error(
        "Persisted comparison receipt does not match the pending selection",
      );
    }

    const compared = this.recordComparison(
      challengers,
      candidateAt(game.round, game.pendingSelection.winnerSide),
      candidateAt(game.round, oppositeSide(game.pendingSelection.winnerSide)),
      receipt,
    );
    await this.challengerRepository.save(compared);
    return compared;
  }

  private refillContext(
    game: GameState,
    challengers: ChallengerState,
  ): RefillContext | null {
    if (game.pendingSelection?.kind === "buffer") {
      const winnerSide = game.pendingSelection.winnerSide;
      return {
        game,
        winnerSide,
        retainedWinner: candidateAt(game.round, winnerSide),
        rejectedCandidate: candidateAt(game.round, oppositeSide(winnerSide)),
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
    const rejectedCandidate = lastSelection
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
    if (
      game.round.status !== "generating" ||
      game.pendingSelection?.kind !== "buffer"
    ) {
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

    const completed = completeSelection(game, draw.candidate);
    await this.gameRepository.save(completed);
    const finalized = { ...draw.state, pendingComparison: null };
    if (draw.state !== challengers || challengers.pendingComparison !== null) {
      await this.challengerRepository.save(finalized);
    }
    return { game: completed, challengers: finalized };
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
      .flatMap(({ winnerId, loserId }) => [winnerId, loserId]);
    return drawFallback(state, {
      now: this.now(),
      currentCandidateIds: [
        game.round.leftCandidate.id,
        game.round.rightCandidate.id,
      ],
      recentCandidateIds,
      random: this.random,
      minimumCooldownMs: this.config.fallbackMinimumMs,
      maximumCooldownMs: this.config.fallbackMaximumMs,
      maximumConsecutiveDraws: this.config.fallbackMaximumConsecutive,
    });
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
