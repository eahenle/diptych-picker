"use client";

import { useCallback, useMemo, useState } from "react";
import {
  preferenceProfileFromSeed,
  type PreferencePreset,
  type PreferenceProfile,
  type PreferenceProfileSnapshot,
  type PreferenceRevision,
  type VariationSource,
} from "@/domain/game";
import type { PreferenceField } from "./preference-profile-modal";

function draftValuesMatch(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function usePreferenceDraft(historyLength: number | null) {
  const [profile, setProfile] = useState<PreferenceProfile>(() =>
    preferenceProfileFromSeed(""),
  );
  const [baseProfile, setBaseProfile] = useState<PreferenceProfile>(() =>
    preferenceProfileFromSeed(""),
  );
  const [variationSource, setVariationSource] =
    useState<VariationSource | null>(null);
  const [baseVariationSource, setBaseVariationSource] =
    useState<VariationSource | null>(null);
  const dirty = useMemo(
    () =>
      !draftValuesMatch(profile, baseProfile) ||
      !draftValuesMatch(variationSource, baseVariationSource),
    [baseProfile, baseVariationSource, profile, variationSource],
  );

  const replaceProfile = useCallback((next: PreferenceProfile) => {
    setProfile(next);
  }, []);

  const resetDraft = useCallback(
    (next: PreferenceProfile, source: VariationSource | null) => {
      setProfile(next);
      setBaseProfile(next);
      setVariationSource(source);
      setBaseVariationSource(source);
    },
    [],
  );

  const applyAnalyzedProfile = useCallback(
    (revision: PreferenceRevision, source: VariationSource | null) => {
      setProfile((current) => ({
        ...current,
        ...revision,
        adaptationLastDecision:
          historyLength ?? current.adaptationLastDecision ?? 0,
        adaptationSourceWinnerIds: [],
        adaptationSourceRejectedIds: [],
      }));
      setVariationSource(source);
    },
    [historyLength],
  );

  const applyPreset = useCallback(
    (preset: PreferencePreset) => {
      setProfile({
        ...preset.profile,
        adaptationLastDecision: historyLength ?? 0,
        adaptationSourceWinnerIds: [],
        adaptationSourceRejectedIds: [],
      });
      setVariationSource(null);
    },
    [historyLength],
  );

  const setField = useCallback(
    <Key extends PreferenceField>(key: Key, value: PreferenceProfile[Key]) => {
      setProfile((current) => ({
        ...current,
        [key]: value,
        adaptationLastDecision:
          historyLength ?? current.adaptationLastDecision ?? 0,
        adaptationSourceWinnerIds: [],
        adaptationSourceRejectedIds: [],
      }));
    },
    [historyLength],
  );

  const setFreedom = useCallback(
    (freedom: "frozen" | "guided" | "unfettered") => {
      setProfile((current) => ({
        ...current,
        adaptationMode: freedom === "frozen" ? "static" : "adaptive",
        adaptationStrength: freedom === "unfettered" ? "unfettered" : "guided",
        adaptationLastDecision: historyLength ?? 0,
        adaptationSourceWinnerIds:
          freedom === "frozen" ? [] : current.adaptationSourceWinnerIds,
        adaptationSourceRejectedIds:
          freedom === "frozen" ? [] : current.adaptationSourceRejectedIds,
      }));
    },
    [historyLength],
  );

  const restoreRevision = useCallback(
    (revision: PreferenceProfileSnapshot, frozen: boolean) => {
      setProfile(
        frozen
          ? {
              ...revision.profile,
              adaptationMode: "static",
              adaptationStrength: "guided",
              adaptationSourceWinnerIds: [],
              adaptationSourceRejectedIds: [],
            }
          : revision.profile,
      );
      setVariationSource(revision.variationSource ?? null);
    },
    [],
  );

  return {
    baseProfile,
    dirty,
    profile,
    variationSource,
    applyAnalyzedProfile,
    applyPreset,
    replaceProfile,
    resetDraft,
    restoreRevision,
    setField,
    setFreedom,
  };
}
