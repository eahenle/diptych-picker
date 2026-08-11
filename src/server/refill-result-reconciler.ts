import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  recordGenerationTurnaround,
  refillJobMatchesGenerationPreferences,
  type ChallengerState,
  type RefillJobRecord,
} from "@/domain/challenger-state";
import type { Candidate, GameState } from "@/domain/game";
import type {
  GenerationJob,
  GenerationMailbox,
  GenerationResult,
} from "./agent-mailbox";
import type { ChallengerRepository } from "./challenger-repository";
import { createCandidateRating } from "./game-comparison";
import { validRefillWork, withoutRefillRecord } from "./game-refill";
import type { AssetStore } from "./providers";
import type { GameRepository } from "./repository";
import type { LockedStateContext } from "./state-lock-coordinator";

interface RefillObservation {
  record: RefillJobRecord;
  work: GenerationJob | null;
  result: GenerationResult | null;
  recordIndex: number;
}

interface RefillResultReconcilerOptions {
  gameRepository: GameRepository;
  challengerRepository: ChallengerRepository;
  mailbox: GenerationMailbox;
  assetVerifier: Pick<AssetStore, "verify">;
  initialRating: number;
  turnaroundEmaAlpha: number;
  ensureEnqueued: (job: GenerationJob) => Promise<void>;
  completePreparedSelection: (
    game: GameState,
    challengers: ChallengerState,
    lockContext?: LockedStateContext,
  ) => Promise<{ game: GameState; challengers: ChallengerState }>;
  removeDisplayedCandidatesFromReady: (
    game: GameState,
    challengers: ChallengerState,
  ) => Promise<ChallengerState>;
}

export class RefillResultReconciler {
  constructor(private readonly options: RefillResultReconcilerOptions) {}

