import { isDeepStrictEqual } from "node:util";
import type { ChallengerState } from "@/domain/challenger-state";
import type { Candidate, GameStartState, GameState } from "@/domain/game";
import type {
  GenerationJob,
  GenerationMailbox,
  GenerationResult,
} from "./agent-mailbox";
import type {
  InitialBootstrap,
  InitialBootstrapRepository,
} from "./initial-bootstrap";
import type { AssetStore } from "./providers";
import { challengerConfig } from "./challenger-config";
import type { ChallengerRepository } from "./challenger-repository";
import type { GameRepository } from "./repository";

export interface InitialGameServiceOptions {
  gameRepository: GameRepository;
  challengerRepository: ChallengerRepository;
  bootstrapRepository: InitialBootstrapRepository;
  mailbox: GenerationMailbox;
  assetVerifier: Pick<AssetStore, "verify">;
  seedState: (now: string) => Promise<GameState | null>;
  curatedCandidates: (now: string) => Promise<readonly Candidate[]>;
  initialContext: (now: string) => [Candidate, Candidate];
  preferenceSeed: string;
  now?: () => string;
  createId?: () => string;
  random?: () => number;
}

export class InitialGameService {
  private readonly now: () => string;
  private readonly createId: () => string;
  private readonly random: () => number;

  constructor(private readonly options: InitialGameServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.random = options.random ?? Math.random;
  }

  async getOrCreate(): Promise<GameStartState> {
    return this.options.gameRepository.withLock(async () => {
      const game = await this.options.gameRepository.load();
      if (game) {
        await this.cleanupBootstrap();
        return { status: "ready", game };
      }

      const bootstrap = await this.options.bootstrapRepository.load();
      if (bootstrap) return this.reconcile(bootstrap);

      const createdAt = this.now();
      return this.options.challengerRepository.withLock(async () =>
        this.createNewSession(createdAt),
      );
    });
  }

  async retry(): Promise<GameStartState> {
    return this.reset();
  }

  async reset(): Promise<GameStartState> {
    return this.options.gameRepository.withLock(async () => {
      const game = await this.options.gameRepository.load();
      if (game?.round.status === "generating") {
        throw new Error("A challenger is already being generated");
      }

      await this.cleanupBootstrap();
      return this.options.challengerRepository.withLock(async () => {
        const previous = await this.options.challengerRepository.load();
        await this.archiveRefillJobs(previous);
        await this.options.gameRepository.clear();
        return this.createNewSession(this.now(), previous, true);
      });
    });
  }

  private async createNewSession(
    createdAt: string,
    knownPrevious?: ChallengerState | null,
    refillJobsArchived = false,
  ): Promise<GameStartState> {
    const previous =
      knownPrevious === undefined
        ? await this.options.challengerRepository.load()
        : knownPrevious;
    if (!refillJobsArchived) await this.archiveRefillJobs(previous);

    const candidates = await this.options.curatedCandidates(createdAt);
    if (candidates.length > 0) {
      return this.createCuratedGame(createdAt, candidates, previous);
    }

    if (previous) {
      await this.options.challengerRepository.save(
        this.challengerState(createdAt, [], previous),
      );
    }
    const seeded = await this.options.seedState(createdAt);
    if (seeded) {
      await this.options.gameRepository.save(seeded);
      return { status: "ready", game: seeded };
    }
    return this.createBootstrap(createdAt);
  }

  private async createCuratedGame(
    createdAt: string,
    candidates: readonly Candidate[],
    previous: ChallengerState | null,
  ): Promise<GameStartState> {
    const selected = this.selectSeven(candidates);
    const [leftCandidate, rightCandidate, ...readyCandidates] = selected;
    const game: GameState = {
      round: {
        leftCandidate,
        rightCandidate,
        status: "idle",
        replacingSide: null,
        roundNumber: 1,
        retainedCandidateId: null,
        winStreak: 0,
      },
      history: [],
      preferenceSeed: this.options.preferenceSeed,
    };
    const challengerState = this.challengerState(
      createdAt,
      readyCandidates,
      previous,
      selected,
    );

    await this.options.challengerRepository.save(challengerState);
    await this.options.gameRepository.save(game);
    return { status: "ready", game };
  }

