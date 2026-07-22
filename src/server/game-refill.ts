import {
  summarizeLeaderboardPreferenceEvidence,
  type ChallengerState,
  type LeaderboardVisualProfile,
  type RefillJobRecord,
} from "@/domain/challenger-state";
import {
  candidateAt,
  oppositeSide,
  preferenceProfileFromSeed,
  recentConcepts,
  type Candidate,
  type GameState,
  type Side,
} from "@/domain/game";
import { drawPromptCard } from "@/domain/prompt-deck";
import type { GenerationJob } from "./agent-mailbox";

export interface RefillContext {
  game: GameState;
  winnerSide: Side;
  retainedWinner: Candidate;
  rejectedCandidate: Candidate;
  comparisonOutcome?: "tie" | "both-lose";
}

export interface RefillCapacityResult {
  state: ChallengerState;
  jobs: GenerationJob[];
}

interface RefillPlanningOptions {
  bufferTarget: number;
  leaderboardVisualProfile?: LeaderboardVisualProfile;
  createId: () => string;
  now: () => string;
  random: () => number;
}

export function planRefillCapacity(
  state: ChallengerState,
  context: RefillContext,
  options: RefillPlanningOptions,
): RefillCapacityResult {
  const jobs: GenerationJob[] = [];
  const records: RefillJobRecord[] = [];
  const deficit = Math.max(
    0,
    options.bufferTarget - state.ready.length - state.refillJobs.length,
  );

  for (let index = 0; index < deficit; index += 1) {
    const id = options.createId();
    if (
      state.refillJobs.some(({ jobId }) => jobId === id) ||
      records.some(({ jobId }) => jobId === id)
    ) {
      throw new Error(`Duplicate refill job ID ${id}`);
    }
    const createdAt = options.now();
    const promptCard = drawPromptCard(context.game.promptDeck, options.random);
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
      ...(options.leaderboardVisualProfile
        ? { leaderboardVisualProfile: options.leaderboardVisualProfile }
        : {}),
      preferenceSeed: context.game.preferenceSeed,
      preferenceProfile:
        context.game.preferenceProfile ??
        preferenceProfileFromSeed(context.game.preferenceSeed),
      ...(promptCard ? { promptCard } : {}),
      ...(context.game.variationSource
        ? { variationSource: context.game.variationSource }
        : {}),
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

export function refillContext(
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

export function validRefillWork(
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

export function withoutRefillRecord(
  state: ChallengerState,
  jobId: string,
): ChallengerState {
  return {
    ...state,
    refillJobs: state.refillJobs.filter((record) => record.jobId !== jobId),
  };
}
