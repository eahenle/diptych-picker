export type Side = "left" | "right";
export type RoundStatus = "idle" | "generating" | "error";
export type PreferenceContentLevel = "family-friendly" | "adult-allowed";
export type PreferenceAdaptationMode = "static" | "adaptive";
export type PreferenceAdaptationStrength = "guided" | "unfettered";
export type PreferenceAdaptationFreedom =
  "frozen" | PreferenceAdaptationStrength;
export const GENERATION_JOB_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
export const CHAMPION_RETIREMENT_STREAK = 10;

export interface PreferenceProfile {
  themes: string;
  inspiration: string;
  mediaTypes: string;
  visualStyle: string;
  colorPalette: string;
  contentLevel: PreferenceContentLevel;
  avoid: string;
  adaptationMode: PreferenceAdaptationMode;
  adaptationStrength?: PreferenceAdaptationStrength;
  adaptationLastDecision?: number;
  adaptationSourceWinnerIds: string[];
  adaptationSourceRejectedIds: string[];
}

export type PreferenceRevision = Omit<
  PreferenceProfile,
  | "adaptationMode"
  | "adaptationStrength"
  | "adaptationLastDecision"
  | "adaptationSourceWinnerIds"
  | "adaptationSourceRejectedIds"
>;

export interface VariationSource {
  candidateId: string;
  concept: string;
}

export interface PreferenceProfileSnapshot {
  createdAt: string;
  source: "initial" | "manual" | "variation" | "adaptive";
  profile: PreferenceProfile;
  variationSource?: VariationSource;
}

export interface CandidateLineage {
  kind: "variation";
  parentCandidateId: string;
  parentConcept: string;
  preferenceFingerprint: string;
}

export interface Candidate {
  id: string;
  imageUrl: string;
  prompt: string;
  concept: string;
  style: string[];
  createdAt: string;
  winCount: number;
  reasoningSummary?: string;
  preferenceRevision?: PreferenceRevision;
  lineage?: CandidateLineage;
}

export interface Round {
  leftCandidate: Candidate;
  rightCandidate: Candidate;
  status: RoundStatus;
  replacingSide: Side | null;
  roundNumber: number;
  retainedCandidateId: string | null;
  winStreak: number;
}

export interface WinningSelectionHistory {
  outcome?: "selection";
  winnerId: string;
  loserId: string;
  winnerPrompt: string;
  loserPrompt: string;
  winnerConcept: string;
  loserConcept: string;
  selectedAt: string;
}

export interface TieSelectionHistory {
  outcome: "tie";
  leftId: string;
  rightId: string;
  leftPrompt: string;
  rightPrompt: string;
  leftConcept: string;
  rightConcept: string;
  selectedAt: string;
}

export interface BothLoseSelectionHistory {
  outcome: "both-lose";
  leftId: string;
  rightId: string;
  leftPrompt: string;
  rightPrompt: string;
  leftConcept: string;
  rightConcept: string;
  selectedAt: string;
}

export type SelectionHistory =
  WinningSelectionHistory | TieSelectionHistory | BothLoseSelectionHistory;

export type PendingSelection =
  | {
      kind: "generation";
      winnerSide: Side;
      selectedAt: string;
      generationJobId: string;
    }
  | { kind: "buffer"; winnerSide: Side; selectedAt: string }
  | { kind: "retirement"; winnerSide: Side; selectedAt: string }
  | { kind: "tie"; referenceSide: Side; selectedAt: string }
  | { kind: "both-lose"; referenceSide: Side; selectedAt: string };

export interface GameState {
  round: Round;
  history: SelectionHistory[];
  preferenceSeed: string;
  preferenceProfile?: PreferenceProfile;
  preferenceRevisions?: PreferenceProfileSnapshot[];
  variationSource?: VariationSource;
  pendingSelection?: PendingSelection;
  mailboxCleanupJobId?: string;
  errorMessage?: string;
  generationNotice?: GenerationNotice;
}

export interface BufferHealth {
  ready: number;
  inFlight: number;
  active: number;
  pending: number;
  draining: number;
  target: number;
  pool: number;
  poolMaximum: number;
}

export type DisplayedScore = number | "new" | "pool-exit";

export interface DisplayedEloRatings {
  left: DisplayedScore;
  right: DisplayedScore;
}

export interface GenerationNotice {
  kind: "moderation-block";
  jobId: string;
  occurredAt: string;
  occurrenceCount: number;
}