  private challengerState(
    createdAt: string,
    readyCandidates: readonly Candidate[],
    previous: ChallengerState | null,
    ratedCandidates: readonly Candidate[] = [],
  ): ChallengerState {
    const ratedIds = new Set(
      previous?.ratings.map(({ candidate }) => candidate.id) ?? [],
    );
    const newRatings = ratedCandidates
      .filter((candidate) => !ratedIds.has(candidate.id))
      .map((candidate) => ({
        candidate,
        rating: challengerConfig.initialRating,
        wins: 0,
        losses: 0,
        source: "curated" as const,
        poolMember: true,
        lastServedAt: null,
      }));

    return {
      version: 1,
      sessionId: this.createId(),
      ready: readyCandidates.map((candidate) => ({
        candidate,
        source: "seed",
        pinnedWinnerId: null,
        enqueuedAt: createdAt,
      })),
      refillJobs: [],
      ratings: [...(previous?.ratings ?? []), ...newRatings],
      generationTurnaroundEmaMs:
        previous?.generationTurnaroundEmaMs ??
        challengerConfig.initialTurnaroundMs,
      consecutiveFallbackDraws: 0,
      nextFallbackAt: null,
    };
  }

  private selectSeven(candidates: readonly Candidate[]): Candidate[] {
    const distinct = [
      ...new Map(candidates.map((item) => [item.id, item])).values(),
    ];
    if (distinct.length < 7) {
      throw new Error(
        `At least seven distinct curated candidates are required; received ${distinct.length}`,
      );
    }

    for (let index = distinct.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.min(
        Math.floor(Math.max(0, this.random()) * (index + 1)),
        index,
      );
      [distinct[index], distinct[randomIndex]] = [
        distinct[randomIndex],
        distinct[index],
      ];
    }
    return distinct.slice(0, 7);
  }

  private async archiveRefillJobs(
    state: ChallengerState | null,
  ): Promise<void> {
    if (!state) return;
    for (const { jobId } of state.refillJobs) {
      await this.options.mailbox.archive(jobId);
    }
  }

  private async createBootstrap(createdAt: string): Promise<GameStartState> {
    const bootstrap: InitialBootstrap = {
      batchId: this.createId(),
      createdAt,
      preferenceSeed: this.options.preferenceSeed,
      jobs: [
        { id: this.createId(), side: "left" },
        { id: this.createId(), side: "right" },
      ],
    };
    await this.options.bootstrapRepository.save(bootstrap);
    await this.ensureJobs(bootstrap);
    return this.initializing(bootstrap);
  }

