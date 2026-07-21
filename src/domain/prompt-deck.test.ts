import { describe, expect, it } from "vitest";
import type { Candidate, GameState, PromptDeck } from "./game";
import {
  createPromptCard,
  drawPromptCard,
  emptyPromptDeck,
  recordPromptCardDecision,
} from "./prompt-deck";

const card = createPromptCard(
  {
    title: "Copper portrait",
    prompt: "A severe editorial portrait with tactile industrial styling.",
    negativePrompt: "readable text",
    weight: 1,
    tags: ["portrait", " copper "],
  },
  "card-1",
  "2026-07-21T10:00:00.000Z",
);

const deck: PromptDeck = {
  enabled: true,
  cards: [card, { ...card, id: "card-2", title: "Ecology", weight: 3 }],
  verdicts: [],
};

describe("prompt deck", () => {
  it("draws active cards in proportion to positive weight", () => {
    expect(drawPromptCard(deck, () => 0.1)?.id).toBe("card-1");
    expect(drawPromptCard(deck, () => 0.3)?.id).toBe("card-2");
    expect(drawPromptCard({ ...deck, enabled: false }, () => 0)).toBeNull();
    expect(emptyPromptDeck()).toEqual({
      enabled: false,
      cards: [],
      verdicts: [],
    });
  });

  it("raises winner weight and records attributable verdicts", () => {
    const candidate = (id: string, promptCardId: string): Candidate => ({
      id,
      imageUrl: `/api/assets/${id}.png`,
      prompt: "prompt",
      concept: id,
      style: ["test"],
      createdAt: "2026-07-21T10:00:00.000Z",
      winCount: 0,
      promptCardId,
    });
    const game = {
      promptDeck: deck,
    } as GameState;

    const updated = recordPromptCardDecision(
      game,
      [candidate("winner", "card-1")],
      [candidate("loser", "card-2")],
      "2026-07-21T11:00:00.000Z",
      "Selected comparison winner",
    );

    expect(updated.promptDeck?.cards).toMatchObject([
      { id: "card-1", weight: 1.1, stats: { wins: 1, rejects: 0 } },
      { id: "card-2", weight: 3, stats: { wins: 0, rejects: 1 } },
    ]);
    expect(updated.promptDeck?.verdicts).toMatchObject([
      { cardId: "card-1", resultId: "winner", verdict: "win" },
      { cardId: "card-2", resultId: "loser", verdict: "reject" },
    ]);
  });
});
