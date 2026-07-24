import { describe, expect, it } from "vitest";
import type { Candidate, GameState, PromptDeck } from "./game";
import {
  createPromptCard,
  createPromptCardWriterRequest,
  drawPromptCard,
  emptyPromptDeck,
  preparePromptCardEditorJob,
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
      editorJob: null,
      blendJob: null,
      writerJob: null,
      suggestions: [],
    });
  });

  it("prepares a writer request with immutable candidate sources", () => {
    const sourceImage = {
      filename: `${"a".repeat(64)}.png`,
      path: `profile-sources/${"a".repeat(64)}.png`,
      contentType: "image/png" as const,
      width: 1024,
      height: 1024,
      byteLength: 2048,
    };
    expect(
      createPromptCardWriterRequest(
        ["one", "two", "three"].map((candidateId) => ({
          candidateId,
          concept: `Concept ${candidateId}`,
          style: ["editorial"],
          sourceImage,
        })),
        "writer-1",
        "2026-07-21T11:00:00.000Z",
      ),
    ).toMatchObject({
      id: "writer-1",
      kind: "prompt-card-writer",
      sources: [
        { candidateId: "one" },
        { candidateId: "two" },
        { candidateId: "three" },
      ],
    });
  });

  it("prepares one editor job after four recent rejections", () => {
    const rejectedDeck: PromptDeck = {
      ...deck,
      verdicts: Array.from({ length: 4 }, (_, index) => ({
        cardId: "card-2",
        resultId: `result-${index + 1}`,
        verdict: "reject" as const,
        reason: "Selected comparison winner",
        recordedAt: `2026-07-21T10:00:0${index}.000Z`,
      })),
      cards: deck.cards.map((item) =>
        item.id === "card-2"
          ? { ...item, stats: { ...item.stats, rejects: 4 } }
          : item,
      ),
    };

    const prepared = preparePromptCardEditorJob(
      rejectedDeck,
      () => "editor-1",
      "2026-07-21T11:00:00.000Z",
    );

    expect(prepared?.job).toMatchObject({
      id: "editor-1",
      kind: "prompt-card-editor",
      card: { id: "card-2", title: "Ecology" },
    });
    expect(prepared?.job.recentRejections).toHaveLength(4);
    expect(
      prepared?.deck.cards.find((item) => item.id === "card-2"),
    ).toMatchObject({ editorRejectCheckpoint: 4 });
    expect(
      preparePromptCardEditorJob(
        prepared!.deck,
        () => "editor-2",
        "2026-07-21T12:00:00.000Z",
      ),
    ).toBeNull();
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
