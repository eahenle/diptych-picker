export type Side = "left" | "right";
export type RoundStatus = "idle" | "generating" | "error";
export const GENERATION_JOB_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

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
  | { kind: "buffer"; winnerSide: Side; selectedAt: string };

export interface GameState {
  round: Round;
  history: SelectionHistory[];
  preferenceSeed: string;
  pendingSelection?: PendingSelection;
  mailboxCleanupJobId?: string;
  errorMessage?: string;
}

export type GameStartState =
  | { status: "ready"; game: GameState }
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

export function migrateGameState(state: GameState): GameState {
  return migratePendingSelectionState(migrateRoundStreakState(state));
}
