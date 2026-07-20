export type Side = "left" | "right";
export type RoundStatus = "idle" | "generating" | "error";
export type PreferenceContentLevel = "family-friendly" | "adult-allowed";
export const GENERATION_JOB_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
export const CHAMPION_RETIREMENT_STREAK = 10;

export interface PreferenceProfile {
  themes: string;
  mediaTypes: string;
  visualStyle: string;
  colorPalette: string;
  contentLevel: PreferenceContentLevel;
  avoid: string;
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

export interface SelectionHistory {
  winnerId: string;
  loserId: string;
  winnerPrompt: string;
  loserPrompt: string;
  winnerConcept: string;
  loserConcept: string;
  selectedAt: string;
}

export type PendingSelection =
  | {
      kind: "generation";
      winnerSide: Side;
      selectedAt: string;
      generationJobId: string;
    }
  | { kind: "buffer"; winnerSide: Side; selectedAt: string }
  | { kind: "retirement"; winnerSide: Side; selectedAt: string };

export interface GameState {
  round: Round;
  history: SelectionHistory[];
  preferenceSeed: string;
  preferenceProfile?: PreferenceProfile;
  pendingSelection?: PendingSelection;
  mailboxCleanupJobId?: string;
  errorMessage?: string;
}

export interface BufferHealth {
  ready: number;
  inFlight: number;
  target: number;
  pool: number;
  poolMaximum: number;
}

export interface DisplayedEloRatings {
  left: number;
  right: number;
}

export function preferenceProfileFromSeed(
  preferenceSeed: string,
): PreferenceProfile {
  return {
    themes: preferenceSeed,
    mediaTypes: "",
    visualStyle: "",
    colorPalette: "",
    contentLevel: "family-friendly",
    avoid: "",
  };
}

export function composePreferenceSeed(profile: PreferenceProfile): string {
  const sections = [
    ["Themes and subjects", profile.themes],
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

export function completeSelection(
  state: GameState,
  challenger: Candidate,
): GameState {
  const pending = state.pendingSelection;
  if (state.round.status !== "generating" || !pending) {
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
    for (const concept of [item.loserConcept, item.winnerConcept]) {
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
  if (state.preferenceProfile) return state;
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
