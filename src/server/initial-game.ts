import { isDeepStrictEqual } from "node:util";
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
import type { GameRepository } from "./repository";

export interface InitialGameServiceOptions {
  gameRepository: GameRepository;
  bootstrapRepository: InitialBootstrapRepository;
  mailbox: GenerationMailbox;
  assetVerifier: Pick<AssetStore, "verify">;
  seedState: (now: string) => Promise<GameState | null>;
  initialContext: (now: string) => [Candidate, Candidate];
  preferenceSeed: string;
  now?: () => string;
  createId?: () => string;
}

export class InitialGameService {
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(private readonly options: InitialGameServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => crypto.randomUUID());
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
      const seeded = await this.options.seedState(createdAt);
      if (seeded) {
        await this.options.gameRepository.save(seeded);
        return { status: "ready", game: seeded };
      }
      return this.createBootstrap(createdAt);
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
      await this.options.gameRepository.clear();
      const createdAt = this.now();
      const seeded = await this.options.seedState(createdAt);
      if (seeded) {
        await this.options.gameRepository.save(seeded);
        return { status: "ready", game: seeded };
      }
      return this.createBootstrap(createdAt);
    });
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
