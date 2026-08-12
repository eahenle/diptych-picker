"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  preferenceProfileFromSeed,
  type BufferHealth,
  type DisplayedEloRatings,
  type GameStartState,
  type GameState,
} from "@/domain/game";
import type { ImportProgress } from "@/domain/import-progress";
import { CandidateCard } from "./candidate-card";
import { ComparisonHistory } from "./comparison-history";
import { FavoritesGallery } from "./favorites-gallery";
import { readJson } from "./game-api";
import { GameTransferModal } from "./game-transfer-modal";
import { GameStartupModal, type GameStartupStatus } from "./game-startup-modal";
import { ImageImportModal } from "./image-import-modal";
import { ImageInspector } from "./image-inspector";
import { PoolLeaderboard } from "./pool-leaderboard";
import { QueueDetails } from "./queue-details";
import { PreferenceProfileModal } from "./preference-profile-modal";
import { useCandidateBrowser } from "./use-candidate-browser";
import { useAppVersion } from "./use-app-version";
import { useGameSessionPolling } from "./use-game-session-polling";
import { useGameTransfer } from "./use-game-transfer";
import { useImageImport } from "./use-image-import";
import { useGameplayShortcuts } from "./use-gameplay-shortcuts";
import { usePreferenceDraft } from "./use-preference-draft";
import { usePreferenceEditor } from "./use-preference-editor";
import { useSelectionController } from "./use-selection-controller";
import styles from "./game-screen.module.css";

type HeaderPictographName =
  "export" | "favorites" | "load" | "preferences" | "new";