export function preferenceProfileFromSeed(
  preferenceSeed: string,
): PreferenceProfile {
  return {
    themes: preferenceSeed,
    inspiration: "",
    mediaTypes: "",
    visualStyle: "",
    colorPalette: "",
    contentLevel: "family-friendly",
    avoid: "",
    adaptationMode: "static",
    adaptationStrength: "guided",
    adaptationLastDecision: 0,
    adaptationSourceWinnerIds: [],
    adaptationSourceRejectedIds: [],
  };
}

export function composePreferenceSeed(profile: PreferenceProfile): string {
  const sections = [
    ["Themes and subjects", profile.themes],
    ["Inspiration", profile.inspiration],
    ["Preferred media", profile.mediaTypes],
    ["Visual style and mood", profile.visualStyle],
    ["Color palette", profile.colorPalette],
    [
      "Content range",
      profile.contentLevel === "adult-allowed"
        ? "Adult themes may be used when relevant; keep content non-explicit and depict only clearly adult people."
        : "Keep the imagery family-friendly.",
    ],
    ["Avoid or de-emphasize", profile.avoid],
  ] as const;

  return sections
    .filter(([, value]) => value.trim().length > 0)
    .map(([label, value]) => `${label}: ${value.trim()}`)
    .join("\n");
}

export function applyWinnerPreferenceRevision(
  profile: PreferenceProfile,
  winner: Candidate,
  completedDecisionCount: number,
): PreferenceProfile {
  if (
    profile.adaptationMode !== "adaptive" ||
    !winner.preferenceRevision ||
    !isPreferenceAdaptationDue(profile, completedDecisionCount)
  ) {
    return profile;
  }
  const strength = preferenceAdaptationStrength(profile);
  return {
    ...profile,
    ...winner.preferenceRevision,
    adaptationMode: "adaptive",
    adaptationStrength: strength,
    adaptationLastDecision: completedDecisionCount,
    adaptationSourceWinnerIds: appendAdaptationSource(
      profile.adaptationSourceWinnerIds,
      winner.id,
    ),
    adaptationSourceRejectedIds: profile.adaptationSourceRejectedIds,
  };
}

export function preferenceAdaptationStrength(
  profile: PreferenceProfile,
): PreferenceAdaptationStrength {
  return profile.adaptationStrength ?? "guided";
}

export function preferenceAdaptationFreedom(
  profile: PreferenceProfile,
): PreferenceAdaptationFreedom {
  return profile.adaptationMode === "static"
    ? "frozen"
    : preferenceAdaptationStrength(profile);
}

export function preferenceAdaptationInterval(
  profile: PreferenceProfile,
): 5 | 15 | null {
  if (profile.adaptationMode !== "adaptive") return null;
  return preferenceAdaptationStrength(profile) === "unfettered" ? 5 : 15;
}

export interface PreferenceAdaptationProgress {
  interval: 5 | 15;
  completed: number;
  remaining: number;
  due: boolean;
}

export function preferenceAdaptationProgress(
  profile: PreferenceProfile,
  completedDecisionCount: number,
): PreferenceAdaptationProgress | null {
  const interval = preferenceAdaptationInterval(profile);
  if (interval === null) return null;
  const completed =
    profile.adaptationLastDecision === undefined
      ? interval
      : Math.min(
          interval,
          Math.max(0, completedDecisionCount - profile.adaptationLastDecision),
        );
  const remaining = interval - completed;
  return { interval, completed, remaining, due: remaining === 0 };
}

export function isPreferenceAdaptationDue(
  profile: PreferenceProfile,
  completedDecisionCount: number,
): boolean {
  return (
    preferenceAdaptationProgress(profile, completedDecisionCount)?.due ?? false
  );
}

export function recordRejectedPreferenceEvidence(
  profile: PreferenceProfile,
  rejectedCandidateId: string,
): PreferenceProfile {
  if (
    profile.adaptationMode !== "adaptive" ||
    profile.adaptationSourceRejectedIds.includes(rejectedCandidateId)
  ) {
    return profile;
  }
  return {
    ...profile,
    adaptationSourceRejectedIds: appendAdaptationSource(
      profile.adaptationSourceRejectedIds,
      rejectedCandidateId,
    ),
  };
}

function appendAdaptationSource(ids: string[], candidateId: string): string[] {
  return [...ids.filter((id) => id !== candidateId), candidateId].slice(-12);
}

export type GameStartState =
  | {
      status: "ready";
      game: GameState;
      bufferHealth?: BufferHealth;
      eloRatings?: DisplayedEloRatings;
    }
  | { status: "initializing"; batchId: string; preferenceSeed: string }
  | {
      status: "initialization-error";
      batchId: string;
      preferenceSeed: string;
      errorMessage: string;
    };

