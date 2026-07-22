"use client";

import { useCallback, useState } from "react";
import type { GameState, PreferenceProfile } from "@/domain/game";
import { readJson } from "./game-api";

interface UsePreferencePresetsOptions {
  commitGame: (state: GameState) => void;
}

export function usePreferencePresets({
  commitGame,
}: UsePreferencePresetsOptions) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const savePreferencePreset = useCallback(
    async (name: string, profile: PreferenceProfile): Promise<boolean> => {
      setSaving(true);
      setError(null);
      try {
        const state = await readJson<GameState>(
          await fetch("/api/game/preferences/presets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, profile }),
          }),
        );
        commitGame(state);
        return true;
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : "Could not save preset",
        );
        return false;
      } finally {
        setSaving(false);
      }
    },
    [commitGame],
  );

  const deletePreferencePreset = useCallback(
    async (presetId: string) => {
      setSaving(true);
      setError(null);
      try {
        const state = await readJson<GameState>(
          await fetch("/api/game/preferences/presets", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ presetId }),
          }),
        );
        commitGame(state);
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : "Could not delete preset",
        );
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
    clearError,
    deletePreferencePreset,
    savePreferencePreset,
  };
}
