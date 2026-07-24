import { isDeepStrictEqual } from "node:util";
import type {
  ChallengerState,
  LeaderboardVisualProfile,
} from "@/domain/challenger-state";
import type { GameState } from "@/domain/game";
import type { ChallengerRepository } from "./challenger-repository";
import type { LeaderboardProfileCoordinator } from "./leaderboard-profile-service";

interface LeaderboardProfileReconcilerOptions {
  repository: ChallengerRepository;
  coordinator?: LeaderboardProfileCoordinator;
  createId: () => string;
  now: () => string;
}

export class LeaderboardProfileReconciler {
  constructor(private readonly options: LeaderboardProfileReconcilerOptions) {}

  async reconcile(
    game: GameState,
    state: ChallengerState,
  ): Promise<ChallengerState> {
    const coordinator = this.options.coordinator;
    if (!coordinator) return state;

    let next = state;
    const record = next.leaderboardProfileJob;
    if (record) {
      const [work, result] = await Promise.all([
        coordinator.readWork(record.jobId),
        coordinator.readResult(record.jobId),
      ]);
      if (!result) {
        if (!work) await this.ensureEnqueued(record.expectedJob);
        else if (!isDeepStrictEqual(work, record.expectedJob)) {
          await coordinator.archive(record.jobId);
          next = {
            ...next,
            leaderboardProfileJob: null,
            leaderboardProfileAttemptedFingerprint: null,
          };
          await this.options.repository.save(next);
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
      await this.options.repository.save(next);
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

    const id = this.options.createId();
    const createdAt = this.options.now();
    let job: Parameters<LeaderboardProfileCoordinator["enqueue"]>[0];
    try {
      job = await coordinator.prepare(id, createdAt, desired);
    } catch (error) {
      console.warn("Leaderboard visual analysis could not be prepared", error);
      next = {
        ...next,
        leaderboardProfileAttemptedFingerprint: desired.fingerprint,
      };
      await this.options.repository.save(next);
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
    await this.options.repository.save(next);
    await this.ensureEnqueued(job);
    return next;
  }

  current(
    state: ChallengerState,
    game: GameState,
  ): LeaderboardVisualProfile | undefined {
    if ((game.preferenceProfile?.adaptationMode ?? "static") !== "adaptive") {
      return undefined;
    }
    const desired = this.options.coordinator?.desired(state);
    const visualProfile = state.leaderboardVisualProfile ?? undefined;
    return desired && visualProfile?.fingerprint === desired.fingerprint
      ? visualProfile
      : undefined;
  }

  private async ensureEnqueued(
    job: Parameters<LeaderboardProfileCoordinator["enqueue"]>[0],
  ): Promise<void> {
    const coordinator = this.options.coordinator;
    if (!coordinator) return;
    try {
      await coordinator.enqueue(job);
    } catch (error) {
      const work = await coordinator.readWork(job.id);
      if (work && isDeepStrictEqual(work, job)) return;
      throw error;
    }
  }
}
