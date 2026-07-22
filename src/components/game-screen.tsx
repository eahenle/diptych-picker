"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  isSelectionBoundWait,
  preferenceProfileFromSeed,
  type BufferHealth,
  type DisplayedEloRatings,
  type GameStartState,
  type GameState,
  type PreferenceProfile,
  type PreferencePreset,
  type PreferenceProfileSnapshot,
  type PreferenceRevision,
  type VariationSource,
} from "@/domain/game";
import { CandidateCard } from "./candidate-card";
import { ComparisonHistory } from "./comparison-history";
import { readJson } from "./game-api";
import { GameTransferModal } from "./game-transfer-modal";
import { ImageInspector, type InspectableCandidate } from "./image-inspector";
import { PoolLeaderboard } from "./pool-leaderboard";
import { QueueDetails } from "./queue-details";
import { PreferenceProfileModal } from "./preference-profile-modal";
import { useCandidateBrowser } from "./use-candidate-browser";
import { useGameTransfer } from "./use-game-transfer";
import { useGameplayShortcuts } from "./use-gameplay-shortcuts";
import { usePreferenceDraft } from "./use-preference-draft";
import { usePreferencePresets } from "./use-preference-presets";
import { usePromptDeck } from "./use-prompt-deck";
import { useSelectionController } from "./use-selection-controller";
import styles from "./game-screen.module.css";

const POLL_INTERVAL_MS = 150;
const HEALTH_POLL_INTERVAL_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 2_400;
const RECONNECT_MESSAGE = "Connection interrupted. Reconnecting…";
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