  private async reconcile(
    bootstrap: InitialBootstrap,
  ): Promise<GameStartState> {
    const results = await Promise.all(
      bootstrap.jobs.map(({ id }) => this.options.mailbox.readResult(id)),
    );
    const failure = results.find(
      (result): result is Extract<GenerationResult, { status: "failed" }> =>
        result?.status === "failed",
    );
    if (failure) {
      return {
        status: "initialization-error",
        batchId: bootstrap.batchId,
        preferenceSeed: bootstrap.preferenceSeed,
        errorMessage: `Initial generation failed: ${failure.message}`,
      };
    }

    if (results.some((result) => result === null)) {
      await this.ensureJobs(bootstrap);
      return this.initializing(bootstrap);
    }

    const completed = results as [
      Extract<GenerationResult, { status: "completed" }>,
      Extract<GenerationResult, { status: "completed" }>,
    ];
    const expectedJobs = this.jobsFor(bootstrap);
    for (let index = 0; index < expectedJobs.length; index += 1) {
      const expected = expectedJobs[index];
      const actual = await this.options.mailbox.readWork(expected.id);
      if (!actual || !isDeepStrictEqual(actual, expected)) {
        return this.failed(
          bootstrap,
          "Initial generation failed: Work metadata does not match the persisted bootstrap",
        );
      }
      const result = completed[index];
      if (result.jobId !== expected.id) {
        return this.failed(
          bootstrap,
          "Initial generation failed: Result metadata does not match the persisted bootstrap",
        );
      }
      const expectedCandidateId = `challenger-${expected.id}`;
      if (result.asset.candidateId !== expectedCandidateId) {
        return this.failed(
          bootstrap,
          `Initial generation failed: Candidate ID must equal ${expectedCandidateId}`,
        );
      }
      try {
        await this.options.assetVerifier.verify(result.asset);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Asset verification failed";
        return this.failed(
          bootstrap,
          `Initial generation failed: Asset verification failed: ${message}`,
        );
      }
    }

    if (completed[0].asset.candidateId === completed[1].asset.candidateId) {
      return this.failed(
        bootstrap,
        "Initial generation failed: Initial candidates must be distinct",
      );
    }

    const game: GameState = {
      round: {
        leftCandidate: this.candidateFrom(completed[0]),
        rightCandidate: this.candidateFrom(completed[1]),
        status: "idle",
        replacingSide: null,
        roundNumber: 1,
        retainedCandidateId: null,
        winStreak: 0,
      },
      history: [],
      preferenceSeed: bootstrap.preferenceSeed,
    };
    await this.options.gameRepository.save(game);
    await this.cleanupBootstrap();
    return { status: "ready", game };
  }

  private jobsFor(bootstrap: InitialBootstrap): [GenerationJob, GenerationJob] {
    const [leftContext, rightContext] = this.options.initialContext(
      bootstrap.createdAt,
    );
    const recentConcepts = [leftContext.concept, rightContext.concept];
    const makeJob = (index: 0 | 1): GenerationJob => {
      const bootstrapJob = bootstrap.jobs[index];
      const retainedWinner = index === 0 ? leftContext : rightContext;
      const rejectedCandidate = index === 0 ? rightContext : leftContext;
      return {
        id: bootstrapJob.id,
        kind: "initial",
        batchId: bootstrap.batchId,
        initialSide: bootstrapJob.side,
        createdAt: bootstrap.createdAt,
        roundNumber: 1,
        winnerSide: bootstrapJob.side,
        retainedWinner,
        rejectedCandidate,
        selectionHistory: [],
        recentConcepts,
        preferenceSeed: bootstrap.preferenceSeed,
      };
    };
    return [makeJob(0), makeJob(1)];
  }

  private async ensureJobs(bootstrap: InitialBootstrap): Promise<void> {
    for (const job of this.jobsFor(bootstrap)) {
      const existing = await this.options.mailbox.readWork(job.id);
      if (existing) {
        if (!isDeepStrictEqual(existing, job)) {
          throw new Error(
            `Initial generation job ${job.id} does not match its bootstrap`,
          );
        }
        continue;
      }
      try {
        await this.options.mailbox.enqueue(job);
      } catch (error) {
        const published = await this.options.mailbox.readWork(job.id);
        if (published && isDeepStrictEqual(published, job)) continue;
        throw error;
      }
    }
  }

  private candidateFrom(
    result: Extract<GenerationResult, { status: "completed" }>,
  ): Candidate {
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

  private initializing(bootstrap: InitialBootstrap): GameStartState {
    return {
      status: "initializing",
      batchId: bootstrap.batchId,
      preferenceSeed: bootstrap.preferenceSeed,
    };
  }

  private failed(
    bootstrap: InitialBootstrap,
    errorMessage: string,
  ): GameStartState {
    return {
      status: "initialization-error",
      batchId: bootstrap.batchId,
      preferenceSeed: bootstrap.preferenceSeed,
      errorMessage,
    };
  }

  private async cleanupBootstrap(): Promise<void> {
    const bootstrap = await this.options.bootstrapRepository.load();
    if (!bootstrap) return;
    await Promise.all(
      bootstrap.jobs.map(({ id }) => this.options.mailbox.archive(id)),
    );
    await this.options.bootstrapRepository.clear();
  }
}