  async reconcile(
    initialGame: GameState,
    initialChallengers: ChallengerState,
    lockContext?: LockedStateContext,
  ): Promise<{ game: GameState; challengers: ChallengerState }> {
    let game = initialGame;
    let challengers = initialChallengers;
    const observations = await Promise.all(
      challengers.refillJobs.map(async (record, recordIndex) => {
        const [work, result] = await Promise.all([
          this.options.mailbox.readWork(record.jobId),
          this.options.mailbox.readResult(record.jobId),
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
      const outcome = await this.reconcileRecord(
        game,
        challengers,
        observation,
        lockContext,
      );
      game = outcome.game;
      challengers = outcome.challengers;
    }
    return { game, challengers };
  }

  private async reconcileRecord(
    game: GameState,
    challengers: ChallengerState,
    observation: RefillObservation,
    lockContext?: LockedStateContext,
  ): Promise<{ game: GameState; challengers: ChallengerState }> {
    const { record, work, result } = observation;
    const expected = record.expectedJob;

    if (!refillJobMatchesGenerationPreferences(expected, game)) {
      // Let an already-owned stale request terminate before archiving it; its
      // result must never enter capacity for the newer preference profile.
      if (work && !result) return { game, challengers };
      return {
        game,
        challengers: await this.archiveInvalid(challengers, record),
      };
    }

    if (!result) {
      if (!work) {
        await this.options.ensureEnqueued(expected);
        return { game, challengers };
      }
      if (
        !validRefillWork(work, record, challengers.sessionId) ||
        !isDeepStrictEqual(work, expected)
      ) {
        return {
          game,
          challengers: await this.archiveInvalid(challengers, record),
        };
      }
      return { game, challengers };
    }

    if (
      result.jobId !== record.jobId ||
      !work ||
      !validRefillWork(work, record, challengers.sessionId) ||
      !isDeepStrictEqual(work, expected)
    ) {
      return {
        game,
        challengers: await this.archiveInvalid(challengers, record),
      };
    }

    if (result.status === "failed") {
      let notifiedGame = game;
      if (isModerationGenerationFailure(result)) {
        notifiedGame = {
          ...game,
          generationNotice: {
            kind: "moderation-block",
            jobId: result.jobId,
            occurredAt: result.completedAt,
            occurrenceCount: (game.generationNotice?.occurrenceCount ?? 0) + 1,
          },
        };
        await this.options.gameRepository.save(notifiedGame);
      }
      return {
        game: notifiedGame,
        challengers: await this.archiveInvalid(challengers, record),
      };
    }

    const generated = candidateFromGenerationResult(result, expected);
    if (!generated) {
      return {
        game,
        challengers: await this.archiveInvalid(challengers, record),
      };
    }

    const existingRating = challengers.ratings.find(
      ({ candidate }) => candidate.id === generated.id,
    );
    if (existingRating) {
      if (!isDeepStrictEqual(existingRating.candidate, generated)) {
        return {
          game,
          challengers: await this.archiveInvalid(challengers, record),
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
          challengers: await this.archiveInvalid(challengers, record),
        };
      }

      const replayed = await this.options.completePreparedSelection(
        game,
        challengers,
        lockContext,
      );
      game = replayed.game;
      challengers = await this.options.removeDisplayedCandidatesFromReady(
        replayed.game,
        replayed.challengers,
      );
      await this.options.mailbox.archive(record.jobId);
      const cleaned = withoutRefillRecord(challengers, record.jobId);
      await this.options.challengerRepository.save(cleaned);
      return { game, challengers: cleaned };
    }

    if (candidateIdExists(challengers, game, generated.id)) {
      return {
        game,
        challengers: await this.archiveInvalid(challengers, record),
      };
    }

    try {
      await this.options.assetVerifier.verify(result.asset);
    } catch {
      return {
        game,
        challengers: await this.archiveInvalid(challengers, record),
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
            importItemId: null,
            pinnedWinnerId: record.pinnedWinnerId,
            enqueuedAt: result.completedAt,
          },
        ],
        ratings: [
          ...challengers.ratings,
          createCandidateRating(
            generated,
            "generated",
            false,
            this.options.initialRating,
          ),
        ],
      },
      record.enqueuedAt,
      result.completedAt,
      this.options.turnaroundEmaAlpha,
    );

    // Persist admission before cleanup so the rating proves this result was
    // already applied if terminal archival fails and reconciliation retries.
    await this.options.challengerRepository.save(applied);
    const replayed = await this.options.completePreparedSelection(
      game,
      applied,
      lockContext,
    );
    game = replayed.game;
    applied = replayed.challengers;
    await this.options.mailbox.archive(record.jobId);
    const cleaned = withoutRefillRecord(applied, record.jobId);
    await this.options.challengerRepository.save(cleaned);
    return { game, challengers: cleaned };
  }

  private async archiveInvalid(
    state: ChallengerState,
    record: RefillJobRecord,
  ): Promise<ChallengerState> {
    await this.options.mailbox.archive(record.jobId);
    const cleaned = withoutRefillRecord(state, record.jobId);
    await this.options.challengerRepository.save(cleaned);
    return cleaned;
  }
}

export function candidateFromGenerationResult(
  result: Extract<GenerationResult, { status: "completed" }>,
  expectedJob?: Pick<
    GenerationJob,
    "preferenceSeed" | "promptCard" | "variationSource"
  >,
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
    ...(expectedJob?.promptCard
      ? { promptCardId: expectedJob.promptCard.id }
      : {}),
    ...(expectedJob?.variationSource
      ? {
          lineage: {
            kind: "variation" as const,
            parentCandidateId: expectedJob.variationSource.candidateId,
            parentConcept: expectedJob.variationSource.concept,
            preferenceFingerprint: createHash("sha256")
              .update(expectedJob.preferenceSeed)
              .digest("hex"),
          },
        }
      : {}),
    createdAt: result.completedAt,
    winCount: 0,
  };
}

export function isModerationGenerationFailure(
  result: Extract<GenerationResult, { status: "failed" }>,
): boolean {
  return (
    result.category === "moderation" ||
    /moderation|content policy|safety (?:policy|filter)|blocked by (?:a )?(?:policy|safety)/i.test(
      result.message,
    )
  );
}

function candidateIdExists(
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