function HeaderPictograph({ name }: { name: HeaderPictographName }) {
  const paths: Record<HeaderPictographName, ReactNode> = {
    export: (
      <>
        <path d="M12 3v12" />
        <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
        <path d="M4 19h16" />
      </>
    ),
    favorites: (
      <path d="M12 20.5 4.7 13.3A5 5 0 0 1 11.8 6l.2.2.2-.2a5 5 0 0 1 7.1 7.1z" />
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

interface GameScreenProps {
  promptForStartup?: boolean;
}

export function GameScreen({ promptForStartup = false }: GameScreenProps) {
  const [game, setGame] = useState<GameState | null>(null);
  const [startState, setStartState] = useState<GameStartState | null>(null);
  const [initializing, setInitializing] = useState(!promptForStartup);
  const [startupOpen, setStartupOpen] = useState(promptForStartup);
  const [startupResolved, setStartupResolved] = useState(!promptForStartup);
  const [resumeRequested, setResumeRequested] = useState(false);
  const [startupStatus, setStartupStatus] = useState<GameStartupStatus | null>(
    null,
  );
  const [startupStatusError, setStartupStatusError] = useState<string | null>(
    null,
  );
  const [startupStatusAttempt, setStartupStatusAttempt] = useState(0);
  const [queueDetailsOpen, setQueueDetailsOpen] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<string | null>(null);
  const [bufferHealth, setBufferHealth] = useState<BufferHealth | null>(null);
  const [eloRatings, setEloRatings] = useState<DisplayedEloRatings | null>(
    null,
  );
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(
    null,
  );
  const gameRef = useRef<GameState | null>(null);
  const {
    observeServerResponse,
    reload: reloadApp,
    updateAvailable,
  } = useAppVersion();
  const {
    baseProfile: preferenceDraftBaseProfile,
    dirty: preferenceDraftDirty,
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

  const completeStartup = useCallback(() => {
    setStartupResolved(true);
    setStartupOpen(false);
  }, []);

  useEffect(() => {
    if (!promptForStartup || !startupOpen) return;
    let active = true;
    const load = async () => {
      try {
        const response = await fetch("/api/game/start", {
          cache: "no-store",
        });
        observeServerResponse(response);
        const status = await readJson<GameStartupStatus>(response);
        if (!active) return;
        setStartupStatus(status);
        setStartupStatusError(null);
      } catch (error) {
        if (!active) return;
        setStartupStatusError(
          error instanceof Error
            ? error.message
            : "Could not check for an existing game",
        );
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [
    observeServerResponse,
    promptForStartup,
    startupOpen,
    startupStatusAttempt,
  ]);

  const { retryInitial } = useGameSessionPolling({
    initialLoadEnabled: !promptForStartup || resumeRequested,
    bufferHealth,
    game,
    importProgress,
    startState,
    commitGame,
    commitStartState,
    setBufferHealth,
    setConnectionStatus,
    setInitializing,
    setImportProgress,
    setLocalError,
    observeServerResponse,
  });

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
    imageImportOpen,
    loadGameOpen,
    newGameOpen,
    closeImageImport,
    closeLoadGame,
    closeNewGame,
    exportCurrentGame,
    finishImageImport,
    importSavedGame,
    openImageImport,
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
    onSessionReady: completeStartup,
  });

  const dismissImageImport = useCallback(() => {
    closeImageImport();
    if (!startupResolved) setStartupOpen(true);
  }, [closeImageImport, startupResolved]);

  const imageImport = useImageImport({
    modalOpen: imageImportOpen,
    gameRef,
    selectionLockedRef: selectionLocked,
    commitStartState,
    cancelActiveSelection,
    onDismiss: dismissImageImport,
    onActivated: finishImageImport,
    setImportProgress,
  });

  const {
    favoriteEntries,
    favoriteError,
    favoriteSaving,
    favoritesError,
    favoritesLoading,
    favoritesOpen,
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
    closeFavoritesGallery,
    closeImageInspector,
    closePoolLeaderboard,
    dismissImageInspector,
    inspectFavoriteCandidate,
    inspectHistoryCandidate,
    inspectLeaderboardCandidate,
    navigateImageInspector,
    openComparisonHistory,
    openFavoritesGallery,
    openImageInspector,
    openPoolLeaderboard,
    updateFavorite,
  } = useCandidateBrowser({ gameRef });

  const {
    open: preferencesOpen,
    saving: preferencesSaving,
    saveQueued: preferenceSaveQueued,
    saveError: preferenceSaveError,
    sourceAnalyzing: sourceProfileAnalyzing,
    sourceError: sourceProfileError,
    sourceSummary: sourceProfileSummary,
    setSupplementalDirty: setPreferenceSupplementalDirty,
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
    updatePromptDeck,
    updateGameRules,
    writeCustomPromptCard,
    writePromptCard,
  } = usePreferenceEditor({
    game,
    profile: preferenceDraft,
    baseProfile: preferenceDraftBaseProfile,
    draftDirty: preferenceDraftDirty,
    variationSource: preferenceVariationSource,
    commitGame,
    dismissImageInspector,
    applyAnalyzedProfile,
    applyPresetDraft,
    resetPreferenceDraft,
    restorePreferenceDraftRevision,
    setLocalError,
  });

  useGameplayShortcuts({
    suspended:
      startupOpen ||
      preferencesOpen ||
      newGameOpen ||
      loadGameOpen ||
      imageImportOpen ||
      favoritesOpen ||
      leaderboardOpen ||
      queueDetailsOpen ||
      historyOpen ||
      Boolean(imageInspector),
    onSelect: select,
    onTie: tie,
    onBothLose: bothLose,
  });

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

  const retryAvailable =
    game?.round.status === "error" && Boolean(game.pendingSelection);
  const status = game?.round.status;
  const streak = game?.round.winStreak ?? 0;
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

  const resumeCurrentGame = () => {
    completeStartup();
    setInitializing(true);
    setResumeRequested(true);
  };

  const retryStartupStatus = () => {
    setStartupStatus(null);
    setStartupStatusError(null);
    setStartupStatusAttempt((attempt) => attempt + 1);
  };

  const openStartupImport = () => {
    setStartupOpen(false);
    openImageImport();
    void imageImport.begin();
  };

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
            aria-label="Favorites"
            title="View favorites"
            disabled={!game || reconcilingRetry || initializing}
            onClick={() => void openFavoritesGallery()}
          >
            <HeaderPictograph name="favorites" />
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

      {updateAvailable ? (
        <div className={styles.versionNotice} role="alert">
          <span>
            <strong>New version available</strong>
            Reload to use the latest fixes and features.
          </span>
          <button type="button" onClick={reloadApp}>
            Reload
          </button>
        </div>
      ) : null}

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

          {importProgress &&
          importProgress.status !== "completed" &&
          importProgress.failed > 0 ? (
            <div className={styles.importFailureNotice} role="status">
              <span>
                <strong>Imported image needs attention</strong>
                {importProgress.failed} imported image
                {importProgress.failed === 1 ? " has" : "s have"} no usable
                annotation yet.
              </span>
              <button
                type="button"
                onClick={() => {
                  openImageImport();
                  void imageImport.begin();
                }}
              >
                Resolve imported image
              </button>
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

      {favoritesOpen && game ? (
        <FavoritesGallery
          entries={favoriteEntries}
          loading={favoritesLoading}
          error={favoritesError}
          favoriteError={favoriteError}
          favoriteSaving={favoriteSaving}
          writerActive={Boolean(game.promptDeck?.writerJob)}
          writerBusy={promptDeckSaving}
          writerError={promptDeckError}
          onClose={closeFavoritesGallery}
          onInspect={inspectFavoriteCandidate}
          onExplore={(candidate) => {
            closeFavoritesGallery();
            void exploreCandidateVariations(candidate);
          }}
          onRemoveFavorite={(candidateId) =>
            void updateFavorite(candidateId, false)
          }
          onWritePromptCard={async (candidateIds) => {
            const started = await writePromptCard(candidateIds);
            if (started) {
              closeFavoritesGallery();
              openPreferences();
            }
            return started;
          }}
        />
      ) : null}

      {queueDetailsOpen && bufferHealth ? (
        <QueueDetails
          health={bufferHealth}
          importProgress={importProgress}
          onClose={() => setQueueDetailsOpen(false)}
        />
      ) : null}

      {startupOpen ? (
        <GameStartupModal
          status={startupStatus}
          statusError={startupStatusError}
          action={gameTransferAction}
          actionError={gameTransferError}
          onRetryStatus={retryStartupStatus}
          onResume={resumeCurrentGame}
          onLoad={importSavedGame}
          onInitialize={() => void startFreshGame()}
          onImport={openStartupImport}
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
          onImportImages={() => {
            openImageImport();
            void imageImport.begin();
          }}
          onStartFresh={() => void startFreshGame()}
        />
      ) : null}
      {imageImportOpen ? <ImageImportModal controller={imageImport} /> : null}
      {preferencesOpen && game ? (
        <PreferenceProfileModal
          profile={preferenceDraft}
          historyLength={game.history.length}
          saving={preferencesSaving}
          saveQueued={preferenceSaveQueued}
          saveError={preferenceSaveError}
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
          gameRules={gameRules}
          gameRulesSaving={gameRulesSaving}
          gameRulesError={gameRulesError}
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
          onWriteCustomPromptCard={writeCustomPromptCard}
          onUpdateGameRules={updateGameRules}
          onSupplementalDirtyChange={setPreferenceSupplementalDirty}
          onFieldChange={setPreferenceField}
          onFreedomChange={setAdaptationFreedom}
        />
      ) : null}
    </main>
  );
}