function reconnectDelay(attempt: number): number {
  return Math.min(
    POLL_INTERVAL_MS * 2 ** Math.min(attempt, 8),
    MAX_RECONNECT_DELAY_MS,
  );
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

type HeaderPictographName = "export" | "load" | "preferences" | "new";

function HeaderPictograph({ name }: { name: HeaderPictographName }) {
  const paths: Record<HeaderPictographName, ReactNode> = {
    export: (
      <>
        <path d="M12 3v12" />
        <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
        <path d="M4 19h16" />
      </>
    ),
    load: (
      <>
        <path d="M3.5 7.5h6l2-2h9v13h-17z" />
        <path d="M8 13h8" />
        <path d="m13 10 3 3-3 3" />
      </>
    ),
    preferences: (
      <>
        <path d="M4 6h8M16 6h4M4 12h3M11 12h9M4 18h10M18 18h2" />
        <circle cx="14" cy="6" r="2" />
        <circle cx="9" cy="12" r="2" />
        <circle cx="16" cy="18" r="2" />
      </>
    ),
    new: (
      <>
        <path d="M12 3v18M3 12h18" />
        <path d="m5 4 .5 1.5L7 6l-1.5.5L5 8l-.5-1.5L3 6l1.5-.5z" />
      </>
    ),
  };

  return (
    <svg
      className={styles.headerPictograph}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}

export function GameScreen() {
  const [game, setGame] = useState<GameState | null>(null);
  const [startState, setStartState] = useState<GameStartState | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [preferencesSaving, setPreferencesSaving] = useState(false);
  const [preferenceSaveQueued, setPreferenceSaveQueued] = useState(false);
  const [sourceProfileAnalyzing, setSourceProfileAnalyzing] = useState(false);
  const [sourceProfileError, setSourceProfileError] = useState<string | null>(
    null,
  );
  const [sourceProfileSummary, setSourceProfileSummary] = useState<
    string | null
  >(null);
  const [queueDetailsOpen, setQueueDetailsOpen] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<string | null>(null);
  const [bufferHealth, setBufferHealth] = useState<BufferHealth | null>(null);
  const [eloRatings, setEloRatings] = useState<DisplayedEloRatings | null>(
    null,
  );
  const healthPollingEnabled = game !== null && bufferHealth !== null;
  const healthRound = game?.round.roundNumber ?? null;
  const gameRef = useRef<GameState | null>(null);
  const initialPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const sourceProfileControllerRef = useRef<AbortController | null>(null);
  const queuedPreferenceProfileRef = useRef<PreferenceProfile | null>(null);
  const queuedPreferenceVariationSourceRef = useRef<VariationSource | null>(
    null,
  );
  const queuedPreferenceSaveStartedRef = useRef(false);
  const {
    baseProfile: preferenceDraftBaseProfile,
    profile: preferenceDraft,
    variationSource: preferenceVariationSource,
    applyAnalyzedProfile,
    applyPreset: applyPresetDraft,
    replaceProfile: replacePreferenceDraft,
    resetDraft: resetPreferenceDraft,
    restoreRevision: restorePreferenceDraftRevision,
    setField: setPreferenceField,
    setFreedom: setAdaptationFreedom,
  } = usePreferenceDraft(game?.history.length ?? null);
  const commitGame = useCallback((next: GameState) => {
    gameRef.current = next;
    setGame(next);
  }, []);

  const {
    error: promptDeckError,
    saving: promptDeckSaving,
    blendPromptCards,
    clearError: clearPromptDeckError,
    createPromptCard,
    updatePromptDeck,
  } = usePromptDeck({ commitGame });

  const {
    error: presetError,
    saving: presetSaving,
    clearError: clearPresetError,
    deletePreferencePreset,
    savePreferencePreset: savePreset,
  } = usePreferencePresets({ commitGame });

  const commitStartState = useCallback(
    (next: GameStartState) => {
      setStartState(next);
      if (next.status === "ready") {
        commitGame(next.game);
        setBufferHealth(next.bufferHealth ?? null);
        setEloRatings(next.eloRatings ?? null);
        replacePreferenceDraft(
          next.game.preferenceProfile ??
            preferenceProfileFromSeed(next.game.preferenceSeed),
        );
      } else {
        gameRef.current = null;
        setGame(null);
        setBufferHealth(null);
        setEloRatings(null);
        replacePreferenceDraft(preferenceProfileFromSeed(next.preferenceSeed));
      }
    },
    [commitGame, replacePreferenceDraft],
  );

  const {
    cancelActiveSelection,
    reconcilingRetry,
    selectionLockedRef: selectionLocked,
    bothLose,
    retrySelection,
    select,
    tie,
  } = useSelectionController({
    game,
    gameRef,
    commitGame,
    commitStartState,
    setConnectionStatus,
    setEloRatings,
    setLocalError,
  });

  const {
    action: gameTransferAction,
    error: gameTransferError,
    exportNotice,
    loadGameOpen,
    newGameOpen,
    closeLoadGame,
    closeNewGame,
    exportCurrentGame,
    importSavedGame,
    openLoadGame,
    openNewGame,
    startFreshGame,
  } = useGameTransfer({
    gameRef,
    selectionLockedRef: selectionLocked,
    commitStartState,
    cancelActiveSelection,
    setInitializing,
    setLocalError,
  });

  const {
    favoriteError,
    favoriteSaving,
    historyEntries,
    historyError,
    historyLoading,
    historyOpen,
    historyTotal,
    imageInspector,
    leaderboardEntries,
    leaderboardError,
    leaderboardLoading,
    leaderboardOpen,
    closeComparisonHistory,
    closeImageInspector,
    closePoolLeaderboard,
    dismissImageInspector,
    inspectHistoryCandidate,
    inspectLeaderboardCandidate,
    navigateImageInspector,
    openComparisonHistory,
    openImageInspector,
    openPoolLeaderboard,
    updateFavorite,
  } = useCandidateBrowser({ gameRef });

  useEffect(() => {
    let active = true;
    let retryAttempt = 0;
    const load = async (): Promise<void> => {
      if (!active) return;
      try {
        const state = await readJson<GameStartState>(
          await fetch("/api/game", { cache: "no-store" }),
        );
        if (!active) return;
        commitStartState(state);
        setInitializing(false);
        setLocalError(null);
        setConnectionStatus(null);
      } catch {
        if (!active) return;
        setConnectionStatus(RECONNECT_MESSAGE);
        initialPollTimerRef.current = setTimeout(
          () => void load(),
          reconnectDelay(retryAttempt),
        );
        retryAttempt += 1;
      }
    };
    void load();
    return () => {
      active = false;
      if (initialPollTimerRef.current)
        clearTimeout(initialPollTimerRef.current);
      initialPollTimerRef.current = null;
    };
  }, [commitStartState]);

  useEffect(() => {
    if (startState?.status !== "initializing") return;
    let active = true;
    let retryAttempt = 0;

    const poll = async (): Promise<void> => {
      if (!active) return;
      try {
        const response = await readJson<GameStartState>(
          await fetch("/api/game", { cache: "no-store" }),
        );
        if (!active) return;
        if (response.status === "initializing") {
          retryAttempt = 0;
          setConnectionStatus(null);
          initialPollTimerRef.current = setTimeout(
            () => void poll(),
            POLL_INTERVAL_MS,
          );
          return;
        }
        commitStartState(response);
        setLocalError(null);
        setConnectionStatus(null);
      } catch {
        if (!active) return;
        setConnectionStatus(RECONNECT_MESSAGE);
        initialPollTimerRef.current = setTimeout(
          () => void poll(),
          reconnectDelay(retryAttempt),
        );
        retryAttempt += 1;
      }
    };

    initialPollTimerRef.current = setTimeout(
      () => void poll(),
      POLL_INTERVAL_MS,
    );
    return () => {
      active = false;
      if (initialPollTimerRef.current) {
        clearTimeout(initialPollTimerRef.current);
      }
      initialPollTimerRef.current = null;
    };
  }, [commitStartState, startState?.status]);

  useEffect(() => () => sourceProfileControllerRef.current?.abort(), []);

  useEffect(() => {
    if (!healthPollingEnabled) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const health = await readJson<BufferHealth>(
          await fetch("/api/game/health", { cache: "no-store" }),
        );
        if (active) setBufferHealth(health);
      } catch {
        // Health is supporting information; gameplay reconnects separately.
      } finally {
        if (active)
          timer = setTimeout(() => void poll(), HEALTH_POLL_INTERVAL_MS);
      }
    };

    timer = setTimeout(() => void poll(), HEALTH_POLL_INTERVAL_MS);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [healthPollingEnabled, healthRound]);

  const promptCardBackgroundJobIds = [
    game?.promptDeck?.editorJob?.jobId,
    game?.promptDeck?.blendJob?.jobId,
  ].filter((jobId): jobId is string => Boolean(jobId));
  const promptCardBackgroundJobKey = promptCardBackgroundJobIds.join(":");
  useEffect(() => {
    if (!promptCardBackgroundJobKey) return;
    const watchedJobIds = new Set(promptCardBackgroundJobKey.split(":"));
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const response = await readJson<GameStartState>(
          await fetch("/api/game", { cache: "no-store" }),
        );
        if (!active || response.status !== "ready") return;
        commitGame(response.game);
        const activeJobIds = [
          response.game.promptDeck?.editorJob?.jobId,
          response.game.promptDeck?.blendJob?.jobId,
        ];
        if (activeJobIds.some((jobId) => jobId && watchedJobIds.has(jobId))) {
          timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
        }
      } catch {
        if (active) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    };

    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [commitGame, promptCardBackgroundJobKey]);

  useGameplayShortcuts({
    suspended:
      preferencesOpen ||
      newGameOpen ||
      loadGameOpen ||
      leaderboardOpen ||
      queueDetailsOpen ||
      historyOpen ||
      Boolean(imageInspector),
    onSelect: select,
    onTie: tie,
    onBothLose: bothLose,
  });

  const retryInitial = async () => {
    setInitializing(true);
    try {
      const state = await readJson<GameStartState>(
        await fetch("/api/game/start", { method: "POST" }),
      );
      commitStartState(state);
      setLocalError(null);
    } catch (error) {
      setLocalError(
        error instanceof Error
          ? error.message
          : "Could not retry initial generation",
      );
    } finally {
      setInitializing(false);
    }
  };

  const persistPreferences = useCallback(
    async (
      profile: PreferenceProfile,
      expectedProfile: PreferenceProfile,
      variationSource: VariationSource | null,
    ) => {
      setPreferencesSaving(true);
      try {
        const state = await readJson<GameState>(
          await fetch("/api/game", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              preferenceProfile: profile,
              expectedPreferenceProfile: expectedProfile,
              variationSourceCandidateId: variationSource?.candidateId ?? null,
            }),
          }),
        );
        commitGame(state);
        setPreferencesOpen(false);
        setLocalError(null);
      } catch (error) {
        setLocalError(
          error instanceof Error ? error.message : "Could not save preferences",
        );
      } finally {
        queuedPreferenceProfileRef.current = null;
        queuedPreferenceVariationSourceRef.current = null;
        queuedPreferenceSaveStartedRef.current = false;
        setPreferenceSaveQueued(false);
        setPreferencesSaving(false);
      }
    },
    [commitGame],
  );

  const savePreferences = async () => {
    if (selectionBoundWait) {
      queuedPreferenceProfileRef.current = preferenceDraft;
      queuedPreferenceVariationSourceRef.current = preferenceVariationSource;
      queuedPreferenceSaveStartedRef.current = false;
      setPreferenceSaveQueued(true);
      setPreferencesSaving(true);
      setLocalError(null);
      return;
    }
    await persistPreferences(
      preferenceDraft,
      preferenceDraftBaseProfile,
      preferenceVariationSource,
    );
  };

  const savePreferencePreset = (name: string): Promise<boolean> =>
    savePreset(name, preferenceDraft);

  const applyPreferencePreset = (preset: PreferencePreset) => {
    applyPresetDraft(preset);
    setSourceProfileError(null);
    setSourceProfileSummary(
      `Preset “${preset.name}” applied to the draft. Review it, then save to apply.`,
    );
  };

  const analyzeSourceImage = async (
    image: File,
    variationSource: VariationSource | null = null,
  ) => {
    if (sourceProfileAnalyzing || preferencesSaving) return;
    const controller = new AbortController();
    sourceProfileControllerRef.current?.abort();
    sourceProfileControllerRef.current = controller;
    setSourceProfileAnalyzing(true);
    setSourceProfileError(null);
    setSourceProfileSummary(null);
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
      applyAnalyzedProfile(result.profile, variationSource);
      setSourceProfileSummary(result.reasoningSummary);
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
        setSourceProfileError(
          error instanceof Error
            ? error.message
            : "Could not analyze the source image",
        );
      }
    } finally {
      if (sourceProfileControllerRef.current === controller) {
        sourceProfileControllerRef.current = null;
        setSourceProfileAnalyzing(false);
      }
    }
  };

  const closePreferences = () => {
    if (
      preferencesSaving ||
      sourceProfileAnalyzing ||
      presetSaving ||
      promptDeckSaving
    )
      return;
    setPreferencesOpen(false);
  };

  const openPreferences = () => {
    if (!game) return;
    const currentProfile =
      game.preferenceProfile ?? preferenceProfileFromSeed(game.preferenceSeed);
    queuedPreferenceProfileRef.current = null;
    queuedPreferenceVariationSourceRef.current = null;
    queuedPreferenceSaveStartedRef.current = false;
    setPreferenceSaveQueued(false);
    setPreferencesSaving(false);
    setSourceProfileError(null);
    setSourceProfileSummary(null);
    clearPresetError();
    clearPromptDeckError();
    resetPreferenceDraft(currentProfile, game.variationSource ?? null);
    setPreferencesOpen(true);
  };

  const exploreCandidateVariations = async (
    candidate: InspectableCandidate,
  ) => {
    dismissImageInspector();
    openPreferences();
    try {
      const response = await fetch(candidate.imageUrl, {
        cache: "force-cache",
      });
      if (!response.ok) {
        throw new Error("The selected image could not be loaded for analysis.");
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
      setSourceProfileError(
        error instanceof Error
          ? error.message
          : "Could not analyze the selected image",
      );
    }
  };

  const dismissGenerationNotice = async () => {
    try {
      const state = await readJson<GameState>(
        await fetch("/api/game/notice", { method: "DELETE" }),
      );
      commitGame(state);
      setLocalError(null);
    } catch (error) {
      setLocalError(
        error instanceof Error
          ? error.message
          : "Could not dismiss the generation notice",
      );
    }
  };

  const restorePreferenceRevision = (
    revision: PreferenceProfileSnapshot,
    frozen: boolean,
  ) => {
    restorePreferenceDraftRevision(revision, frozen);
    setSourceProfileError(null);
    setSourceProfileSummary(
      frozen
        ? "Revision restored as a frozen draft. Review it, then save to apply."
        : "Revision restored as an editable draft. Review it, then save to apply.",
    );
  };

  const retryAvailable =
    game?.round.status === "error" && Boolean(game.pendingSelection);
  const status = game?.round.status;
  const streak = game?.round.winStreak ?? 0;
  const selectionBoundWait = game ? isSelectionBoundWait(game) : false;
  const retirementLoading =
    status === "generating" && game?.pendingSelection?.kind === "retirement";
  const tieLoading =
    status === "generating" && game?.pendingSelection?.kind === "tie";
  const bothLoseLoading =
    status === "generating" && game?.pendingSelection?.kind === "both-lose";
  const bothCandidatesLoading =
    retirementLoading || tieLoading || bothLoseLoading;
  const bufferStatus = bufferHealth
    ? bufferHealth.ready >= bufferHealth.target
      ? "ready"
      : bufferHealth.inFlight > 0
        ? "refilling"
        : "low"
    : null;

  useEffect(() => {
    if (
      !preferenceSaveQueued ||
      selectionBoundWait ||
      !game ||
      queuedPreferenceSaveStartedRef.current
    ) {
      return;
    }
    const queuedProfile = queuedPreferenceProfileRef.current;
    if (!queuedProfile) return;
    const currentProfile =
      game.preferenceProfile ?? preferenceProfileFromSeed(game.preferenceSeed);
    queuedPreferenceSaveStartedRef.current = true;
    void persistPreferences(
      queuedProfile,
      currentProfile,
      queuedPreferenceVariationSourceRef.current,
    );
  }, [game, persistPreferences, preferenceSaveQueued, selectionBoundWait]);

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <h1>
          Di<em>pycker</em>
        </h1>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.utilityButton}
            aria-label={
              gameTransferAction === "exporting" ? "Exporting game" : "Export"
            }
            title="Export current game"
            disabled={
              !game ||
              reconcilingRetry ||
              initializing ||
              gameTransferAction !== null
            }
            onClick={() => void exportCurrentGame()}
          >
            <HeaderPictograph name="export" />
          </button>
          <button
            type="button"
            className={styles.utilityButton}
            aria-label="Load"
            title="Load saved game"
            disabled={
              !game ||
              status === "generating" ||
              reconcilingRetry ||
              initializing ||
              gameTransferAction !== null
            }
            onClick={openLoadGame}
          >
            <HeaderPictograph name="load" />
          </button>
          <button
            type="button"
            className={styles.utilityButton}
            aria-label="Preferences"
            title="Preferences"
            disabled={!game || reconcilingRetry || initializing}
            onClick={openPreferences}
          >
            <HeaderPictograph name="preferences" />
          </button>
          <button
            type="button"
            className={styles.newGameButton}
            aria-label="New game"
            title="New game"
            disabled={
              status === "generating" ||
              reconcilingRetry ||
              initializing ||
              gameTransferAction !== null
            }
            onClick={openNewGame}
          >
            <HeaderPictograph name="new" />
          </button>
        </div>
      </header>

      {initializing && !game ? (
        <div className={styles.startState}>Preparing the gallery…</div>
      ) : null}

      {!initializing && startState?.status === "initializing" ? (
        <div className={styles.startState}>Creating your first comparison…</div>
      ) : null}

      {!initializing && startState?.status === "initialization-error" ? (
        <div className={styles.errorBar} role="alert">
          <span>{startState.errorMessage}</span>
          <button type="button" onClick={() => void retryInitial()}>
            Retry
          </button>
        </div>
      ) : null}

      {connectionStatus ? (
        <div className={styles.errorBar} role="status">
          <span>{connectionStatus}</span>
        </div>
      ) : null}

      {game ? (
        <>
          <section className={styles.metrics} aria-label="Game status">
            <button
              type="button"
              className={styles.metricButton}
              aria-label={`View comparison history; ${game.history.length} decisions`}
              title="View comparison history"
              onClick={() => void openComparisonHistory()}
            >
              Round <strong>{game.round.roundNumber}</strong>
            </button>
            <i aria-hidden="true" />
            <span>
              Win streak <strong>{streak}</strong>
            </span>
            {bufferHealth && bufferStatus ? (
              <>
                <i aria-hidden="true" />
                <button
                  type="button"
                  className={`${styles.supplyMetric} ${styles.metricButton}`}
                  aria-label={`View queue details; ${bufferHealth.ready} ready, ${bufferHealth.active} generating, ${bufferHealth.pending} waiting`}
                  title="View generation queue details"
                  onClick={() => setQueueDetailsOpen(true)}
                >
                  <span
                    className={styles.healthDot}
                    data-status={bufferStatus}
                    aria-hidden="true"
                  />
                  Queue
                  <strong>
                    {bufferHealth.ready}/{bufferHealth.target}
                  </strong>
                  {bufferHealth.inFlight > 0 ? (
                    <small>+{bufferHealth.inFlight}</small>
                  ) : null}
                </button>
                <i aria-hidden="true" />
                <button
                  type="button"
                  className={`${styles.supplyMetric} ${styles.metricButton}`}
                  aria-label={`View pool leaderboard; ${bufferHealth.pool} of ${bufferHealth.poolMaximum} reusable images`}
                  title="View pool leaderboard"
                  onClick={() => void openPoolLeaderboard()}
                >
                  Pool
                  <strong>
                    {bufferHealth.pool}/{bufferHealth.poolMaximum}
                  </strong>
                </button>
              </>
            ) : null}
          </section>

          <div className={styles.comparisonViewport}>
            <section
              className={styles.comparisonRail}
              aria-label="Choose the image you prefer"
            >
              <CandidateCard
                candidate={game.round.leftCandidate}
                side="left"
                label="A"
                loading={
                  bothCandidatesLoading ||
                  (status === "generating" &&
                    game.round.replacingSide === "left")
                }
                disabled={status === "generating" || reconcilingRetry}
                onSelect={select}
                onInspect={(candidate) =>
                  openImageInspector(candidate, [
                    game.round.leftCandidate,
                    game.round.rightCandidate,
                  ])
                }
                eloRating={eloRatings?.left}
              />
              <CandidateCard
                candidate={game.round.rightCandidate}
                side="right"
                label="B"
                loading={
                  bothCandidatesLoading ||
                  (status === "generating" &&
                    game.round.replacingSide === "right")
                }
                disabled={status === "generating" || reconcilingRetry}
                onSelect={select}
                onInspect={(candidate) =>
                  openImageInspector(candidate, [
                    game.round.leftCandidate,
                    game.round.rightCandidate,
                  ])
                }
                eloRating={eloRatings?.right}
              />
            </section>
          </div>

          {status !== "generating" ? (
            <div className={styles.roundActions}>
              <button
                type="button"
                className={styles.tieButton}
                disabled={reconcilingRetry}
                onClick={tie}
              >
                Declare tie{" "}
                <span>
                  <kbd>C</kbd> / <kbd>3</kbd>
                </span>
              </button>
              <button
                type="button"
                className={`${styles.tieButton} ${styles.bothLoseButton}`}
                disabled={reconcilingRetry}
                onClick={bothLose}
              >
                Both lose{" "}
                <span>
                  <kbd>D</kbd> / <kbd>4</kbd>
                </span>
              </button>
            </div>
          ) : null}

          <p className={styles.shortcuts}>
            {bothCandidatesLoading ? (
              bothLoseLoading ? (
                "Both rejected — preparing a fresh matchup…"
              ) : tieLoading ? (
                "Tie recorded — preparing a fresh matchup…"
              ) : (
                "Ten-win champion retired — preparing a fresh matchup…"
              )
            ) : (
              <>
                Choose with <kbd>A</kbd> or <kbd>1</kbd> for left <span>•</span>{" "}
                <kbd>B</kbd> or <kbd>2</kbd> for right <span>•</span> tie with{" "}
                <kbd>C</kbd> or <kbd>3</kbd> <span>•</span> reject both with{" "}
                <kbd>D</kbd> or <kbd>4</kbd>
              </>
            )}
          </p>

          {game.generationNotice?.kind === "moderation-block" ? (
            <div className={styles.generationNotice} role="status">
              <span>
                <strong>Generation was blocked</strong>A safety check rejected
                {game.generationNotice.occurrenceCount > 1
                  ? ` ${game.generationNotice.occurrenceCount} recent attempts`
                  : " a recent attempt"}
                . Adjust the profile to steer future challengers toward allowed
                content.
              </span>
              <div>
                <button
                  type="button"
                  onClick={() => void dismissGenerationNotice()}
                >
                  Dismiss
                </button>
                <button
                  type="button"
                  onClick={() => {
                    openPreferences();
                    void dismissGenerationNotice();
                  }}
                >
                  Adjust preferences
                </button>
              </div>
            </div>
          ) : null}

          {status === "error" || localError ? (
            <div className={styles.errorBar} role="alert">
              <span>
                {localError ??
                  game.errorMessage ??
                  "The challenger could not be created."}
              </span>
              {retryAvailable ? (
                <button type="button" onClick={retrySelection}>
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
          {exportNotice && status !== "error" && !localError ? (
            <div className={styles.exportNotice} role="status">
              {exportNotice}
            </div>
          ) : null}
        </>
      ) : null}

      {imageInspector ? (
        <ImageInspector
          state={imageInspector}
          onClose={closeImageInspector}
          onNavigate={navigateImageInspector}
          onExplore={(candidate) => void exploreCandidateVariations(candidate)}
        />
      ) : null}

      {historyOpen && game ? (
        <ComparisonHistory
          entries={historyEntries}
          total={historyTotal}
          loading={historyLoading}
          error={historyError}
          favoriteError={favoriteError}
          favoriteSaving={favoriteSaving}
          onClose={closeComparisonHistory}
          onInspect={inspectHistoryCandidate}
          onToggleFavorite={(candidateId, favorite) =>
            void updateFavorite(candidateId, favorite)
          }
        />
      ) : null}

      {leaderboardOpen && game ? (
        <PoolLeaderboard
          entries={leaderboardEntries}
          loading={leaderboardLoading}
          error={leaderboardError}
          favoriteError={favoriteError}
          favoriteSaving={favoriteSaving}
          onClose={closePoolLeaderboard}
          onInspect={inspectLeaderboardCandidate}
          onToggleFavorite={(candidateId, favorite) =>
            void updateFavorite(candidateId, favorite)
          }
        />
      ) : null}

      {queueDetailsOpen && bufferHealth ? (
        <QueueDetails
          health={bufferHealth}
          onClose={() => setQueueDetailsOpen(false)}
        />
      ) : null}

      {loadGameOpen && game ? (
        <GameTransferModal
          mode="load"
          action={gameTransferAction}
          error={gameTransferError}
          onClose={closeLoadGame}
          onExport={() => void exportCurrentGame()}
          onImport={importSavedGame}
          onStartFresh={() => void startFreshGame()}
        />
      ) : null}

      {newGameOpen && game ? (
        <GameTransferModal
          mode="new"
          action={gameTransferAction}
          error={gameTransferError}
          onClose={closeNewGame}
          onExport={() => void exportCurrentGame()}
          onImport={importSavedGame}
          onStartFresh={() => void startFreshGame()}
        />
      ) : null}
      {preferencesOpen && game ? (
        <PreferenceProfileModal
          profile={preferenceDraft}
          historyLength={game.history.length}
          saving={preferencesSaving}
          saveQueued={preferenceSaveQueued}
          sourceAnalyzing={sourceProfileAnalyzing}
          sourceError={sourceProfileError}
          sourceSummary={sourceProfileSummary}
          variationSource={preferenceVariationSource}
          revisions={game.preferenceRevisions ?? []}
          presets={game.preferencePresets ?? []}
          presetSaving={presetSaving}
          presetError={presetError}
          promptDeck={game.promptDeck}
          promptDeckSaving={promptDeckSaving}
          promptDeckError={promptDeckError}
          selectionBoundWait={selectionBoundWait}
          onClose={closePreferences}
          onSave={() => void savePreferences()}
          onAnalyzeSource={analyzeSourceImage}
          onRestoreRevision={restorePreferenceRevision}
          onSavePreset={savePreferencePreset}
          onApplyPreset={applyPreferencePreset}
          onDeletePreset={deletePreferencePreset}
          onCreatePromptCard={createPromptCard}
          onUpdatePromptDeck={updatePromptDeck}
          onBlendPromptCards={blendPromptCards}
          onFieldChange={setPreferenceField}
          onFreedomChange={setAdaptationFreedom}
        />
      ) : null}
    </main>
  );
}
