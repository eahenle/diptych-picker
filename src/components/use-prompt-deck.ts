"use client";

import { useCallback, useState } from "react";
import type { GameState } from "@/domain/game";
import { readJson } from "./game-api";

interface PromptCardInput {
  title: string;
  prompt: string;
  negativePrompt: string;
  weight: number;
  tags: string[];
}

type PromptDeckUpdate =
  | { kind: "deck"; enabled: boolean }
  | { kind: "card"; cardId: string; active?: boolean; weight?: number }
  | {
      kind: "suggestion";
      suggestionId: string;
      action: "accept" | "discard";
    };

interface UsePromptDeckOptions {
  commitGame: (state: GameState) => void;
}

export function usePromptDeck({ commitGame }: UsePromptDeckOptions) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createPromptCard = useCallback(
    async (input: PromptCardInput): Promise<boolean> => {
      setSaving(true);
      setError(null);
      try {
        const state = await readJson<GameState>(
          await fetch("/api/game/preferences/deck", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          }),
        );
        commitGame(state);
        return true;
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not create prompt card",
        );
        return false;
      } finally {
        setSaving(false);
      }
    },
    [commitGame],
  );

  const updatePromptDeck = useCallback(
    async (update: PromptDeckUpdate) => {
      setSaving(true);
      setError(null);
      try {
        const state = await readJson<GameState>(
          await fetch("/api/game/preferences/deck", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(update),
          }),
        );
        commitGame(state);
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not update prompt deck",
        );
      } finally {
        setSaving(false);
      }
    },
    [commitGame],
  );

  const blendPromptCards = useCallback(
    async (cardIds: [string, string]): Promise<boolean> => {
      setSaving(true);
      setError(null);
      try {
        const state = await readJson<GameState>(
          await fetch("/api/game/preferences/deck/blend", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cardIds, ratio: 0.5 }),
          }),
        );
        commitGame(state);
        return true;
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not blend prompt cards",
        );
        return false;
      } finally {
        setSaving(false);
      }
    },
    [commitGame],
  );

  const writePromptCard = useCallback(
    async (candidateIds: string[]): Promise<boolean> => {
      setSaving(true);
      setError(null);
      try {
        const state = await readJson<GameState>(
          await fetch("/api/game/preferences/deck/write", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ candidateIds }),
          }),
        );
        commitGame(state);
        return true;
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not write a prompt card from those images",
        );
        return false;
      } finally {
        setSaving(false);
      }
    },
    [commitGame],
  );

  const writeCustomPromptCard = useCallback(
    async (input: {
      guidance: string;
      images: readonly File[];
    }): Promise<boolean> => {
      setSaving(true);
      setError(null);
      try {
        const form = new FormData();
        if (input.guidance.trim()) form.set("guidance", input.guidance.trim());
        for (const image of input.images) form.append("images", image);
        const state = await readJson<GameState>(
          await fetch("/api/game/preferences/deck/write/custom", {
            method: "POST",
            body: form,
          }),
        );
        commitGame(state);
        return true;
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not draft a prompt card from those sources",
        );
        return false;
      } finally {
        setSaving(false);
      }
    },
    [commitGame],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    error,
    saving,
    blendPromptCards,
    clearError,
    createPromptCard,
    updatePromptDeck,
    writeCustomPromptCard,
    writePromptCard,
  };
}
