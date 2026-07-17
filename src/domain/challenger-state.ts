import type { BufferHealth, Candidate, SelectionHistory, Side } from "./game";

const DEFAULT_POOL_MAXIMUM = 50;
const DEFAULT_READY_TARGET = 5;
const DEFAULT_TURNAROUND_ALPHA = 0.25;
const MAX_CONSECUTIVE_FALLBACK_DRAWS = 2;
const MIN_FALLBACK_COOLDOWN_MS = 30_000;
const MAX_FALLBACK_COOLDOWN_MS = 300_000;

export interface CandidateRating {
  candidate: Candidate;
  rating: number;
  wins: number;
  losses: number;
  source: "curated" | "generated";
  poolMember: boolean;
  lastServedAt: string | null;
}

export interface BufferedCandidate {
  candidate: Candidate;
  source: "seed" | "generated";
  pinnedWinnerId: string | null;
  enqueuedAt: string;
}

export interface RefillJobRecord {
  jobId: string;
  pinnedWinnerId: string;
  enqueuedAt: string;
  expectedJob: RefillGenerationJobSnapshot;
}

export interface RefillGenerationJobSnapshot {
  id: string;
  kind: "refill";
  createdAt: string;
  roundNumber: number;
  winnerSide: Side;
  retainedWinner: Candidate;
  rejectedCandidate: Candidate;
  selectionHistory: SelectionHistory[];
  recentConcepts: string[];
  preferenceSeed: string;
  sessionId: string;
  pinnedWinnerId: string;
}

export interface PendingComparisonReceipt {
  selectedAt: string;
  roundNumber: number;
  winnerSide: Side;
  winnerId: string;
  loserId: string;
}

export interface ChallengerState {
  version: 1;
  sessionId: string;
  ready: BufferedCandidate[];
  refillJobs: RefillJobRecord[];
  pendingComparison: PendingComparisonReceipt | null;
  ratings: CandidateRating[];
  generationTurnaroundEmaMs: number;
  consecutiveFallbackDraws: number;
  nextFallbackAt: string | null;
}

export interface EloUpdate {
  winner: number;
  loser: number;
}

export interface CandidateDraw {
  candidate: Candidate | null;
  state: ChallengerState;
}

export interface FallbackDrawOptions {
  now: string;
  currentCandidateIds: readonly string[];
  recentCandidateIds: readonly string[];
  random: () => number;
  minimumCooldownMs?: number;
  maximumCooldownMs?: number;
  maximumConsecutiveDraws?: number;
}

export function summarizeBufferHealth(
  state: ChallengerState | null,
  target = DEFAULT_READY_TARGET,
  poolMaximum = DEFAULT_POOL_MAXIMUM,
): BufferHealth {
  return {
    ready: state?.ready.length ?? 0,
    inFlight: state?.refillJobs.length ?? 0,
    target,
    pool: state?.ratings.filter((item) => item.poolMember).length ?? 0,
    poolMaximum,
  };
}

function roundRating(rating: number): number {
  return Math.round(rating * 1_000_000) / 1_000_000;
}

export function updateElo(
  winnerRating: number,
  loserRating: number,
  kFactor: number,
): EloUpdate {
  const expectedWinner = 1 / (1 + 10 ** ((loserRating - winnerRating) / 400));
  const adjustment = kFactor * (1 - expectedWinner);

  return {
    winner: roundRating(winnerRating + adjustment),
    loser: roundRating(loserRating - adjustment),
  };
}

