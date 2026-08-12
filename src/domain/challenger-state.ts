import type {
  BufferHealth,
  Candidate,
  DisplayedEloRatings,
  GameState,
  PreferenceProfile,
  PreferenceRevision,
  SelectionHistory,
  Side,
} from "./game";
import type { ImportSupplySnapshot } from "./import-session";

const DEFAULT_POOL_MAXIMUM = 50;
const DEFAULT_READY_TARGET = 5;
const DEFAULT_TURNAROUND_ALPHA = 0.25;
const MAX_CONSECUTIVE_FALLBACK_DRAWS = 10;
const FALLBACK_DRAW_DELAY_MS = 3_000;
export type ReusableCandidateSource = "curated" | "generated";

export interface CandidateRating {
  candidate: Candidate;
  rating: number;
  wins: number;
  losses: number;
  source: "curated" | "generated" | "imported";
  importItemId: string | null;
  poolMember: boolean;
  poolEligible?: boolean;
  lastServedAt: string | null;
  favorite?: boolean;
}

export interface BufferedCandidate {
  candidate: Candidate;
  source: "seed" | "generated" | "imported";
  importItemId: string | null;
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
  leaderboardEvidence?: LeaderboardPreferenceEvidence;
  leaderboardVisualProfile?: LeaderboardVisualProfile;
  preferenceSeed: string;
  preferenceProfile?: PreferenceProfile;
  promptCard?: import("./game").GenerationPromptCard;
  variationSource?: import("./game").VariationSource;
  sessionId: string;
  pinnedWinnerId: string;
  comparisonOutcome?: "tie" | "both-lose";
}

export interface ProfileSourceImageSnapshot {
  filename: string;
  path: string;
  contentType: "image/png";
  width: number;
  height: number;
  byteLength: number;
}

export interface LeaderboardProfileSourceSnapshot {
  candidateId: string;
  rank: number;
  rating: number;
  wins: number;
  losses: number;
  favorite: boolean;
  source: CandidateRating["source"];
  concept: string;
  style: string[];
  sourceImage: ProfileSourceImageSnapshot;
}

export interface LeaderboardProfileJobSnapshot {
  id: string;
  kind: "leaderboard-profile";
  createdAt: string;
  fingerprint: string;
  sources: LeaderboardProfileSourceSnapshot[];
}

export interface LeaderboardProfileJobRecord {
  jobId: string;
  fingerprint: string;
  enqueuedAt: string;
  expectedJob: LeaderboardProfileJobSnapshot;
}

export interface LeaderboardVisualProfile {
  fingerprint: string;
  sourceCandidateIds: string[];
  profile: PreferenceRevision;
  reasoningSummary: string;
  analyzedAt: string;
}

export interface WinningComparisonReceipt {
  kind?: "selection";
  selectedAt: string;
  roundNumber: number;
  winnerSide: Side;
  winnerId: string;
  loserId: string;
}

export interface TieComparisonReceipt {
  kind: "tie";
  selectedAt: string;
  roundNumber: number;
  leftId: string;
  rightId: string;
}

export interface BothLoseComparisonReceipt {
  kind: "both-lose";
  selectedAt: string;
  roundNumber: number;
  leftId: string;
  rightId: string;
}

export type PendingComparisonReceipt =
  WinningComparisonReceipt | TieComparisonReceipt | BothLoseComparisonReceipt;

export interface PreparedCandidateDequeue {
  dequeueOperationId: string;
  importSessionId: string | null;
  originalReceipt: PendingComparisonReceipt;
  replacementSlot: "single" | "pair-left" | "pair-right";
  reason: "selection" | "retirement" | "tie" | "both-lose";
  roundNumber: number;
  excludedCandidateIds: string[];
  candidate: Candidate;
  provenance: "imported" | "ready" | "pool-fallback";
  importItemId: string | null;
  importSupply: ImportSupplySnapshot;
}

export interface PendingSelectionBaseline {
  ready: BufferedCandidate[];
  importQueue?: BufferedCandidate[];
  ratings: CandidateRating[];
  generationTurnaroundEmaMs: number;
  consecutiveFallbackDraws: number;
  nextFallbackAt: string | null;
}