export function oppositeSide(side: Side): Side {
  return side === "left" ? "right" : "left";
}

export function candidateAt(round: Round, side: Side): Candidate {
  return side === "left" ? round.leftCandidate : round.rightCandidate;
}

export function isSelectionBoundWait(state: GameState): boolean {
  return state.round.status === "generating" && Boolean(state.pendingSelection);
}

export function beginSelection(
  state: GameState,
  winnerSide: Side,
  selectedAt: string,
  generationJobId: string,
): GameState | null {
  if (!GENERATION_JOB_ID_PATTERN.test(generationJobId)) {
    throw new Error("Invalid generation job ID");
  }
  if (state.round.status === "generating") return null;

  return {
    ...state,
    round: {
      ...state.round,
      status: "generating",
      replacingSide: oppositeSide(winnerSide),
    },
    pendingSelection: {
      kind: "generation",
      winnerSide,
      selectedAt,
      generationJobId,
    },
    errorMessage: undefined,
  };
}

export function beginBufferedSelection(
  state: GameState,
  winnerSide: Side,
  selectedAt: string,
): GameState | null {
  if (state.round.status === "generating") return null;

  return {
    ...state,
    round: {
      ...state.round,
      status: "generating",
      replacingSide: oppositeSide(winnerSide),
    },
    pendingSelection: { kind: "buffer", winnerSide, selectedAt },
    errorMessage: undefined,
  };
}

export function willRetireChampion(
  state: GameState,
  winnerSide: Side,
): boolean {
  const winner = candidateAt(state.round, winnerSide);
  return (
    state.round.retainedCandidateId === winner.id &&
    state.round.winStreak + 1 >= CHAMPION_RETIREMENT_STREAK
  );
}

export function beginChampionRetirement(
  state: GameState,
  winnerSide: Side,
  selectedAt: string,
): GameState | null {
  if (state.round.status === "generating") return null;
  if (!willRetireChampion(state, winnerSide)) {
    throw new Error("The selected candidate has not reached retirement");
  }

  return {
    ...state,
    round: {
      ...state.round,
      status: "generating",
      replacingSide: null,
    },
    pendingSelection: { kind: "retirement", winnerSide, selectedAt },
    errorMessage: undefined,
  };
}

export function beginTie(
  state: GameState,
  referenceSide: Side,
  selectedAt: string,
): GameState | null {
  if (state.round.status === "generating") return null;

  return {
    ...state,
    round: {
      ...state.round,
      status: "generating",
      replacingSide: null,
    },
    pendingSelection: { kind: "tie", referenceSide, selectedAt },
    errorMessage: undefined,
  };
}

export function beginBothLose(
  state: GameState,
  referenceSide: Side,
  selectedAt: string,
): GameState | null {
  if (state.round.status === "generating") return null;

  return {
    ...state,
    round: {
      ...state.round,
      status: "generating",
      replacingSide: null,
    },
    pendingSelection: { kind: "both-lose", referenceSide, selectedAt },
    errorMessage: undefined,
  };
}

export function completeSelection(
  state: GameState,
  challenger: Candidate,
): GameState {
  const pending = state.pendingSelection;
  if (
    state.round.status !== "generating" ||
    !pending ||
    pending.kind === "tie" ||
    pending.kind === "both-lose"
  ) {
    throw new Error("No selection is awaiting a challenger");
  }

  const winner = candidateAt(state.round, pending.winnerSide);
  const loser = candidateAt(state.round, oppositeSide(pending.winnerSide));
  const continuesStreak = state.round.retainedCandidateId === winner.id;

  return {
    ...state,
    round: {
      leftCandidate: pending.winnerSide === "left" ? winner : challenger,
      rightCandidate: pending.winnerSide === "right" ? winner : challenger,
      status: "idle",
      replacingSide: null,
      roundNumber: state.round.roundNumber + 1,
      retainedCandidateId: winner.id,
      winStreak: continuesStreak ? (state.round.winStreak ?? 0) + 1 : 1,
    },
    history: [
      ...state.history,
      {
        winnerId: winner.id,
        loserId: loser.id,
        winnerPrompt: winner.prompt,
        loserPrompt: loser.prompt,
        winnerConcept: winner.concept,
        loserConcept: loser.concept,
        selectedAt: pending.selectedAt,
      },
    ],
    pendingSelection: undefined,
    errorMessage: undefined,
  };
}

