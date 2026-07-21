"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  beginChampionRetirement,
  beginBothLose,
  beginSelection,
  beginTie,
  isSelectionBoundWait,
  mergeServerResult,
  preferenceProfileFromSeed,
  willRetireChampion,
  type BufferHealth,
  type DisplayedEloRatings,
  type GameStartState,
  type GameState,
  type PreferenceProfile,
  type PreferenceRevision,
  type Side,
  type VariationSource,
} from "@/domain/game";
import type {
  ComparisonHistoryCandidate,
  ComparisonHistoryEntry,
  PoolLeaderboardEntry,
} from "@/domain/challenger-state";
import { CandidateCard } from "./candidate-card";
import { ComparisonHistory } from "./comparison-history";
import {
  GameTransferModal,
  type GameTransferAction,
} from "./game-transfer-modal";
import {
  ImageInspector,
  type ImageInspectorState,
  type InspectableCandidate,
} from "./image-inspector";
import { PoolLeaderboard } from "./pool-leaderboard";
import { QueueDetails } from "./queue-details";
import {
  PreferenceProfileModal,
  type PreferenceField,
} from "./preference-profile-modal";
import { useGameplayShortcuts } from "./use-gameplay-shortcuts";
import styles from "./game-screen.module.css";

async function readJson<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

const POLL_INTERVAL_MS = 150;
const HEALTH_POLL_INTERVAL_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 2_400;
const RECONNECT_MESSAGE = "Connection interrupted. Reconnecting…";
const SOURCE_PROFILE_POLL_INTERVAL_MS = 500;

interface ActiveSelection {
  token: string;
  original: GameState;
  winnerSide: Side;
  expectedRound: number;
  generationJobId: string | null;
  retirement: boolean;
  tie: boolean;
  bothLose: boolean;
  controller: AbortController;
  polling: boolean;
  retryAttempt: number;
}

type RatedGameState = GameState & { eloRatings?: DisplayedEloRatings };
type SourceProfileResponse =
  | { status: "analyzing"; jobId: string }
  | {
      status: "completed";
      jobId: string;
      profile: PreferenceRevision;
      reasoningSummary: string;
    }
  | { status: "failed"; jobId: string; message: string };

const MAX_GAME_SAVE_BYTES = 25 * 1024 * 1024;

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

function preload(url: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      image.src = "";
      cleanup();
      reject(new DOMException("Image preload was cancelled", "AbortError"));
    };
    image.onload = () => {
      cleanup();
      resolve();
    };
    image.onerror = () => {
      cleanup();
      reject(new Error("The new image could not be loaded"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    image.src = url;
  });
}

async function preloadChangedAssets(
  current: GameState,
  next: GameState,
  signal: AbortSignal,
): Promise<void> {
  const currentCandidates = [
    current.round.leftCandidate,
    current.round.rightCandidate,
  ];
  const nextCandidates = [next.round.leftCandidate, next.round.rightCandidate];
  await Promise.all(
    nextCandidates.map((candidate, index) => {
      const previous = currentCandidates[index];
      return previous.id === candidate.id &&
        previous.imageUrl === candidate.imageUrl
        ? Promise.resolve()
        : preload(candidate.imageUrl, signal);
    }),
  );
}

function matchingPendingSelection(
  server: GameState,
  selection: ActiveSelection,
): boolean {
  const pending = server.pendingSelection;
  if (selection.tie || selection.bothLose) {
    return (
      server.round.roundNumber === selection.expectedRound &&
      pending?.kind === (selection.tie ? "tie" : "both-lose")
    );
  }
  if (
    server.round.roundNumber !== selection.expectedRound ||
    !pending ||
    pending.kind === "tie" ||
    pending.kind === "both-lose" ||
    pending.winnerSide !== selection.winnerSide
  ) {
    return false;
  }
  if (pending.kind === "generation") {
    return (
      selection.generationJobId !== null &&
      pending.generationJobId === selection.generationJobId
    );
  }
  return (
    selection.generationJobId === null &&
    (pending.kind === "retirement") === selection.retirement
  );
}

