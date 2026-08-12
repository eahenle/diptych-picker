"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  isSelectionBoundWait,
  preferenceProfileFromSeed,
  type GameState,
  type PreferencePreset,
  type PreferenceProfile,
  type PreferenceProfileSnapshot,
  type PreferenceRevision,
  type VariationSource,
} from "@/domain/game";
import { readJson } from "./game-api";
import type { InspectableCandidate } from "./image-inspector";
import { usePreferencePresets } from "./use-preference-presets";
import { usePromptDeck } from "./use-prompt-deck";
import { useGameRules } from "./use-game-rules";

const SOURCE_PROFILE_POLL_INTERVAL_MS = 500;

type SourceProfileResponse =
  | { status: "analyzing"; jobId: string }
  | {
      status: "completed";
      jobId: string;
      profile: PreferenceRevision;
      reasoningSummary: string;
    }
  | { status: "failed"; jobId: string; message: string };

interface UsePreferenceEditorOptions {
  game: GameState | null;
  profile: PreferenceProfile;
  baseProfile: PreferenceProfile;
  draftDirty: boolean;
  variationSource: VariationSource | null;
  commitGame: (next: GameState) => void;
  dismissImageInspector: () => void;
  applyAnalyzedProfile: (
    revision: PreferenceRevision,
    source: VariationSource | null,
  ) => void;
  applyPresetDraft: (preset: PreferencePreset) => void;
  resetPreferenceDraft: (
    profile: PreferenceProfile,
    source: VariationSource | null,
  ) => void;
  restorePreferenceDraftRevision: (
    revision: PreferenceProfileSnapshot,
    frozen: boolean,
  ) => void;
  setLocalError: Dispatch<SetStateAction<string | null>>;
}

function waitForSourceProfilePoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Source analysis cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, SOURCE_PROFILE_POLL_INTERVAL_MS);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function usePreferenceEditor({
  game,
  profile,
  baseProfile,
  draftDirty,
  variationSource,
  commitGame,
  dismissImageInspector,
  applyAnalyzedProfile,
  applyPresetDraft,
  resetPreferenceDraft,
  restorePreferenceDraftRevision,
  setLocalError,
}: UsePreferenceEditorOptions) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveQueued, setSaveQueued] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [sourceAnalyzing, setSourceAnalyzing] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceSummary, setSourceSummary] = useState<string | null>(null);
  const [supplementalDirty, setSupplementalDirty] = useState(false);
  const sourceProfileControllerRef = useRef<AbortController | null>(null);
  const queuedProfileRef = useRef<PreferenceProfile | null>(null);
  const queuedVariationSourceRef = useRef<VariationSource | null>(null);
  const queuedSaveStartedRef = useRef(false);
  const selectionBoundWait = game ? isSelectionBoundWait(game) : false;

  const {
    error: promptDeckError,
    saving: promptDeckSaving,
    blendPromptCards,
    clearError: clearPromptDeckError,
    createPromptCard,
    updatePromptDeck,
    writeCustomPromptCard,
    writePromptCard,
  } = usePromptDeck({ commitGame });

  const {
    error: presetError,
    saving: presetSaving,
    clearError: clearPresetError,
    deletePreferencePreset,
    savePreferencePreset: savePreset,
  } = usePreferencePresets({ commitGame });

  const {
    rules: gameRules,
    saving: gameRulesSaving,
    error: gameRulesError,
    loadGameRules,
    updateGameRules,
  } = useGameRules({ commitGame });

  useEffect(() => () => sourceProfileControllerRef.current?.abort(), []);

  useEffect(() => {
    if (!open || (!draftDirty && !supplementalDirty)) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [draftDirty, open, supplementalDirty]);

  const persistPreferences = useCallback(
    async (
      nextProfile: PreferenceProfile,
      expectedProfile: PreferenceProfile,
      nextVariationSource: VariationSource | null,
    ) => {
      setSaving(true);
      setSaveError(null);
      try {
        const state = await readJson<GameState>(
          await fetch("/api/game", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              preferenceProfile: nextProfile,
              expectedPreferenceProfile: expectedProfile,
              variationSourceCandidateId:
                nextVariationSource?.candidateId ?? null,
            }),
          }),
        );
        commitGame(state);
        setOpen(false);
        setLocalError(null);
      } catch (error) {
        setSaveError(
          error instanceof Error ? error.message : "Could not save preferences",
        );
      } finally {
        queuedProfileRef.current = null;
        queuedVariationSourceRef.current = null;
        queuedSaveStartedRef.current = false;
        setSaveQueued(false);
        setSaving(false);
      }
    },
    [commitGame, setLocalError],
  );

  const savePreferences = useCallback(async () => {
    if (
      supplementalDirty &&
      !window.confirm(
        "Save the profile and discard other unfinished Preferences edits?",
      )
    ) {
      return;
    }
    if (selectionBoundWait) {
      queuedProfileRef.current = profile;
      queuedVariationSourceRef.current = variationSource;
      queuedSaveStartedRef.current = false;
      setSaveQueued(true);
      setSaving(true);
      setSaveError(null);
      setLocalError(null);
      return;
    }
    await persistPreferences(profile, baseProfile, variationSource);
  }, [
    baseProfile,
    persistPreferences,
    profile,
    selectionBoundWait,
    setLocalError,
    supplementalDirty,
    variationSource,
  ]);

  const savePreferencePreset = useCallback(
    (name: string): Promise<boolean> => savePreset(name, profile),
    [profile, savePreset],
  );

  const applyPreferencePreset = useCallback(
    (preset: PreferencePreset) => {
      applyPresetDraft(preset);
      setSourceError(null);
      setSourceSummary(
        `Preset “${preset.name}” applied to the draft. Review it, then save to apply.`,
      );
    },
    [applyPresetDraft],
  );

  const analyzeSourceImage = useCallback(
    async (image: File, nextVariationSource: VariationSource | null = null) => {
      if (sourceAnalyzing || saving) return;
      const controller = new AbortController();
      sourceProfileControllerRef.current?.abort();
      sourceProfileControllerRef.current = controller;
      setSourceAnalyzing(true);
      setSourceError(null);
      setSourceSummary(null);
      try {
        const form = new FormData();
        form.set("image", image);
        let result = await readJson<SourceProfileResponse>(
          await fetch("/api/game/preferences/source", {
            method: "POST",
            body: form,
            signal: controller.signal,
          }),
        );
        while (result.status === "analyzing") {
          await waitForSourceProfilePoll(controller.signal);
          result = await readJson<SourceProfileResponse>(
            await fetch(
              `/api/game/preferences/source?jobId=${encodeURIComponent(result.jobId)}`,
              { cache: "no-store", signal: controller.signal },
            ),
          );
        }
        if (result.status === "failed") throw new Error(result.message);
        applyAnalyzedProfile(result.profile, nextVariationSource);
        setSourceSummary(result.reasoningSummary);
        const acknowledged = await fetch(
          `/api/game/preferences/source?jobId=${encodeURIComponent(result.jobId)}`,
          { method: "DELETE", signal: controller.signal },
        );
        if (!acknowledged.ok) {
          throw new Error(
            "The profile was populated, but its analysis job could not be archived.",
          );
        }
      } catch (error) {
        if (
          !controller.signal.aborted &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          setSourceError(
            error instanceof Error
              ? error.message
              : "Could not analyze the source image",
          );
        }
      } finally {
        if (sourceProfileControllerRef.current === controller) {
          sourceProfileControllerRef.current = null;
          setSourceAnalyzing(false);
        }
      }
    },
    [applyAnalyzedProfile, saving, sourceAnalyzing],
  );

  const closePreferences = useCallback(() => {
    if (
      saving ||
      sourceAnalyzing ||
      presetSaving ||
      promptDeckSaving ||
      gameRulesSaving
    )
      return;
    if (
      (draftDirty || supplementalDirty) &&
      !window.confirm("Discard unsaved preference changes?")
    ) {
      return;
    }
    setOpen(false);
  }, [
    draftDirty,
    gameRulesSaving,
    presetSaving,
    promptDeckSaving,
    saving,
    sourceAnalyzing,
    supplementalDirty,
  ]);

  const openPreferences = useCallback(() => {
    if (!game) return;
    const currentProfile =
      game.preferenceProfile ?? preferenceProfileFromSeed(game.preferenceSeed);
    queuedProfileRef.current = null;
    queuedVariationSourceRef.current = null;
    queuedSaveStartedRef.current = false;
    setSaveQueued(false);
    setSaving(false);
    setSaveError(null);
    setSourceError(null);
    setSourceSummary(null);
    setSupplementalDirty(false);
    clearPresetError();
    clearPromptDeckError();
    resetPreferenceDraft(currentProfile, game.variationSource ?? null);
    setOpen(true);
    void loadGameRules();
  }, [
    clearPresetError,
    clearPromptDeckError,
    game,
    loadGameRules,
    resetPreferenceDraft,
  ]);

  const exploreCandidateVariations = useCallback(
    async (candidate: InspectableCandidate) => {
      dismissImageInspector();
      openPreferences();
      try {
        const response = await fetch(candidate.imageUrl, {
          cache: "force-cache",
        });
        if (!response.ok) {
          throw new Error(
            "The selected image could not be loaded for analysis.",
          );
        }
        const contents = await response.blob();
        const contentType = contents.type || "image/png";
        const extension =
          contentType === "image/jpeg"
            ? "jpg"
            : contentType === "image/webp"
              ? "webp"
              : "png";
        await analyzeSourceImage(
          new File([contents], `${candidate.id}.${extension}`, {
            type: contentType,
          }),
          { candidateId: candidate.id, concept: candidate.concept },
        );
      } catch (error) {
        setSourceError(
          error instanceof Error
            ? error.message
            : "Could not analyze the selected image",
        );
      }
    },
    [analyzeSourceImage, dismissImageInspector, openPreferences],
  );

  const restorePreferenceRevision = useCallback(
    (revision: PreferenceProfileSnapshot, frozen: boolean) => {
      restorePreferenceDraftRevision(revision, frozen);
      setSourceError(null);
      setSourceSummary(
        frozen
          ? "Revision restored as a frozen draft. Review it, then save to apply."
          : "Revision restored as an editable draft. Review it, then save to apply.",
      );
    },
    [restorePreferenceDraftRevision],
  );

  useEffect(() => {
    if (
      !saveQueued ||
      selectionBoundWait ||
      !game ||
      queuedSaveStartedRef.current
    ) {
      return;
    }
    const queuedProfile = queuedProfileRef.current;
    if (!queuedProfile) return;
    const currentProfile =
      game.preferenceProfile ?? preferenceProfileFromSeed(game.preferenceSeed);
    queuedSaveStartedRef.current = true;
    void persistPreferences(
      queuedProfile,
      currentProfile,
      queuedVariationSourceRef.current,
    );
  }, [game, persistPreferences, saveQueued, selectionBoundWait]);

  return {
    open,
    saving,
    saveQueued,
    saveError,
    sourceAnalyzing,
    sourceError,
    sourceSummary,
    selectionBoundWait,
    presetError,
    presetSaving,
    promptDeckError,
    promptDeckSaving,
    gameRules,
    gameRulesError,
    gameRulesSaving,
    applyPreferencePreset,
    blendPromptCards,
    closePreferences,
    createPromptCard,
    deletePreferencePreset,
    exploreCandidateVariations,
    openPreferences,
    restorePreferenceRevision,
    savePreferencePreset,
    savePreferences,
    analyzeSourceImage,
    setSupplementalDirty,
    updatePromptDeck,
    updateGameRules,
    writeCustomPromptCard,
    writePromptCard,
  };
}
