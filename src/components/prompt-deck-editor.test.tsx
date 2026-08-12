// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptDeck } from "@/domain/game";
import { PromptDeckEditor } from "./prompt-deck-editor";

afterEach(cleanup);

const deck: PromptDeck = {
  enabled: true,
  cards: [
    {
      id: "card-1",
      title: "Copper nocturne",
      prompt: "A severe copper-lit industrial editorial portrait.",
      negativePrompt: "readable text",
      weight: 1.1,
      tags: ["portrait", "copper"],
      parents: [],
      active: true,
      createdAt: "2026-07-21T10:00:00.000Z",
      stats: { wins: 1, rejects: 2 },
    },
  ],
  verdicts: [],
  suggestions: [
    {
      id: "suggestion-1",
      parentCardId: "card-1",
      title: "Copper nocturne — focused",
      prompt:
        "A focused copper-lit portrait with a quieter industrial background.",
      negativePrompt: "readable text",
      tags: ["portrait", "copper"],
      reasoningSummary: "Simplifies the competing background detail.",
      createdAt: "2026-07-21T11:00:00.000Z",
    },
  ],
};

describe("PromptDeckEditor", () => {
  it("drafts a reviewable card from text and seed images", async () => {
    const onWrite = vi.fn(async () => true);
    render(
      <PromptDeckEditor
        deck={deck}
        busy={false}
        error={null}
        onCreate={vi.fn(async () => true)}
        onUpdate={vi.fn(async () => undefined)}
        onBlend={vi.fn(async () => true)}
        onWrite={onWrite}
      />,
    );

    fireEvent.click(screen.getByText("Prompt deck"));
    fireEvent.change(screen.getByLabelText("Text guidance"), {
      target: { value: "Keep the cold monumental negative space." },
    });
    const seed = new File(["seed"], "seed.webp", { type: "image/webp" });
    fireEvent.change(screen.getByLabelText("Seed images"), {
      target: { files: [seed] },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Draft reviewable card" }),
    );

    await waitFor(() =>
      expect(onWrite).toHaveBeenCalledWith({
        guidance: "Keep the cold monumental negative space.",
        images: [seed],
      }),
    );
  });

  it("selects two active cards for a balanced blend", async () => {
    const onBlend = vi.fn(async () => true);
    const second = {
      ...deck.cards[0],
      id: "card-2",
      title: "Glass botany",
      prompt: "Translucent botanical structures in soft green daylight.",
    };
    render(
      <PromptDeckEditor
        deck={{ ...deck, cards: [...deck.cards, second] }}
        busy={false}
        error={null}
        onCreate={vi.fn(async () => true)}
        onUpdate={vi.fn(async () => undefined)}
        onBlend={onBlend}
        onWrite={vi.fn(async () => true)}
      />,
    );

    fireEvent.click(screen.getByText("Prompt deck"));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Select Copper nocturne for blend",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select Glass botany for blend" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Blend selected 50/50" }),
    );

    await waitFor(() =>
      expect(onBlend).toHaveBeenCalledWith(["card-1", "card-2"]),
    );
  });

  it("creates immutable cards and delegates deck controls", async () => {
    const onCreate = vi.fn(async () => true);
    const onUpdate = vi.fn(async () => undefined);
    render(
      <PromptDeckEditor
        deck={deck}
        busy={false}
        error={null}
        onCreate={onCreate}
        onUpdate={onUpdate}
        onBlend={vi.fn(async () => true)}
        onWrite={vi.fn(async () => true)}
      />,
    );

    fireEvent.click(screen.getByText("Prompt deck"));
    expect(screen.getByText("1W · 2R")).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onUpdate).toHaveBeenCalledWith({ kind: "deck", enabled: false });
    fireEvent.click(
      screen.getByRole("button", { name: "Increase Copper nocturne weight" }),
    );
    expect(onUpdate).toHaveBeenCalledWith({
      kind: "card",
      cardId: "card-1",
      weight: 1.2100000000000002,
    });
    fireEvent.click(screen.getByRole("button", { name: "Accept as new card" }));
    expect(onUpdate).toHaveBeenCalledWith({
      kind: "suggestion",
      suggestionId: "suggestion-1",
      action: "accept",
    });

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Strange ecology" },
    });
    fireEvent.change(screen.getByLabelText("Prompt direction"), {
      target: {
        value: "An uncanny ecosystem rendered as tactile macro photography.",
      },
    });
    fireEvent.change(screen.getByLabelText("Tags"), {
      target: { value: "ecology, macro" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add card" }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        title: "Strange ecology",
        prompt: "An uncanny ecosystem rendered as tactile macro photography.",
        negativePrompt: "",
        weight: 1,
        tags: ["ecology", "macro"],
      }),
    );
    expect(screen.getByLabelText("Title")).toHaveValue("");
  });
});
