import { describe, expect, it } from "vitest";
import type {
  CandidateRating,
  ChallengerState,
} from "@/domain/challenger-state";
import {
  composePreferenceSeed,
  preferenceProfileFromSeed,
  type Candidate,
  type GameState,
  type PreferenceRevision,
} from "@/domain/game";
import { applyAdaptivePreferences } from "./game-adaptation";

const NOW = "2026-07-25T12:00:00.000Z";

const revision: PreferenceRevision = {
  themes: "Clearly adult alternative portrait studies",
  inspiration: "Ultraviolet rim light and severe off-axis framing",
  mediaTypes: "large-format editorial photography",
  visualStyle: "severe, tactile, and cinematic",
  colorPalette: "ultraviolet, oxblood, charcoal, and pale skin tones",
  contentLevel: "adult-allowed",
  avoid: "readable text, logos, and exact likenesses",
};

function candidate(
  id: string,
  preferenceRevision?: PreferenceRevision,
): Candidate {
  return {
    id,
    imageUrl: `/api/assets/${id}.png`,
    prompt: `${id} prompt`,
    concept: `${id} concept`,
    style: ["editorial"],
    createdAt: NOW,
    winCount: 0,
    ...(preferenceRevision ? { preferenceRevision } : {}),
  };
}

function rating(
  item: Candidate,
  source: CandidateRating["source"] = "generated",
): CandidateRating {
  return {
    candidate: item,
    rating: 1000,
    wins: 0,
    losses: 0,
    source,
    importItemId: null,
    poolMember: true,
    lastServedAt: null,
  };
}

function challengers(
  ratings: CandidateRating[],
  ready = [candidate("buffered")],
): ChallengerState {
  return {
    version: 1,
    sessionId: "session-1",
    ready: ready.map((item) => ({
      candidate: item,
      source: "generated",
      importItemId: null,
      pinnedWinnerId: null,
      enqueuedAt: NOW,
    })),
    importQueue: [],
    refillJobs: [],
    pendingComparison: null,
    ratings,
    generationTurnaroundEmaMs: 100_000,
    consecutiveFallbackDraws: 0,
    nextFallbackAt: null,
  };
}

function game(
  history: GameState["history"],
  adaptationMode: "static" | "adaptive" = "adaptive",
): GameState {
  const seed = "Industrial, gothic, natural, and surprising";
  return {
    round: {
      leftCandidate: candidate("winner", revision),
      rightCandidate: candidate("loser"),
      status: "idle",
      replacingSide: null,
      roundNumber: history.length + 1,
      retainedCandidateId: "winner",
      winStreak: 1,
    },
    history,
    preferenceSeed: composePreferenceSeed({
      ...preferenceProfileFromSeed(seed),
      adaptationMode,
      adaptationStrength: "unfettered",
      adaptationLastDecision: 0,
    }),
    preferenceProfile: {
      ...preferenceProfileFromSeed(seed),
      adaptationMode,
      adaptationStrength: "unfettered",
      adaptationLastDecision: 0,
    },
  };
}

function selectionHistory(count = 5): GameState["history"] {
  return Array.from({ length: count }, (_, index) => ({
    winnerId: index === count - 1 ? "winner" : `prior-winner-${index}`,
    loserId: index === count - 1 ? "loser" : `prior-loser-${index}`,
    winnerPrompt: `winner prompt ${index}`,
    loserPrompt: `loser prompt ${index}`,
    winnerConcept: `winner concept ${index}`,
    loserConcept: `loser concept ${index}`,
    selectedAt: `2026-07-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
  }));
}

describe("applyAdaptivePreferences", () => {
  it("adopts an eligible winner revision and clears stale ready capacity", () => {
    const current = game(selectionHistory());
    current.variationSource = {
      candidateId: "variation-source",
      concept: "variation source concept",
    };
    const state = challengers([
      rating(current.round.leftCandidate),
      rating(current.round.rightCandidate),
    ]);

    const result = applyAdaptivePreferences(current, state);

    expect(result.game.preferenceProfile).toMatchObject({
      ...revision,
      adaptationMode: "adaptive",
      adaptationStrength: "unfettered",
      adaptationLastDecision: 5,
      adaptationSourceWinnerIds: ["winner"],
      adaptationSourceRejectedIds: ["loser"],
    });
    expect(result.game.preferenceSeed).toContain(
      "Themes and subjects: Clearly adult alternative portrait studies",
    );
    expect(result.game.preferenceRevisions).toMatchObject([
      {
        source: "initial",
        variationSource: current.variationSource,
      },
      {
        source: "adaptive",
        variationSource: current.variationSource,
        profile: { inspiration: revision.inspiration },
      },
    ]);
    expect(result.challengers.ready).toEqual([]);
  });

  it("records generated rejection evidence without flushing capacity", () => {
    const current = game(selectionHistory(1));
    const state = challengers([
      rating(candidate("winner")),
      rating(current.round.rightCandidate),
    ]);

    const result = applyAdaptivePreferences(current, state);

    expect(result.game.preferenceSeed).toBe(current.preferenceSeed);
    expect(result.game.preferenceProfile).toMatchObject({
      adaptationSourceWinnerIds: [],
      adaptationSourceRejectedIds: ["loser"],
    });
    expect(result.game.preferenceRevisions).toBeUndefined();
    expect(result.challengers).toBe(state);
  });

  it("records both generated candidates as negative evidence after both-lose", () => {
    const history: GameState["history"] = [
      {
        outcome: "both-lose",
        leftId: "left",
        rightId: "right",
        leftPrompt: "left prompt",
        rightPrompt: "right prompt",
        leftConcept: "left concept",
        rightConcept: "right concept",
        selectedAt: NOW,
      },
    ];
    const current = game(history);
    const state = challengers([
      rating(candidate("left")),
      rating(candidate("right")),
    ]);

    const result = applyAdaptivePreferences(current, state);

    expect(result.game.preferenceProfile).toMatchObject({
      adaptationSourceRejectedIds: ["left", "right"],
    });
    expect(result.game.preferenceSeed).toBe(current.preferenceSeed);
    expect(result.challengers).toBe(state);
  });

  it("does nothing for ties or frozen profiles", () => {
    const tie: GameState["history"] = [
      {
        outcome: "tie",
        leftId: "left",
        rightId: "right",
        leftPrompt: "left prompt",
        rightPrompt: "right prompt",
        leftConcept: "left concept",
        rightConcept: "right concept",
        selectedAt: NOW,
      },
    ];
    const state = challengers([
      rating(candidate("left")),
      rating(candidate("right")),
    ]);
    const tiedGame = game(tie);
    const frozenGame = game(selectionHistory(), "static");

    expect(applyAdaptivePreferences(tiedGame, state)).toEqual({
      game: tiedGame,
      challengers: state,
    });
    expect(applyAdaptivePreferences(frozenGame, state)).toEqual({
      game: frozenGame,
      challengers: state,
    });
  });
});