export function completeChampionRetirement(
  state: GameState,
  leftCandidate: Candidate,
  rightCandidate: Candidate,
): GameState {
  const pending = state.pendingSelection;
  if (state.round.status !== "generating" || pending?.kind !== "retirement") {
    throw new Error("No champion retirement is awaiting replacements");
  }

  const currentIds = new Set([
    state.round.leftCandidate.id,
    state.round.rightCandidate.id,
  ]);
  if (
    leftCandidate.id === rightCandidate.id ||
    currentIds.has(leftCandidate.id) ||
    currentIds.has(rightCandidate.id)
  ) {
    throw new Error("Champion retirement requires two distinct replacements");
  }

  const winner = candidateAt(state.round, pending.winnerSide);
  const loser = candidateAt(state.round, oppositeSide(pending.winnerSide));
  return {
    ...state,
    round: {
      leftCandidate,
      rightCandidate,
      status: "idle",
      replacingSide: null,
      roundNumber: state.round.roundNumber + 1,
      retainedCandidateId: null,
      winStreak: 0,
    },
    history: [
      ...state.history,
      {
        winnerId: winner.id,
        loserId: loser.id,
        winnerPrompt: winner.prompt,
        loserPrompt: loser.prompt,
        winnerConcept: winner.concept,
        loserConcept: loser.concept,
        selectedAt: pending.selectedAt,
      },
    ],
    pendingSelection: undefined,
    errorMessage: undefined,
  };
}

export function completeTie(
  state: GameState,
  leftCandidate: Candidate,
  rightCandidate: Candidate,
): GameState {
  const pending = state.pendingSelection;
  if (state.round.status !== "generating" || pending?.kind !== "tie") {
    throw new Error("No tie is awaiting replacements");
  }

  const currentIds = new Set([
    state.round.leftCandidate.id,
    state.round.rightCandidate.id,
  ]);
  if (
    leftCandidate.id === rightCandidate.id ||
    currentIds.has(leftCandidate.id) ||
    currentIds.has(rightCandidate.id)
  ) {
    throw new Error("A tie requires two distinct replacements");
  }

  const tiedLeft = state.round.leftCandidate;
  const tiedRight = state.round.rightCandidate;
  return {
    ...state,
    round: {
      leftCandidate,
      rightCandidate,
      status: "idle",
      replacingSide: null,
      roundNumber: state.round.roundNumber + 1,
      retainedCandidateId: null,
      winStreak: 0,
    },
    history: [
      ...state.history,
      {
        outcome: "tie",
        leftId: tiedLeft.id,
        rightId: tiedRight.id,
        leftPrompt: tiedLeft.prompt,
        rightPrompt: tiedRight.prompt,
        leftConcept: tiedLeft.concept,
        rightConcept: tiedRight.concept,
        selectedAt: pending.selectedAt,
      },
    ],
    pendingSelection: undefined,
    errorMessage: undefined,
  };
}

export function completeBothLose(
  state: GameState,
  leftCandidate: Candidate,
  rightCandidate: Candidate,
): GameState {
  const pending = state.pendingSelection;
  if (state.round.status !== "generating" || pending?.kind !== "both-lose") {
    throw new Error("No dual rejection is awaiting replacements");
  }

  const currentIds = new Set([
    state.round.leftCandidate.id,
    state.round.rightCandidate.id,
  ]);
  if (
    leftCandidate.id === rightCandidate.id ||
    currentIds.has(leftCandidate.id) ||
    currentIds.has(rightCandidate.id)
  ) {
    throw new Error("A dual rejection requires two distinct replacements");
  }

  const rejectedLeft = state.round.leftCandidate;
  const rejectedRight = state.round.rightCandidate;
  return {
    ...state,
    round: {
      leftCandidate,
      rightCandidate,
      status: "idle",
      replacingSide: null,
      roundNumber: state.round.roundNumber + 1,
      retainedCandidateId: null,
      winStreak: 0,
    },
    history: [
      ...state.history,
      {
        outcome: "both-lose",
        leftId: rejectedLeft.id,
        rightId: rejectedRight.id,
        leftPrompt: rejectedLeft.prompt,
        rightPrompt: rejectedRight.prompt,
        leftConcept: rejectedLeft.concept,
        rightConcept: rejectedRight.concept,
        selectedAt: pending.selectedAt,
      },
    ],
    pendingSelection: undefined,
    errorMessage: undefined,
  };
}

