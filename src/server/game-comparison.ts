import {
  admitGeneratedCandidate,
  updateElo,
  type CandidateRating,
  type ChallengerState,
  type PendingComparisonReceipt,
  type ReusableCandidateSource,
} from "@/domain/challenger-state";
import {
  candidateAt,
  oppositeSide,
  type Candidate,
  type GameState,
  type Side,
} from "@/domain/game";

export interface ComparisonRatingConfig {
  initialRating: number;
  eloKFactor: number;
  poolMaximum: number;
}

const reusableCandidateSources = new Set<ReusableCandidateSource>([
  "curated",
  "generated",
]);

export function candidateSource(candidate: Candidate): ReusableCandidateSource {
  return candidate.imageUrl.startsWith("/seed-assets/")
    ? "curated"
    : "generated";
}

export function createCandidateRating(
  candidate: Candidate,
  source: ReusableCandidateSource,
  poolMember: boolean,
  initialRating: number,
): CandidateRating {
  if (!reusableCandidateSources.has(source)) {
    throw new Error("Imported ratings require an import item ID");
  }
  return {
    candidate,
    rating: initialRating,
    wins: 0,
    losses: 0,
    source,
    importItemId: null,
    poolMember,
    poolEligible: true,
    lastServedAt: null,
  };
}

function ensureRated(
  ratings: CandidateRating[],
  candidate: Candidate,
  initialRating: number,
): CandidateRating[] {
  if (ratings.some((item) => item.candidate.id === candidate.id)) {
    return ratings;
  }
  const source = candidateSource(candidate);
  return [
    ...ratings,
    createCandidateRating(
      candidate,
      source,
      source === "curated",
      initialRating,
    ),
  ];
}

export function recordComparison(
  state: ChallengerState,
  winner: Candidate,
  loser: Candidate,
  receipt: PendingComparisonReceipt,
  config: ComparisonRatingConfig,
): ChallengerState {
  let ratings = ensureRated(state.ratings, winner, config.initialRating);
  ratings = ensureRated(ratings, loser, config.initialRating);

  const ratedWinner = ratings.find(
    ({ candidate }) => candidate.id === winner.id,
  )!;
  const ratedLoser = ratings.find(
    ({ candidate }) => candidate.id === loser.id,
  )!;
  const nextRatings = updateElo(
    ratedWinner.rating,
    ratedLoser.rating,
    config.eloKFactor,
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
    config.poolMaximum,
  );
  return admitGeneratedCandidate(withLoser, winner.id, config.poolMaximum);
}

export function recordTie(
  state: ChallengerState,
  left: Candidate,
  right: Candidate,
  receipt: PendingComparisonReceipt,
  config: ComparisonRatingConfig,
): ChallengerState {
  let ratings = ensureRated(state.ratings, left, config.initialRating);
  ratings = ensureRated(ratings, right, config.initialRating);

  const ratedLeft = ratings.find(({ candidate }) => candidate.id === left.id)!;
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
      ? updateElo(lower.rating, higher.rating, config.eloKFactor).winner
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
    config.poolMaximum,
  );
  return admitGeneratedCandidate(withLeft, right.id, config.poolMaximum);
}

export function recordBothLose(
  state: ChallengerState,
  left: Candidate,
  right: Candidate,
  receipt: PendingComparisonReceipt,
  initialRating: number,
): ChallengerState {
  let ratings = ensureRated(state.ratings, left, initialRating);
  ratings = ensureRated(ratings, right, initialRating);
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

export function tieReferenceSide(
  game: GameState,
  state: ChallengerState,
  initialRating: number,
): Side {
  const leftRating =
    state.ratings.find(
      ({ candidate }) => candidate.id === game.round.leftCandidate.id,
    )?.rating ?? initialRating;
  const rightRating =
    state.ratings.find(
      ({ candidate }) => candidate.id === game.round.rightCandidate.id,
    )?.rating ?? initialRating;
  return rightRating < leftRating ? "right" : "left";
}

export function comparisonReceipt(
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