export interface ChallengerState {
  version: 1;
  sessionId: string;
  ready: BufferedCandidate[];
  importQueue: BufferedCandidate[];
  refillJobs: RefillJobRecord[];
  leaderboardProfileJob?: LeaderboardProfileJobRecord | null;
  leaderboardVisualProfile?: LeaderboardVisualProfile | null;
  leaderboardProfileAttemptedFingerprint?: string | null;
  pendingComparison: PendingComparisonReceipt | null;
  preparedDequeues?: PreparedCandidateDequeue[];
  pendingSelectionBaseline?: PendingSelectionBaseline | null;
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

export interface CandidateBatchDraw {
  candidates: Candidate[];
  state: ChallengerState;
}

export interface PoolLeaderboardEntry {
  rank: number;
  candidate: Pick<
    Candidate,
    "id" | "imageUrl" | "concept" | "style" | "lineage" | "promptCardId"
  >;
  rating: number;
  wins: number;
  losses: number;
  source: CandidateRating["source"];
  favorite: boolean;
}

export function isReusablePoolLeaderboardEntry(
  entry: PoolLeaderboardEntry,
): entry is PoolLeaderboardEntry & { source: ReusableCandidateSource } {
  return entry.source !== "imported";
}

export interface FavoriteGalleryEntry {
  rank: number;
  candidate: PoolLeaderboardEntry["candidate"];
  rating: number;
  wins: number;
  losses: number;
  source: CandidateRating["source"];
  poolMember: boolean;
}

export interface PreferenceLeaderboardEntry {
  rank: number;
  candidateId: string;
  concept: string;
  style: string[];
  rating: number;
  wins: number;
  losses: number;
  source: CandidateRating["source"];
  favorite: boolean;
}

export interface LeaderboardPreferenceEvidence {
  poolSize: number;
  entries: PreferenceLeaderboardEntry[];
}

export interface ComparisonHistoryCandidate {
  id: string;
  imageUrl: string | null;
  concept: string;
  style: string[];
  favorite: boolean | null;
  lineage?: Candidate["lineage"];
  promptCardId?: string;
}

export interface WinningComparisonHistoryEntry {
  outcome: "selection";
  decisionNumber: number;
  selectedAt: string;
  winner: ComparisonHistoryCandidate;
  loser: ComparisonHistoryCandidate;
}

export interface TieComparisonHistoryEntry {
  outcome: "tie";
  decisionNumber: number;
  selectedAt: string;
  left: ComparisonHistoryCandidate;
  right: ComparisonHistoryCandidate;
}

export interface BothLoseComparisonHistoryEntry {
  outcome: "both-lose";
  decisionNumber: number;
  selectedAt: string;
  left: ComparisonHistoryCandidate;
  right: ComparisonHistoryCandidate;
}

export type ComparisonHistoryEntry =
  | WinningComparisonHistoryEntry
  | TieComparisonHistoryEntry
  | BothLoseComparisonHistoryEntry;

export interface FallbackDrawOptions {
  now: string;
  currentCandidateIds: readonly string[];
  recentCandidateIds: readonly string[];
  random: () => number;
  delayMs?: number;
  maximumConsecutiveDraws?: number;
}

export function summarizeBufferHealth(
  state: ChallengerState | null,
  target = DEFAULT_READY_TARGET,
  poolMaximum = DEFAULT_POOL_MAXIMUM,
  work: Pick<BufferHealth, "active" | "pending" | "draining"> = {
    active: state?.refillJobs.length ?? 0,
    pending: 0,
    draining: 0,
  },
): BufferHealth {
  return {
    ready: state?.ready.length ?? 0,
    inFlight: state?.refillJobs.length ?? 0,
    ...work,
    target,
    pool: state?.ratings.filter((item) => item.poolMember).length ?? 0,
    poolMaximum,
  };
}

export function refillJobMatchesGenerationPreferences(
  job: Pick<
    RefillGenerationJobSnapshot,
    "preferenceSeed" | "preferenceProfile" | "variationSource"
  >,
  game: Pick<
    GameState,
    "preferenceSeed" | "preferenceProfile" | "variationSource"
  >,
): boolean {
  return (
    job.preferenceSeed === game.preferenceSeed &&
    (job.preferenceProfile?.adaptationMode ?? "static") ===
      (game.preferenceProfile?.adaptationMode ?? "static") &&
    (job.preferenceProfile?.adaptationStrength ?? "guided") ===
      (game.preferenceProfile?.adaptationStrength ?? "guided") &&
    job.variationSource?.candidateId === game.variationSource?.candidateId
  );
}

export function summarizeDisplayedEloRatings(
  state: ChallengerState | null,
  leftCandidateId: string,
  rightCandidateId: string,
  initialRating = 1000,
): DisplayedEloRatings {
  const ratings = new Map(
    state?.ratings.map((item) => [item.candidate.id, item.rating]) ?? [],
  );
  return {
    left: Math.round(ratings.get(leftCandidateId) ?? initialRating),
    right: Math.round(ratings.get(rightCandidateId) ?? initialRating),
  };
}

export function summarizeDisplayedScores(
  state: ChallengerState | null,
  game: GameState,
  initialRating = 1000,
  kFactor = 32,
  poolMaximum = DEFAULT_POOL_MAXIMUM,
): DisplayedEloRatings {
  const ratings = summarizeDisplayedEloRatings(
    state,
    game.round.leftCandidate.id,
    game.round.rightCandidate.id,
    initialRating,
  );
  if (!state) return ratings;

  const appearedIds = new Set(
    game.history.flatMap((decision) =>
      decision.outcome === "tie" || decision.outcome === "both-lose"
        ? [decision.leftId, decision.rightId]
        : [decision.winnerId, decision.loserId],
    ),
  );
  const scoreFor = (
    candidateId: string,
    opponentId: string,
    rating: number | "new" | "pool-exit",
  ) => {
    if (!appearedIds.has(candidateId)) return "new" as const;
    return wouldLeavePoolAfterLoss(
      state,
      candidateId,
      opponentId,
      kFactor,
      poolMaximum,
    )
      ? ("pool-exit" as const)
      : rating;
  };

  return {
    left: scoreFor(
      game.round.leftCandidate.id,
      game.round.rightCandidate.id,
      ratings.left,
    ),
    right: scoreFor(
      game.round.rightCandidate.id,
      game.round.leftCandidate.id,
      ratings.right,
    ),
  };
}

function wouldLeavePoolAfterLoss(
  state: ChallengerState,
  loserId: string,
  winnerId: string,
  kFactor: number,
  poolMaximum: number,
): boolean {
  const loser = state.ratings.find(({ candidate }) => candidate.id === loserId);
  const winner = state.ratings.find(
    ({ candidate }) => candidate.id === winnerId,
  );
  if (!loser?.poolMember || !winner) return false;

  const nextRatings = updateElo(winner.rating, loser.rating, kFactor);
  const rated = {
    ...state,
    ratings: state.ratings.map((item) => {
      if (item === winner) return { ...item, rating: nextRatings.winner };
      if (item === loser) return { ...item, rating: nextRatings.loser };
      return item;
    }),
  };
  const withLoser = admitGeneratedCandidate(rated, loserId, poolMaximum);
  const completed = admitGeneratedCandidate(withLoser, winnerId, poolMaximum);
  return !completed.ratings.find(({ candidate }) => candidate.id === loserId)
    ?.poolMember;
}

export function summarizePoolLeaderboard(
  state: ChallengerState | null,
): PoolLeaderboardEntry[] {
  return (state?.ratings ?? [])
    .filter(({ poolMember }) => poolMember)
    .toSorted(
      (left, right) =>
        right.rating - left.rating ||
        right.wins - left.wins ||
        left.losses - right.losses ||
        left.candidate.id.localeCompare(right.candidate.id),
    )
    .map(({ candidate, rating, wins, losses, source, favorite }, index) => ({
      rank: index + 1,
      candidate: {
        id: candidate.id,
        imageUrl: candidate.imageUrl,
        concept: candidate.concept,
        style: candidate.style,
        ...(candidate.lineage ? { lineage: candidate.lineage } : {}),
        ...(candidate.promptCardId
          ? { promptCardId: candidate.promptCardId }
          : {}),
      },
      rating: Math.round(rating),
      wins,
      losses,
      source,
      favorite: Boolean(favorite),
    }));
}

export function summarizeFavoriteGallery(
  state: ChallengerState | null,
): FavoriteGalleryEntry[] {
  return (state?.ratings ?? [])
    .filter(({ favorite }) => favorite)
    .toSorted(
      (left, right) =>
        right.rating - left.rating ||
        right.wins - left.wins ||
        left.losses - right.losses ||
        left.candidate.id.localeCompare(right.candidate.id),
    )
    .map(({ candidate, rating, wins, losses, source, poolMember }, index) => ({
      rank: index + 1,
      candidate: {
        id: candidate.id,
        imageUrl: candidate.imageUrl,
        concept: candidate.concept,
        style: candidate.style,
        ...(candidate.lineage ? { lineage: candidate.lineage } : {}),
        ...(candidate.promptCardId
          ? { promptCardId: candidate.promptCardId }
          : {}),
      },
      rating: Math.round(rating),
      wins,
      losses,
      source,
      poolMember,
    }));
}

export function summarizeLeaderboardPreferenceEvidence(
  state: ChallengerState | null,
  limit = 12,
): LeaderboardPreferenceEvidence {
  const leaderboard = summarizePoolLeaderboard(state);
  const boundedLimit = Math.max(1, Math.min(12, Math.floor(limit)));
  const topCount = Math.ceil(boundedLimit / 2);
  const bottomCount = boundedLimit - topCount;
  const sampled =
    leaderboard.length <= boundedLimit
      ? leaderboard
      : [...leaderboard.slice(0, topCount), ...leaderboard.slice(-bottomCount)];

  return {
    poolSize: leaderboard.length,
    entries: sampled.map(
      ({ rank, candidate, rating, wins, losses, source, favorite }) => ({
        rank,
        candidateId: candidate.id.slice(0, 200),
        concept: candidate.concept.trim().slice(0, 240),
        style: candidate.style
          .slice(0, 4)
          .map((tag) => tag.trim().slice(0, 80))
          .filter(Boolean),
        rating,
        wins,
        losses,
        source,
        favorite,
      }),
    ),
  };
}

export function summarizeComparisonHistory(
  history: readonly SelectionHistory[],
  state: ChallengerState | null,
  limit = 50,
): ComparisonHistoryEntry[] {
  const ratings = new Map(
    (state?.ratings ?? []).map((rating) => [rating.candidate.id, rating]),
  );
  const displayCandidate = (
    id: string,
    fallbackConcept: string,
  ): ComparisonHistoryCandidate => {
    const rating = ratings.get(id);
    const candidate = rating?.candidate;
    return {
      id,
      imageUrl: candidate?.imageUrl ?? null,
      concept: candidate?.concept ?? fallbackConcept,
      style: candidate?.style ?? [],
      favorite: rating ? Boolean(rating.favorite) : null,
      ...(candidate?.lineage ? { lineage: candidate.lineage } : {}),
      ...(candidate?.promptCardId
        ? { promptCardId: candidate.promptCardId }
        : {}),
    };
  };

  return history
    .map((selection, index): ComparisonHistoryEntry => {
      if (selection.outcome === "tie" || selection.outcome === "both-lose") {
        return {
          outcome: selection.outcome,
          decisionNumber: index + 1,
          selectedAt: selection.selectedAt,
          left: displayCandidate(selection.leftId, selection.leftConcept),
          right: displayCandidate(selection.rightId, selection.rightConcept),
        };
      }
      return {
        outcome: "selection",
        decisionNumber: index + 1,
        selectedAt: selection.selectedAt,
        winner: displayCandidate(selection.winnerId, selection.winnerConcept),
        loser: displayCandidate(selection.loserId, selection.loserConcept),
      };
    })
    .toReversed()
    .slice(0, Math.max(0, Math.floor(limit)));
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

function effectivePoolMaximum(poolMaximum: number): number {
  const configuredMaximum = Number.isFinite(poolMaximum)
    ? Math.floor(poolMaximum)
    : DEFAULT_POOL_MAXIMUM;
  return Math.min(DEFAULT_POOL_MAXIMUM, Math.max(0, configuredMaximum));
}

export function resizeCandidatePool(
  state: ChallengerState,
  poolMaximum = DEFAULT_POOL_MAXIMUM,
): ChallengerState {
  const effectiveMaximum = effectivePoolMaximum(poolMaximum);
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
  return repairedRatings === state.ratings
    ? state
    : { ...state, ratings: repairedRatings };
}

export function admitGeneratedCandidate(
  state: ChallengerState,
  candidateId: string,
  poolMaximum = DEFAULT_POOL_MAXIMUM,
): ChallengerState {
  const candidate = state.ratings.find(
    (item) => item.candidate.id === candidateId,
  );
  if (candidate?.source !== "generated") {
    return resizeCandidatePool(state, poolMaximum);
  }
  return admitEligibleCandidates(state, [candidateId], poolMaximum);
}

export function admitEligibleCandidates(
  state: ChallengerState,
  candidateIds: readonly string[],
  poolMaximum = DEFAULT_POOL_MAXIMUM,
): ChallengerState {
  return candidateIds.reduce(
    (current, candidateId) =>
      admitEligibleCandidate(current, candidateId, poolMaximum),
    state,
  );
}

function admitEligibleCandidate(
  state: ChallengerState,
  candidateId: string,
  poolMaximum = DEFAULT_POOL_MAXIMUM,
): ChallengerState {
  const effectiveMaximum = effectivePoolMaximum(poolMaximum);
  const repairedState = resizeCandidatePool(state, poolMaximum);
  const repairedRatings = repairedState.ratings;
  const candidate = repairedRatings.find(
    (item) => item.candidate.id === candidateId,
  );
  if (!candidate || candidate.poolMember || candidate.poolEligible === false) {
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
  const resized = resizeCandidatePool(state, poolMaximum);
  return resized.ratings
    .filter(
      (item) =>
        item.source === "generated" &&
        !item.poolMember &&
        item.poolEligible !== false,
    )
    .map((item, index) => ({ item, index }))
    .sort(
      (left, right) =>
        right.item.rating - left.item.rating || left.index - right.index,
    )
    .reduce(
      (current, { item }) =>
        admitGeneratedCandidate(current, item.candidate.id, poolMaximum),
      resized,
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
  const draw = drawFallbackBatch(state, options, 1);
  return { candidate: draw.candidates[0] ?? null, state: draw.state };
}

export function drawFallbackBatch(
  state: ChallengerState,
  options: FallbackDrawOptions,
  count: number,
): CandidateBatchDraw {
  const requestedCount = Math.max(0, Math.floor(count));
  if (requestedCount === 0) return { candidates: [], state };

  const delayMs = options.delayMs ?? FALLBACK_DRAW_DELAY_MS;
  const maximumConsecutiveDraws =
    options.maximumConsecutiveDraws ?? MAX_CONSECUTIVE_FALLBACK_DRAWS;
  if (
    state.consecutiveFallbackDraws + requestedCount >
    maximumConsecutiveDraws
  ) {
    return { candidates: [], state };
  }

  const excludedIds = new Set([
    ...options.currentCandidateIds,
    ...options.recentCandidateIds,
  ]);
  const eligible = state.ratings.filter(
    (item) => item.poolMember && !excludedIds.has(item.candidate.id),
  );
  if (eligible.length < requestedCount) return { candidates: [], state };

  if (state.nextFallbackAt === null) {
    return {
      candidates: [],
      state: {
        ...state,
        nextFallbackAt: new Date(
          Date.parse(options.now) + delayMs,
        ).toISOString(),
      },
    };
  }

  if (Date.parse(options.now) < Date.parse(state.nextFallbackAt)) {
    return { candidates: [], state };
  }

  const remaining = [...eligible];
  const selected: CandidateRating[] = [];
  for (let index = 0; index < requestedCount; index += 1) {
    const selectedIndex = Math.min(
      Math.floor(options.random() * remaining.length),
      remaining.length - 1,
    );
    selected.push(remaining.splice(selectedIndex, 1)[0]);
  }
  const selectedIds = new Set(selected.map((item) => item.candidate.id));
  return {
    candidates: selected.map((item) => item.candidate),
    state: {
      ...state,
      ratings: state.ratings.map((item) =>
        selectedIds.has(item.candidate.id)
          ? { ...item, lastServedAt: options.now }
          : item,
      ),
      consecutiveFallbackDraws: state.consecutiveFallbackDraws + requestedCount,
      nextFallbackAt: null,
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