function matchingCompletedSelection(
  server: GameState,
  selection: ActiveSelection,
): boolean {
  if (
    server.round.status !== "idle" ||
    server.round.roundNumber !== selection.expectedRound + 1
  ) {
    return false;
  }
  const history = server.history.at(-1);
  if (selection.tie || selection.bothLose) {
    return (
      history?.outcome === (selection.tie ? "tie" : "both-lose") &&
      history.leftId === selection.original.round.leftCandidate.id &&
      history.rightId === selection.original.round.rightCandidate.id
    );
  }
  const winner =
    selection.winnerSide === "left"
      ? selection.original.round.leftCandidate
      : selection.original.round.rightCandidate;
  const loser =
    selection.winnerSide === "left"
      ? selection.original.round.rightCandidate
      : selection.original.round.leftCandidate;
  return (
    history?.outcome !== "tie" &&
    history?.outcome !== "both-lose" &&
    history?.winnerId === winner.id &&
    history.loserId === loser.id
  );
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
  const [newGameOpen, setNewGameOpen] = useState(false);
  const [loadGameOpen, setLoadGameOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [imageInspector, setImageInspector] =
    useState<ImageInspectorState | null>(null);
  const [historyEntries, setHistoryEntries] = useState<
    ComparisonHistoryEntry[]
  >([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);
  const [queueDetailsOpen, setQueueDetailsOpen] = useState(false);
  const [leaderboardEntries, setLeaderboardEntries] = useState<
    PoolLeaderboardEntry[]
  >([]);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [leaderboardError, setLeaderboardError] = useState<string | null>(null);
  const [favoriteSaving, setFavoriteSaving] = useState<string | null>(null);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);
  const [gameTransferAction, setGameTransferAction] =
    useState<GameTransferAction | null>(null);
  const [gameTransferError, setGameTransferError] = useState<string | null>(
    null,
  );
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [preferenceDraft, setPreferenceDraft] = useState<PreferenceProfile>(
    () => preferenceProfileFromSeed(""),
  );
  const [preferenceDraftBaseProfile, setPreferenceDraftBaseProfile] =
    useState<PreferenceProfile>(() => preferenceProfileFromSeed(""));
  const [preferenceVariationSource, setPreferenceVariationSource] =
    useState<VariationSource | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<string | null>(null);
  const [bufferHealth, setBufferHealth] = useState<BufferHealth | null>(null);
  const [eloRatings, setEloRatings] = useState<DisplayedEloRatings | null>(
    null,
  );
  const [reconcilingRetry, setReconcilingRetry] = useState(false);
  const healthPollingEnabled = game !== null && bufferHealth !== null;
  const healthRound = game?.round.roundNumber ?? null;
  const selectionLocked = useRef(false);
  const gameRef = useRef<GameState | null>(null);
  const activeSelectionRef = useRef<ActiveSelection | null>(null);
  const retryControllerRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceProfileControllerRef = useRef<AbortController | null>(null);
  const queuedPreferenceProfileRef = useRef<PreferenceProfile | null>(null);
  const queuedPreferenceVariationSourceRef = useRef<VariationSource | null>(
    null,
  );
  const queuedPreferenceSaveStartedRef = useRef(false);
  const openImageInspector = useCallback(
    (
      candidate: InspectableCandidate,
      candidates: readonly InspectableCandidate[],
      returnTarget: ImageInspectorState["returnTarget"] = null,
    ) => {
      const uniqueCandidates = candidates.filter(
        (item, index) =>
          item.imageUrl &&
          candidates.findIndex((candidate) => candidate.id === item.id) ===
            index,
      );
      const index = uniqueCandidates.findIndex(
        (item) => item.id === candidate.id,
      );
      setImageInspector({
        candidates:
          uniqueCandidates.length > 0 ? uniqueCandidates : [candidate],
        index: index >= 0 ? index : 0,
        returnTarget,
      });
    },
    [],
  );

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
        setPreferenceDraft(
          next.game.preferenceProfile ??
            preferenceProfileFromSeed(next.game.preferenceSeed),
        );
      } else {
        gameRef.current = null;
        setGame(null);
        setBufferHealth(null);
        setEloRatings(null);
        setPreferenceDraft(preferenceProfileFromSeed(next.preferenceSeed));
      }
    },
    [commitGame],
  );

  const cancelActiveSelection = useCallback(() => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
    activeSelectionRef.current?.controller.abort();
    activeSelectionRef.current = null;
    retryControllerRef.current?.abort();
    retryControllerRef.current = null;
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    selectionLocked.current = false;
    setReconcilingRetry(false);
  }, []);

  const startPolling = useCallback(
    (selection: ActiveSelection, initialServer?: GameState) => {
      if (selection.polling) return;
      selection.polling = true;
      let firstServer = initialServer;

      const isCurrent = () =>
        activeSelectionRef.current?.token === selection.token &&
        !selection.controller.signal.aborted;
      const preserveCandidates = (server: GameState): GameState => ({
        ...server,
        round: {
          ...server.round,
          leftCandidate: selection.original.round.leftCandidate,
          rightCandidate: selection.original.round.rightCandidate,
        },
      });
      const finish = () => {
        if (!isCurrent()) return;
        activeSelectionRef.current = null;
        selectionLocked.current = false;
        pollTimerRef.current = null;
        setConnectionStatus(null);
      };

      const schedule = (delay: number) => {
        if (!isCurrent()) return;
        pollTimerRef.current = setTimeout(() => void poll(), delay);
      };

      const poll = async (): Promise<void> => {
        if (!isCurrent()) return;
        try {
          let server = firstServer;
          firstServer = undefined;
          if (!server) {
            const response = await readJson<GameStartState>(
              await fetch("/api/game", {
                cache: "no-store",
                signal: selection.controller.signal,
              }),
            );
            if (!isCurrent()) return;
            if (response.status !== "ready") {
              finish();
              commitStartState(response);
              setLocalError(null);
              return;
            }
            setEloRatings(response.eloRatings ?? null);
            server = response.game;
          }
          if (!isCurrent()) return;

          if (
            server.round.status === "generating" &&
            matchingPendingSelection(server, selection)
          ) {
            commitGame(preserveCandidates(server));
            selection.retryAttempt = 0;
            setConnectionStatus(null);
            schedule(POLL_INTERVAL_MS);
            return;
          }

          if (
            server.round.status === "error" &&
            matchingPendingSelection(server, selection)
          ) {
            setLocalError(null);
            commitGame(preserveCandidates(server));
            finish();
            return;
          }

          if (matchingCompletedSelection(server, selection)) {
            if (selection.retirement || selection.tie) {
              await preloadChangedAssets(
                selection.original,
                server,
                selection.controller.signal,
              );
              if (!isCurrent()) return;
              commitGame(server);
              setLocalError(null);
              finish();
              return;
            }
            const challenger =
              selection.winnerSide === "left"
                ? server.round.rightCandidate
                : server.round.leftCandidate;
            await preload(challenger.imageUrl, selection.controller.signal);
            if (!isCurrent()) return;
            commitGame(
              mergeServerResult(
                selection.original,
                server,
                selection.winnerSide,
              ),
            );
            setLocalError(null);
            finish();
            return;
          }

          await preloadChangedAssets(
            gameRef.current ?? selection.original,
            server,
            selection.controller.signal,
          );
          if (!isCurrent()) return;
          finish();
          commitGame(server);
          setLocalError(null);
        } catch (error) {
          if (
            selection.controller.signal.aborted ||
            (error instanceof DOMException && error.name === "AbortError")
          ) {
            return;
          }
          setConnectionStatus(RECONNECT_MESSAGE);
          schedule(reconnectDelay(selection.retryAttempt));
          selection.retryAttempt += 1;
        }
      };

      void poll();
    },
    [commitGame, commitStartState],
  );

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

  useEffect(() => cancelActiveSelection, [cancelActiveSelection]);
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

  useEffect(() => {
    if (
      game?.round.status !== "generating" ||
      !game.pendingSelection ||
      activeSelectionRef.current
    ) {
      return;
    }
    const selection: ActiveSelection = {
      token: crypto.randomUUID(),
      original: game,
      winnerSide:
        game.pendingSelection.kind === "tie" ||
        game.pendingSelection.kind === "both-lose"
          ? game.pendingSelection.referenceSide
          : game.pendingSelection.winnerSide,
      expectedRound: game.round.roundNumber,
      generationJobId:
        game.pendingSelection.kind === "generation"
          ? game.pendingSelection.generationJobId
          : null,
      retirement: game.pendingSelection.kind === "retirement",
      tie: game.pendingSelection.kind === "tie",
      bothLose: game.pendingSelection.kind === "both-lose",
      controller: new AbortController(),
      polling: false,
      retryAttempt: 0,
    };
    selectionLocked.current = true;
    activeSelectionRef.current = selection;
    startPolling(selection);
  }, [game, startPolling]);

  const submitSelection = useCallback(
    async (current: GameState, winnerSide: Side) => {
      const retirement = willRetireChampion(current, winnerSide);
      const selectedAt = new Date().toISOString();
      const optimistic = retirement
        ? beginChampionRetirement(current, winnerSide, selectedAt)
        : beginSelection(
            current,
            winnerSide,
            selectedAt,
            `optimistic-${crypto.randomUUID()}`,
          );
      if (!optimistic) return;

      selectionLocked.current = true;
      setLocalError(null);
      setConnectionStatus(null);
      const selection: ActiveSelection = {
        token: crypto.randomUUID(),
        original: current,
        winnerSide,
        expectedRound: current.round.roundNumber,
        generationJobId: null,
        retirement,
        tie: false,
        bothLose: false,
        controller: new AbortController(),
        polling: false,
        retryAttempt: 0,
      };
      activeSelectionRef.current = selection;
      commitGame(optimistic);

      try {
        const response = await fetch("/api/game/select", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            winnerSide,
            roundNumber: current.round.roundNumber,
          }),
          signal: selection.controller.signal,
        });
        const server = await readJson<RatedGameState>(response);
        if (activeSelectionRef.current?.token !== selection.token) return;
        setEloRatings(server.eloRatings ?? null);
        if (
          server.round.roundNumber === selection.expectedRound &&
          server.pendingSelection?.kind === "generation"
        ) {
          selection.generationJobId = server.pendingSelection.generationJobId;
        }
        if (server.pendingSelection?.kind === "retirement") {
          selection.retirement = true;
        }
        if (matchingCompletedSelection(server, selection)) {
          if (selection.retirement || selection.tie || selection.bothLose) {
            await preloadChangedAssets(
              current,
              server,
              selection.controller.signal,
            );
            if (activeSelectionRef.current?.token !== selection.token) return;
            activeSelectionRef.current = null;
            selectionLocked.current = false;
            setConnectionStatus(null);
            setLocalError(null);
            commitGame(server);
            return;
          }
          const challenger =
            winnerSide === "left"
              ? server.round.rightCandidate
              : server.round.leftCandidate;
          await preload(challenger.imageUrl, selection.controller.signal);
          if (activeSelectionRef.current?.token !== selection.token) return;
          activeSelectionRef.current = null;
          selectionLocked.current = false;
          setConnectionStatus(null);
          setLocalError(null);
          commitGame(mergeServerResult(current, server, winnerSide));
          return;
        }
        startPolling(selection, server);
      } catch {
        if (selection.controller.signal.aborted) return;
        setConnectionStatus(RECONNECT_MESSAGE);
        startPolling(selection);
      }
    },
    [commitGame, startPolling],
  );

  const submitPairDecision = useCallback(
    async (current: GameState, outcome: "tie" | "both-lose") => {
      const selectedAt = new Date().toISOString();
      const optimistic =
        outcome === "tie"
          ? beginTie(current, "left", selectedAt)
          : beginBothLose(current, "left", selectedAt);
      if (!optimistic) return;

      selectionLocked.current = true;
      setLocalError(null);
      setConnectionStatus(null);
      const selection: ActiveSelection = {
        token: crypto.randomUUID(),
        original: current,
        winnerSide: "left",
        expectedRound: current.round.roundNumber,
        generationJobId: null,
        retirement: false,
        tie: outcome === "tie",
        bothLose: outcome === "both-lose",
        controller: new AbortController(),
        polling: false,
        retryAttempt: 0,
      };
      activeSelectionRef.current = selection;
      commitGame(optimistic);

      try {
        const response = await fetch("/api/game/select", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            outcome,
            roundNumber: current.round.roundNumber,
          }),
          signal: selection.controller.signal,
        });
        const server = await readJson<RatedGameState>(response);
        if (activeSelectionRef.current?.token !== selection.token) return;
        setEloRatings(server.eloRatings ?? null);
        if (matchingCompletedSelection(server, selection)) {
          await preloadChangedAssets(
            current,
            server,
            selection.controller.signal,
          );
          if (activeSelectionRef.current?.token !== selection.token) return;
          activeSelectionRef.current = null;
          selectionLocked.current = false;
          setConnectionStatus(null);
          setLocalError(null);
          commitGame(server);
          return;
        }
        startPolling(selection, server);
      } catch {
        if (selection.controller.signal.aborted) return;
        setConnectionStatus(RECONNECT_MESSAGE);
        startPolling(selection);
      }
    },
    [commitGame, startPolling],
  );

  const select = useCallback(
    (winnerSide: Side) => {
      const current = gameRef.current;
      if (
        !current ||
        selectionLocked.current ||
        current.round.status === "generating"
      ) {
        return;
      }
      void submitSelection(current, winnerSide);
    },
    [submitSelection],
  );

  const tie = useCallback(() => {
    const current = gameRef.current;
    if (
      !current ||
      selectionLocked.current ||
      current.round.status === "generating"
    ) {
      return;
    }
    void submitPairDecision(current, "tie");
  }, [submitPairDecision]);

  const bothLose = useCallback(() => {
    const current = gameRef.current;
    if (
      !current ||
      selectionLocked.current ||
      current.round.status === "generating"
    ) {
      return;
    }
    void submitPairDecision(current, "both-lose");
  }, [submitPairDecision]);

  const retrySelection = useCallback(() => {
    const failed = gameRef.current;
    if (
      !failed ||
      failed.round.status !== "error" ||
      !failed.pendingSelection ||
      selectionLocked.current
    ) {
      return;
    }

    selectionLocked.current = true;
    setReconcilingRetry(true);
    setLocalError(null);
    const controller = new AbortController();
    retryControllerRef.current = controller;
    let retryAttempt = 0;

    const reconcile = async (): Promise<void> => {
      if (controller.signal.aborted) return;
      try {
        const response = await readJson<GameStartState>(
          await fetch("/api/game", {
            cache: "no-store",
            signal: controller.signal,
          }),
        );
        if (controller.signal.aborted) return;
        if (response.status !== "ready") {
          retryControllerRef.current = null;
          selectionLocked.current = false;
          setReconcilingRetry(false);
          setConnectionStatus(null);
          commitStartState(response);
          return;
        }

        const server = response.game;
        setEloRatings(response.eloRatings ?? null);
        await preloadChangedAssets(
          gameRef.current ?? failed,
          server,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        retryControllerRef.current = null;
        setConnectionStatus(null);
        setLocalError(null);

        if (server.round.status === "generating" && server.pendingSelection) {
          const selection: ActiveSelection = {
            token: crypto.randomUUID(),
            original: server,
            winnerSide:
              server.pendingSelection.kind === "tie" ||
              server.pendingSelection.kind === "both-lose"
                ? server.pendingSelection.referenceSide
                : server.pendingSelection.winnerSide,
            expectedRound: server.round.roundNumber,
            generationJobId:
              server.pendingSelection.kind === "generation"
                ? server.pendingSelection.generationJobId
                : null,
            retirement: server.pendingSelection.kind === "retirement",
            tie: server.pendingSelection.kind === "tie",
            bothLose: server.pendingSelection.kind === "both-lose",
            controller: new AbortController(),
            polling: false,
            retryAttempt: 0,
          };
          activeSelectionRef.current = selection;
          setReconcilingRetry(false);
          commitGame(server);
          startPolling(selection);
          return;
        }

        if (server.round.status === "error" && server.pendingSelection) {
          setReconcilingRetry(false);
          commitGame(server);
          if (
            server.pendingSelection.kind === "tie" ||
            server.pendingSelection.kind === "both-lose"
          ) {
            void submitPairDecision(server, server.pendingSelection.kind);
          } else if (server.pendingSelection.kind === "generation")
            void submitSelection(server, server.pendingSelection.winnerSide);
          else selectionLocked.current = false;
          return;
        }

        selectionLocked.current = false;
        setReconcilingRetry(false);
        commitGame(server);
      } catch (error) {
        if (
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          return;
        }
        setConnectionStatus(RECONNECT_MESSAGE);
        retryTimerRef.current = setTimeout(
          () => void reconcile(),
          reconnectDelay(retryAttempt),
        );
        retryAttempt += 1;
      }
    };

    void reconcile();
  }, [
    commitGame,
    commitStartState,
    startPolling,
    submitPairDecision,
    submitSelection,
  ]);

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

  const openComparisonHistory = async () => {
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryError(null);
    setFavoriteError(null);
    try {
      const response = await fetch("/api/game/history", {
        cache: "no-store",
      });
      const data = await readJson<{
        entries: ComparisonHistoryEntry[];
        total: number;
      }>(response);
      setHistoryEntries(data.entries);
      setHistoryTotal(data.total);
    } catch (error) {
      setHistoryError(
        error instanceof Error ? error.message : "Could not load history",
      );
    } finally {
      setHistoryLoading(false);
    }
  };

  const inspectLeaderboardCandidate = (
    candidate: PoolLeaderboardEntry["candidate"],
  ) => {
    setLeaderboardOpen(false);
    openImageInspector(
      candidate,
      leaderboardEntries.map((entry) => entry.candidate),
      "leaderboard",
    );
  };

  const closeImageInspector = () => {
    const returnTarget = imageInspector?.returnTarget ?? null;
    setImageInspector(null);
    if (returnTarget === "leaderboard") setLeaderboardOpen(true);
  };

  const navigateImageInspector = useCallback((direction: -1 | 1) => {
    setImageInspector((current) =>
      current
        ? {
            ...current,
            index:
              (current.index + direction + current.candidates.length) %
              current.candidates.length,
          }
        : current,
    );
  }, []);

  const inspectHistoryCandidate = (candidate: ComparisonHistoryCandidate) => {
    if (!candidate.imageUrl) return;
    setHistoryOpen(false);
    const candidates = historyEntries.flatMap((entry) =>
      entry.outcome === "tie" || entry.outcome === "both-lose"
        ? [entry.left, entry.right]
        : [entry.winner, entry.loser],
    );
    openImageInspector(
      {
        id: candidate.id,
        imageUrl: candidate.imageUrl,
        concept: candidate.concept,
      },
      candidates.flatMap((item) =>
        item.imageUrl
          ? [{ id: item.id, imageUrl: item.imageUrl, concept: item.concept }]
          : [],
      ),
    );
  };

  const openPoolLeaderboard = async () => {
    setLeaderboardOpen(true);
    setLeaderboardLoading(true);
    setLeaderboardError(null);
    setFavoriteError(null);
    try {
      const response = await fetch("/api/game/leaderboard", {
        cache: "no-store",
      });
      const data = await readJson<{
        entries: PoolLeaderboardEntry[];
        poolMaximum: number;
      }>(response);
      setLeaderboardEntries(data.entries);
    } catch (error) {
      setLeaderboardError(
        error instanceof Error ? error.message : "Could not load the pool",
      );
    } finally {
      setLeaderboardLoading(false);
    }
  };

  const updateFavorite = async (candidateId: string, favorite: boolean) => {
    setFavoriteSaving(candidateId);
    setFavoriteError(null);
    try {
      await readJson<{ candidateId: string; favorite: boolean }>(
        await fetch("/api/game/favorites", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ candidateId, favorite }),
        }),
      );
      setHistoryEntries((entries) =>
        entries.map((entry) =>
          entry.outcome === "tie" || entry.outcome === "both-lose"
            ? {
                ...entry,
                left:
                  entry.left.id === candidateId
                    ? { ...entry.left, favorite }
                    : entry.left,
                right:
                  entry.right.id === candidateId
                    ? { ...entry.right, favorite }
                    : entry.right,
              }
            : {
                ...entry,
                winner:
                  entry.winner.id === candidateId
                    ? { ...entry.winner, favorite }
                    : entry.winner,
                loser:
                  entry.loser.id === candidateId
                    ? { ...entry.loser, favorite }
                    : entry.loser,
              },
        ),
      );
      setLeaderboardEntries((entries) =>
        entries.map((entry) =>
          entry.candidate.id === candidateId ? { ...entry, favorite } : entry,
        ),
      );
    } catch (error) {
      setFavoriteError(
        error instanceof Error ? error.message : "Could not update favorite",
      );
    } finally {
      setFavoriteSaving(null);
    }
  };

  const openNewGame = () => {
    setGameTransferError(null);
    setLoadGameOpen(false);
    setNewGameOpen(true);
  };

  const openLoadGame = () => {
    setGameTransferError(null);
    setNewGameOpen(false);
    setLoadGameOpen(true);
  };

  const exportCurrentGame = async () => {
    setGameTransferAction("exporting");
    setGameTransferError(null);
    setExportNotice(null);
    try {
      const response = await fetch("/api/game/snapshot", {
        cache: "no-store",
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? "Could not export this game");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename =
        disposition.match(/filename="([^"]+)"/)?.[1] ??
        `diptych-picker-round-${gameRef.current?.round.roundNumber ?? 1}.json`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      const exportPath = response.headers.get("x-diptych-export-path");
      setExportNotice(
        exportPath
          ? `Exported ${filename} to ${exportPath} and downloaded a copy.`
          : `Downloaded ${filename}.`,
      );
      setLocalError(null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not export this game";
      if (newGameOpen || loadGameOpen) setGameTransferError(message);
      else setLocalError(message);
    } finally {
      setGameTransferAction(null);
    }
  };

  const importSavedGame = async (file: File) => {
    if (file.size > MAX_GAME_SAVE_BYTES) {
      setGameTransferError("The selected save file is too large");
      return;
    }
    setGameTransferAction("importing");
    setGameTransferError(null);
    selectionLocked.current = true;
    try {
      const state = await readJson<GameStartState>(
        await fetch("/api/game/snapshot", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: await file.text(),
        }),
      );
      if (state.status !== "ready") {
        throw new Error("The saved game did not contain a ready comparison");
      }
      const current = gameRef.current;
      if (current) {
        await preloadChangedAssets(
          current,
          state.game,
          new AbortController().signal,
        );
      }
      commitStartState(state);
      setNewGameOpen(false);
      setLoadGameOpen(false);
      setLocalError(null);
    } catch (error) {
      setGameTransferError(
        error instanceof Error ? error.message : "Could not load this game",
      );
    } finally {
      selectionLocked.current = false;
      setGameTransferAction(null);
    }
  };

  const startFreshGame = async () => {
    cancelActiveSelection();
    selectionLocked.current = true;
    setInitializing(true);
    setGameTransferAction("resetting");
    setGameTransferError(null);
    try {
      const state = await readJson<GameStartState>(
        await fetch("/api/game/start", { method: "POST" }),
      );
      commitStartState(state);
      setNewGameOpen(false);
      setLoadGameOpen(false);
      setLocalError(null);
    } catch (error) {
      setGameTransferError(
        error instanceof Error ? error.message : "Could not start a new game",
      );
    } finally {
      selectionLocked.current = false;
      setInitializing(false);
      setGameTransferAction(null);
    }
  };

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
      setPreferenceDraft((current) => ({
        ...current,
        ...result.profile,
        adaptationLastDecision:
          game?.history.length ?? current.adaptationLastDecision ?? 0,
        adaptationSourceWinnerIds: [],
        adaptationSourceRejectedIds: [],
      }));
      setSourceProfileSummary(result.reasoningSummary);
      setPreferenceVariationSource(variationSource);
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
    if (preferencesSaving || sourceProfileAnalyzing) return;
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
    setPreferenceDraft(currentProfile);
    setPreferenceDraftBaseProfile(currentProfile);
    setPreferenceVariationSource(game.variationSource ?? null);
    setPreferencesOpen(true);
  };

  const exploreCandidateVariations = async (
    candidate: InspectableCandidate,
  ) => {
    setImageInspector(null);
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

  const setPreferenceField = <Key extends PreferenceField>(
    key: Key,
    value: PreferenceProfile[Key],
  ) => {
    setPreferenceDraft((current) => ({
      ...current,
      [key]: value,
      adaptationLastDecision:
        game?.history.length ?? current.adaptationLastDecision ?? 0,
      adaptationSourceWinnerIds: [],
      adaptationSourceRejectedIds: [],
    }));
  };

  const setAdaptationFreedom = (
    freedom: "frozen" | "guided" | "unfettered",
  ) => {
    setPreferenceDraft((current) => ({
      ...current,
      adaptationMode: freedom === "frozen" ? "static" : "adaptive",
      adaptationStrength: freedom === "unfettered" ? "unfettered" : "guided",
      adaptationLastDecision: game?.history.length ?? 0,
      adaptationSourceWinnerIds:
        freedom === "frozen" ? [] : current.adaptationSourceWinnerIds,
      adaptationSourceRejectedIds:
        freedom === "frozen" ? [] : current.adaptationSourceRejectedIds,
    }));
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
          onClose={() => setHistoryOpen(false)}
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
          onClose={() => setLeaderboardOpen(false)}
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
          onClose={() => setLoadGameOpen(false)}
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
          onClose={() => setNewGameOpen(false)}
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
          selectionBoundWait={selectionBoundWait}
          onClose={closePreferences}
          onSave={() => void savePreferences()}
          onAnalyzeSource={analyzeSourceImage}
          onFieldChange={setPreferenceField}
          onFreedomChange={setAdaptationFreedom}
        />
      ) : null}
    </main>
  );
}