export function failSelection(state: GameState, message: string): GameState {
  if (!state.pendingSelection) {
    throw new Error("No selection is available to retry");
  }

  return {
    ...state,
    round: { ...state.round, status: "error" },
    errorMessage: message,
  };
}

export function recoverInterruptedSelection(state: GameState): GameState {
  if (state.round.status !== "generating" || !state.pendingSelection) {
    return state;
  }
  return failSelection(
    state,
    "The previous challenger generation was interrupted. Retry when ready.",
  );
}

export function recentConcepts(state: GameState, limit = 8): string[] {
  const concepts: string[] = [];
  const seen = new Set<string>();

  for (let index = state.history.length - 1; index >= 0; index -= 1) {
    const item = state.history[index];
    const itemConcepts =
      item.outcome === "tie" || item.outcome === "both-lose"
        ? [item.rightConcept, item.leftConcept]
        : [item.loserConcept, item.winnerConcept];
    for (const concept of itemConcepts) {
      if (!seen.has(concept)) {
        seen.add(concept);
        concepts.push(concept);
      }
      if (concepts.length === limit) return concepts;
    }
  }

  return concepts;
}

export function mergeServerResult(
  current: GameState,
  response: GameState,
  winnerSide: Side,
): GameState {
  const currentWinner = candidateAt(current.round, winnerSide);

  return {
    ...response,
    round: {
      ...response.round,
      leftCandidate:
        winnerSide === "left" ? currentWinner : response.round.leftCandidate,
      rightCandidate:
        winnerSide === "right" ? currentWinner : response.round.rightCandidate,
    },
  };
}

export function migrateRoundStreakState(state: GameState): GameState {
  const retainedCandidateId = state.round.retainedCandidateId;
  const candidateIds = new Set([
    state.round.leftCandidate.id,
    state.round.rightCandidate.id,
  ]);
  const hasValidStreak =
    typeof retainedCandidateId === "string" &&
    candidateIds.has(retainedCandidateId) &&
    typeof state.round.winStreak === "number" &&
    Number.isInteger(state.round.winStreak) &&
    state.round.winStreak > 0;
  const hasEmptyStreak =
    retainedCandidateId === null && state.round.winStreak === 0;

  if (hasValidStreak || hasEmptyStreak) return state;
  return {
    ...state,
    round: {
      ...state.round,
      retainedCandidateId: null,
      winStreak: 0,
    },
  };
}

export function migratePendingSelectionState(state: GameState): GameState {
  const pending = state.pendingSelection as
    | PendingSelection
    | {
        winnerSide: Side;
        selectedAt: string;
        generationJobId: string;
      }
    | undefined;

  if (
    !pending ||
    "kind" in pending ||
    typeof pending.generationJobId !== "string"
  ) {
    return state;
  }

  return {
    ...state,
    pendingSelection: {
      kind: "generation",
      winnerSide: pending.winnerSide,
      selectedAt: pending.selectedAt,
      generationJobId: pending.generationJobId,
    },
  };
}

export function migratePreferenceProfileState(state: GameState): GameState {
  if (state.preferenceProfile) {
    const legacy = state.preferenceProfile as PreferenceProfile & {
      inspirationMode?: PreferenceAdaptationMode;
      inspirationSourceWinnerIds?: string[];
      adaptationSourceRejectedIds?: string[];
      adaptationStrength?: PreferenceAdaptationStrength;
      adaptationLastDecision?: number;
    };
    const preferenceProfile: PreferenceProfile = {
      themes: legacy.themes,
      inspiration: legacy.inspiration ?? "",
      mediaTypes: legacy.mediaTypes,
      visualStyle: legacy.visualStyle,
      colorPalette: legacy.colorPalette,
      contentLevel: legacy.contentLevel,
      avoid: legacy.avoid,
      adaptationMode:
        legacy.adaptationMode ?? legacy.inspirationMode ?? "static",
      adaptationStrength: legacy.adaptationStrength ?? "guided",
      adaptationLastDecision:
        legacy.adaptationLastDecision ?? state.history.length,
      adaptationSourceWinnerIds:
        legacy.adaptationSourceWinnerIds ??
        legacy.inspirationSourceWinnerIds ??
        [],
      adaptationSourceRejectedIds: legacy.adaptationSourceRejectedIds ?? [],
    };
    return { ...state, preferenceProfile };
  }
  return {
    ...state,
    preferenceProfile: preferenceProfileFromSeed(state.preferenceSeed),
  };
}

export function migrateGameState(state: GameState): GameState {
  return migratePreferenceProfileState(
    migratePendingSelectionState(migrateRoundStreakState(state)),
  );
}
