"use client";

import { useCallback, useState } from "react";
import type { GameRules, GameState } from "@/domain/game";
import { readJson } from "./game-api";

interface UseGameRulesOptions {
  commitGame: (state: GameState) => void;
}

export function useGameRules({ commitGame }: UseGameRulesOptions) {
  const [rules, setRules] = useState<GameRules | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadGameRules = useCallback(async () => {
    setError(null);
    try {
      const response = await readJson<{ rules: GameRules }>(
        await fetch("/api/game/rules", { cache: "no-store" }),
      );
      setRules(response.rules);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not load game rules",
      );
    }
  }, []);

  const updateGameRules = useCallback(
    async (nextRules: GameRules): Promise<boolean> => {
      setSaving(true);
      setError(null);
      try {
        const state = await readJson<GameState>(
          await fetch("/api/game/rules", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(nextRules),
          }),
        );
        setRules(state.gameRules ?? nextRules);
        commitGame(state);
        return true;
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not update game rules",
        );
        return false;
      } finally {
        setSaving(false);
      }
    },
    [commitGame],
  );

  return {
    rules,
    saving,
    error,
    loadGameRules,
    updateGameRules,
  };
}