export function admitGeneratedCandidate(
  state: ChallengerState,
  candidateId: string,
  poolMaximum = DEFAULT_POOL_MAXIMUM,
): ChallengerState {
  const configuredMaximum = Number.isFinite(poolMaximum)
    ? Math.floor(poolMaximum)
    : DEFAULT_POOL_MAXIMUM;
  const effectiveMaximum = Math.min(
    DEFAULT_POOL_MAXIMUM,
    Math.max(0, configuredMaximum),
  );
  const rankedMembers = state.ratings
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.poolMember)
    .sort(
      (left, right) =>
        left.item.rating - right.item.rating || left.index - right.index,
    );
  const excessCount = Math.max(0, rankedMembers.length - effectiveMaximum);
  const excessMembers = new Set(
    rankedMembers.slice(0, excessCount).map(({ item }) => item),
  );
  const repairedRatings =
    excessMembers.size === 0
      ? state.ratings
      : state.ratings.map((item) =>
          excessMembers.has(item) ? { ...item, poolMember: false } : item,
        );
  const repairedState =
    repairedRatings === state.ratings
      ? state
      : { ...state, ratings: repairedRatings };
  const candidate = repairedRatings.find(
    (item) => item.candidate.id === candidateId,
  );
  if (!candidate || candidate.source !== "generated" || candidate.poolMember) {
    return repairedState;
  }

  const poolMembers = repairedRatings.filter((item) => item.poolMember);
  if (poolMembers.length < effectiveMaximum) {
    return {
      ...repairedState,
      ratings: repairedRatings.map((item) =>
        item === candidate ? { ...item, poolMember: true } : item,
      ),
    };
  }

  if (effectiveMaximum === 0) return repairedState;

  const lowestRated = poolMembers.reduce((lowest, item) =>
    item.rating < lowest.rating ? item : lowest,
  );
  if (candidate.rating <= lowestRated.rating) return repairedState;

  return {
    ...repairedState,
    ratings: repairedRatings.map((item) => {
      if (item === candidate) return { ...item, poolMember: true };
      if (item === lowestRated) return { ...item, poolMember: false };
      return item;
    }),
  };
}

export function backfillGeneratedPool(
  state: ChallengerState,
  poolMaximum = DEFAULT_POOL_MAXIMUM,
): ChallengerState {
  return state.ratings
    .filter((item) => item.source === "generated" && !item.poolMember)
    .map((item, index) => ({ item, index }))
    .sort(
      (left, right) =>
        right.item.rating - left.item.rating || left.index - right.index,
    )
    .reduce(
      (current, { item }) =>
        admitGeneratedCandidate(current, item.candidate.id, poolMaximum),
      state,
    );
}

export function popReady(state: ChallengerState): CandidateDraw {
  const [next, ...remaining] = state.ready;
  if (!next) return { candidate: null, state };

  return {
    candidate: next.candidate,
    state: {
      ...state,
      ready: remaining,
      consecutiveFallbackDraws: 0,
      nextFallbackAt: null,
    },
  };
}

export function drawFallback(
  state: ChallengerState,
  options: FallbackDrawOptions,
): CandidateDraw {
  if (
    state.consecutiveFallbackDraws >=
      (options.maximumConsecutiveDraws ?? MAX_CONSECUTIVE_FALLBACK_DRAWS) ||
    (state.nextFallbackAt !== null &&
      Date.parse(options.now) < Date.parse(state.nextFallbackAt))
  ) {
    return { candidate: null, state };
  }

  const excludedIds = new Set([
    ...options.currentCandidateIds,
    ...options.recentCandidateIds,
  ]);
  const eligible = state.ratings.filter(
    (item) => item.poolMember && !excludedIds.has(item.candidate.id),
  );
  if (eligible.length === 0) return { candidate: null, state };

  const index = Math.min(
    Math.floor(options.random() * eligible.length),
    eligible.length - 1,
  );
  const selected = eligible[index];
  const cooldownMs = Math.min(
    options.maximumCooldownMs ?? MAX_FALLBACK_COOLDOWN_MS,
    Math.max(
      options.minimumCooldownMs ?? MIN_FALLBACK_COOLDOWN_MS,
      state.generationTurnaroundEmaMs * 0.5,
    ),
  );
  const nextFallbackAt = new Date(
    Date.parse(options.now) + cooldownMs,
  ).toISOString();

  return {
    candidate: selected.candidate,
    state: {
      ...state,
      ratings: state.ratings.map((item) =>
        item === selected ? { ...item, lastServedAt: options.now } : item,
      ),
      consecutiveFallbackDraws: state.consecutiveFallbackDraws + 1,
      nextFallbackAt,
    },
  };
}

export function recordGenerationTurnaround(
  state: ChallengerState,
  enqueuedAt: string,
  completedAt: string,
  alpha = DEFAULT_TURNAROUND_ALPHA,
): ChallengerState {
  const turnaroundMs = Date.parse(completedAt) - Date.parse(enqueuedAt);
  if (!Number.isFinite(turnaroundMs) || turnaroundMs < 0) return state;

  return {
    ...state,
    generationTurnaroundEmaMs: Math.round(
      alpha * turnaroundMs + (1 - alpha) * state.generationTurnaroundEmaMs,
    ),
  };
}

export function refillDeficit(
  state: ChallengerState,
  readyTarget = DEFAULT_READY_TARGET,
): number {
  return Math.max(
    0,
    readyTarget - state.ready.length - state.refillJobs.length,
  );
}
