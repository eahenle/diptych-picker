"use client";

/* eslint-disable @next/next/no-img-element -- History and leaderboard thumbnails use immutable local candidate URLs. */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  beginChampionRetirement,
  beginBothLose,
  beginSelection,
  beginTie,
  isSelectionBoundWait,
  mergeServerResult,
  preferenceAdaptationFreedom,
  preferenceAdaptationProgress,
  preferenceProfileFromSeed,
  willRetireChampion,
  type BufferHealth,
  type Candidate,
  type DisplayedEloRatings,
  type GameStartState,
  type GameState,
  type PreferenceProfile,
  type PreferenceRevision,
  type Side,
} from "@/domain/game";
import type {
  ComparisonHistoryCandidate,
  ComparisonHistoryEntry,
  PoolLeaderboardEntry,
} from "@/domain/challenger-state";
import { CandidateCard } from "./candidate-card";
import { ModalShell } from "./modal-shell";
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
type GameTransferAction = "exporting" | "importing" | "resetting";
type InspectableCandidate = Pick<Candidate, "id" | "imageUrl" | "concept">;
interface ImageInspectorState {
  candidates: InspectableCandidate[];
  index: number;
  returnTarget: "leaderboard" | null;
}
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

function formatSelectionTime(selectedAt: string): string {
  const date = new Date(selectedAt);
  if (Number.isNaN(date.valueOf())) return selectedAt;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
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
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const sourceProfileInputRef = useRef<HTMLInputElement | null>(null);
  const sourceProfileControllerRef = useRef<AbortController | null>(null);
  const queuedPreferenceProfileRef = useRef<PreferenceProfile | null>(null);
  const queuedPreferenceSaveStartedRef = useRef(false);
  const inspectedCandidate = imageInspector?.candidates[imageInspector.index];

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
      historyOpen ||
      Boolean(inspectedCandidate),
    onSelect: select,
    onTie: tie,
    onBothLose: bothLose,
  });

  useEffect(() => {
    if (!imageInspector) return;
    const navigateInspector = (event: KeyboardEvent) => {
      const direction =
        event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (direction === 0 || imageInspector.candidates.length < 2) return;
      event.preventDefault();
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
    };
    window.addEventListener("keydown", navigateInspector);
    return () => window.removeEventListener("keydown", navigateInspector);
  }, [imageInspector]);

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
      if (importInputRef.current) importInputRef.current.value = "";
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
    async (profile: PreferenceProfile, expectedProfile: PreferenceProfile) => {
      setPreferencesSaving(true);
      try {
        const state = await readJson<GameState>(
          await fetch("/api/game", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              preferenceProfile: profile,
              expectedPreferenceProfile: expectedProfile,
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
      queuedPreferenceSaveStartedRef.current = false;
      setPreferenceSaveQueued(true);
      setPreferencesSaving(true);
      setLocalError(null);
      return;
    }
    await persistPreferences(preferenceDraft, preferenceDraftBaseProfile);
  };

  const analyzeSourceImage = async (image: File) => {
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
      if (sourceProfileInputRef.current) {
        sourceProfileInputRef.current.value = "";
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
    queuedPreferenceSaveStartedRef.current = false;
    setPreferenceSaveQueued(false);
    setPreferencesSaving(false);
    setSourceProfileError(null);
    setSourceProfileSummary(null);
    setPreferenceDraft(currentProfile);
    setPreferenceDraftBaseProfile(currentProfile);
    setPreferencesOpen(true);
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

  const setPreferenceField = <Key extends keyof PreferenceProfile>(
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
  const preferencesBusy = preferencesSaving || sourceProfileAnalyzing;
  const adaptationFreedom = preferenceAdaptationFreedom(preferenceDraft);
  const adaptationFreedomValue = {
    frozen: 0,
    guided: 1,
    unfettered: 2,
  }[adaptationFreedom];
  const adaptationProgress = game
    ? preferenceAdaptationProgress(preferenceDraft, game.history.length)
    : null;
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
    void persistPreferences(queuedProfile, currentProfile);
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
                <span
                  className={styles.supplyMetric}
                  aria-label={`Ready queue ${bufferHealth.ready} of ${bufferHealth.target}; ${bufferHealth.inFlight} generating`}
                  title={`${bufferHealth.inFlight} challenger${bufferHealth.inFlight === 1 ? "" : "s"} generating`}
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
                </span>
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

      {inspectedCandidate ? (
        <ModalShell
          className={styles.imageInspector}
          ariaLabel={`Expanded image: ${inspectedCandidate.concept}`}
          onClose={closeImageInspector}
        >
          <>
            <button
              type="button"
              className={styles.leaderboardClose}
              aria-label="Close expanded image"
              onClick={closeImageInspector}
            >
              ×
            </button>
            {imageInspector.candidates.length > 1 ? (
              <>
                <button
                  type="button"
                  className={`${styles.inspectorNavigation} ${styles.inspectorPrevious}`}
                  aria-label="Previous expanded image"
                  onClick={() =>
                    setImageInspector((current) =>
                      current
                        ? {
                            ...current,
                            index:
                              (current.index - 1 + current.candidates.length) %
                              current.candidates.length,
                          }
                        : current,
                    )
                  }
                >
                  ‹
                </button>
                <button
                  type="button"
                  className={`${styles.inspectorNavigation} ${styles.inspectorNext}`}
                  aria-label="Next expanded image"
                  onClick={() =>
                    setImageInspector((current) =>
                      current
                        ? {
                            ...current,
                            index:
                              (current.index + 1) % current.candidates.length,
                          }
                        : current,
                    )
                  }
                >
                  ›
                </button>
              </>
            ) : null}
            <figure>
              <img
                src={inspectedCandidate.imageUrl}
                alt={inspectedCandidate.concept}
              />
              <figcaption>
                {inspectedCandidate.concept}
                {imageInspector.candidates.length > 1 ? (
                  <small>
                    {imageInspector.index + 1} of{" "}
                    {imageInspector.candidates.length}
                    {" · Use Left and Right arrow keys"}
                  </small>
                ) : null}
              </figcaption>
            </figure>
          </>
        </ModalShell>
      ) : null}

      {historyOpen && game ? (
        <ModalShell
          className={`${styles.preferencesModal} ${styles.historyModal}`}
          onClose={() => setHistoryOpen(false)}
          ariaLabelledBy="comparison-history-title"
          ariaDescribedBy="comparison-history-description"
        >
          <>
            <button
              type="button"
              className={styles.leaderboardClose}
              aria-label="Close history"
              onClick={() => setHistoryOpen(false)}
            >
              ×
            </button>
            <h2 id="comparison-history-title">Comparison history</h2>
            <p id="comparison-history-description">
              Newest choices first. Each row shows the two candidates and the
              decision without exposing their generation prompts.
            </p>
            {favoriteError ? (
              <p className={styles.transferError} role="alert">
                {favoriteError}
              </p>
            ) : null}
            {historyLoading ? (
              <p className={styles.leaderboardState} role="status">
                Rebuilding the timeline…
              </p>
            ) : historyError ? (
              <p className={styles.transferError} role="alert">
                {historyError}
              </p>
            ) : historyEntries.length === 0 ? (
              <p className={styles.leaderboardState}>
                No comparisons have been decided yet.
              </p>
            ) : (
              <>
                <p className={styles.historyCount}>
                  Showing {historyEntries.length} of {historyTotal} decisions
                </p>
                <ol className={styles.historyList}>
                  {historyEntries.map((entry) => {
                    const pairDecision =
                      entry.outcome === "tie" || entry.outcome === "both-lose";
                    const primary = pairDecision ? entry.left : entry.winner;
                    const secondary = pairDecision ? entry.right : entry.loser;
                    return (
                      <li key={`${entry.decisionNumber}-${entry.selectedAt}`}>
                        <span className={styles.historyDecision}>
                          #{entry.decisionNumber}
                        </span>
                        <span className={styles.historyCandidate}>
                          {primary.imageUrl ? (
                            <button
                              type="button"
                              className={styles.historyImageButton}
                              aria-label={`View ${primary.concept} larger`}
                              title="View larger"
                              onClick={() => inspectHistoryCandidate(primary)}
                            >
                              <img
                                src={primary.imageUrl}
                                alt=""
                                width={64}
                                height={64}
                              />
                            </button>
                          ) : (
                            <span
                              className={styles.historyImagePlaceholder}
                              aria-hidden="true"
                            >
                              —
                            </span>
                          )}
                          <span>
                            <strong>{primary.concept}</strong>
                            <small>
                              {primary.style.slice(0, 2).join(" · ")}
                            </small>
                            <span className={styles.candidateFooter}>
                              <em>
                                {entry.outcome === "tie"
                                  ? "Tied"
                                  : entry.outcome === "both-lose"
                                    ? "Rejected"
                                    : "Winner"}
                              </em>
                              {primary.favorite !== null ? (
                                <button
                                  type="button"
                                  className={styles.favoriteButton}
                                  aria-label={`${primary.favorite ? "Remove" : "Add"} ${primary.concept} ${primary.favorite ? "from" : "to"} favorites`}
                                  title={
                                    primary.favorite
                                      ? "Remove from favorites"
                                      : "Add to favorites"
                                  }
                                  aria-pressed={primary.favorite}
                                  disabled={favoriteSaving === primary.id}
                                  onClick={() =>
                                    void updateFavorite(
                                      primary.id,
                                      !primary.favorite,
                                    )
                                  }
                                >
                                  {primary.favorite ? "★" : "☆"}
                                </button>
                              ) : null}
                            </span>
                          </span>
                        </span>
                        <span
                          className={styles.historyVersus}
                          aria-hidden="true"
                        >
                          {entry.outcome === "tie"
                            ? "with"
                            : entry.outcome === "both-lose"
                              ? "and"
                              : "over"}
                        </span>
                        <span className={styles.historyCandidate}>
                          {secondary.imageUrl ? (
                            <button
                              type="button"
                              className={styles.historyImageButton}
                              aria-label={`View ${secondary.concept} larger`}
                              title="View larger"
                              onClick={() => inspectHistoryCandidate(secondary)}
                            >
                              <img
                                src={secondary.imageUrl}
                                alt=""
                                width={64}
                                height={64}
                              />
                            </button>
                          ) : (
                            <span
                              className={styles.historyImagePlaceholder}
                              aria-hidden="true"
                            >
                              —
                            </span>
                          )}
                          <span>
                            <strong>{secondary.concept}</strong>
                            <small>
                              {secondary.style.slice(0, 2).join(" · ")}
                            </small>
                            <span className={styles.candidateFooter}>
                              <em>
                                {entry.outcome === "tie" ? "Tied" : "Rejected"}
                              </em>
                              {secondary.favorite !== null ? (
                                <button
                                  type="button"
                                  className={styles.favoriteButton}
                                  aria-label={`${secondary.favorite ? "Remove" : "Add"} ${secondary.concept} ${secondary.favorite ? "from" : "to"} favorites`}
                                  title={
                                    secondary.favorite
                                      ? "Remove from favorites"
                                      : "Add to favorites"
                                  }
                                  aria-pressed={secondary.favorite}
                                  disabled={favoriteSaving === secondary.id}
                                  onClick={() =>
                                    void updateFavorite(
                                      secondary.id,
                                      !secondary.favorite,
                                    )
                                  }
                                >
                                  {secondary.favorite ? "★" : "☆"}
                                </button>
                              ) : null}
                            </span>
                          </span>
                        </span>
                        <time dateTime={entry.selectedAt}>
                          {formatSelectionTime(entry.selectedAt)}
                        </time>
                      </li>
                    );
                  })}
                </ol>
              </>
            )}
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.utilityButton}
                onClick={() => setHistoryOpen(false)}
              >
                Close
              </button>
            </div>
          </>
        </ModalShell>
      ) : null}

      {leaderboardOpen && game ? (
        <ModalShell
          className={`${styles.preferencesModal} ${styles.leaderboardModal}`}
          onClose={() => setLeaderboardOpen(false)}
          ariaLabelledBy="pool-leaderboard-title"
          ariaDescribedBy="pool-leaderboard-description"
        >
          <>
            <button
              type="button"
              className={styles.leaderboardClose}
              aria-label="Close leaderboard"
              onClick={() => setLeaderboardOpen(false)}
            >
              ×
            </button>
            <h2 id="pool-leaderboard-title">Pool leaderboard</h2>
            <p id="pool-leaderboard-description">
              Reusable images ranked by Elo. Compared generated challengers can
              enter the pool; the strongest entries remain available for paced
              fallback comparisons.
            </p>
            {favoriteError ? (
              <p className={styles.transferError} role="alert">
                {favoriteError}
              </p>
            ) : null}
            {leaderboardLoading ? (
              <p className={styles.leaderboardState} role="status">
                Ranking the pool…
              </p>
            ) : leaderboardError ? (
              <p className={styles.transferError} role="alert">
                {leaderboardError}
              </p>
            ) : leaderboardEntries.length === 0 ? (
              <p className={styles.leaderboardState}>The pool is empty.</p>
            ) : (
              <ol className={styles.leaderboardList}>
                {leaderboardEntries.map((entry) => (
                  <li key={entry.candidate.id}>
                    <button
                      type="button"
                      className={styles.leaderboardEntryButton}
                      aria-label={`View ${entry.candidate.concept} larger`}
                      onClick={() =>
                        inspectLeaderboardCandidate(entry.candidate)
                      }
                    >
                      <span className={styles.leaderboardRank}>
                        {entry.rank}
                      </span>
                      <img
                        src={entry.candidate.imageUrl}
                        alt=""
                        width={72}
                        height={72}
                      />
                      <span className={styles.leaderboardIdentity}>
                        <strong>{entry.candidate.concept}</strong>
                        <small>
                          {entry.candidate.style.slice(0, 3).join(" · ")}
                        </small>
                        <em>
                          {entry.source === "curated" ? "Curated" : "Generated"}
                        </em>
                      </span>
                      <span
                        className={styles.leaderboardScore}
                        aria-label={`Elo ${entry.rating}; ${entry.wins} wins and ${entry.losses} losses`}
                      >
                        <strong>{entry.rating}</strong>
                        <small>
                          {entry.wins}W–{entry.losses}L
                        </small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={styles.favoriteButton}
                      aria-label={`${entry.favorite ? "Remove" : "Add"} ${entry.candidate.concept} ${entry.favorite ? "from" : "to"} favorites`}
                      title={
                        entry.favorite
                          ? "Remove from favorites"
                          : "Add to favorites"
                      }
                      aria-pressed={entry.favorite}
                      disabled={favoriteSaving === entry.candidate.id}
                      onClick={() =>
                        void updateFavorite(entry.candidate.id, !entry.favorite)
                      }
                    >
                      {entry.favorite ? "★" : "☆"}
                    </button>
                  </li>
                ))}
              </ol>
            )}
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.utilityButton}
                onClick={() => setLeaderboardOpen(false)}
              >
                Close
              </button>
            </div>
          </>
        </ModalShell>
      ) : null}

      {loadGameOpen && game ? (
        <ModalShell
          className={`${styles.preferencesModal} ${styles.gameStateModal}`}
          onClose={() => {
            if (!gameTransferAction) setLoadGameOpen(false);
          }}
          ariaLabelledBy="load-game-title"
          ariaDescribedBy="load-game-description load-game-save-note"
          ariaBusy={gameTransferAction !== null}
        >
          <>
            <h2 id="load-game-title">Load saved game</h2>
            <p id="load-game-description">
              Loading replaces the current round and learned state after the
              save and its local images pass validation.
            </p>
            <div className={styles.transferOptions}>
              <div className={styles.transferOption}>
                <span>
                  <strong>Keep this game first</strong>
                  <small>
                    Download the current round, history, preferences, queue,
                    ratings, and pool membership before loading another save.
                  </small>
                </span>
                <button
                  type="button"
                  className={styles.utilityButton}
                  disabled={gameTransferAction !== null}
                  onClick={() => void exportCurrentGame()}
                >
                  {gameTransferAction === "exporting"
                    ? "Exporting…"
                    : "Export current game first"}
                </button>
              </div>
              <div className={styles.transferOption}>
                <span>
                  <strong>Choose a saved game</strong>
                  <small>
                    The current game stays unchanged if the save cannot be
                    restored safely.
                  </small>
                </span>
                <button
                  type="button"
                  className={styles.utilityButton}
                  disabled={gameTransferAction !== null}
                  onClick={() => importInputRef.current?.click()}
                >
                  {gameTransferAction === "importing"
                    ? "Loading…"
                    : "Choose saved game"}
                </button>
                <input
                  ref={importInputRef}
                  className={styles.fileInput}
                  type="file"
                  accept="application/json,.json"
                  aria-label="Choose saved game file"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void importSavedGame(file);
                  }}
                />
              </div>
            </div>
            <p id="load-game-save-note" className={styles.gameSaveNote}>
              Save files use this installation&apos;s immutable image library;
              missing local images are rejected without changing the current
              game.
            </p>
            {gameTransferError ? (
              <p className={styles.transferError} role="alert">
                {gameTransferError}
              </p>
            ) : null}
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.utilityButton}
                disabled={gameTransferAction !== null}
                onClick={() => setLoadGameOpen(false)}
              >
                Cancel
              </button>
            </div>
          </>
        </ModalShell>
      ) : null}

      {newGameOpen && game ? (
        <ModalShell
          className={`${styles.preferencesModal} ${styles.gameStateModal}`}
          onClose={() => {
            if (!gameTransferAction) setNewGameOpen(false);
          }}
          ariaLabelledBy="new-game-title"
          ariaDescribedBy="new-game-description game-save-note"
          ariaBusy={gameTransferAction !== null}
        >
          <>
            <h2 id="new-game-title">New game</h2>
            <p id="new-game-description">
              Save this exact game before starting over, or restore a game you
              saved earlier.
            </p>
            <div className={styles.transferOptions}>
              <div className={styles.transferOption}>
                <span>
                  <strong>Keep this game</strong>
                  <small>
                    Export the round, history, preferences, queue, ratings, and
                    pool membership.
                  </small>
                </span>
                <button
                  type="button"
                  className={styles.utilityButton}
                  disabled={gameTransferAction !== null}
                  onClick={() => void exportCurrentGame()}
                >
                  {gameTransferAction === "exporting"
                    ? "Exporting…"
                    : "Export current game"}
                </button>
              </div>
              <div className={styles.transferOption}>
                <span>
                  <strong>Return to a saved game</strong>
                  <small>
                    Loading a save replaces the current round and learned state
                    after validation.
                  </small>
                </span>
                <button
                  type="button"
                  className={styles.utilityButton}
                  disabled={gameTransferAction !== null}
                  onClick={() => importInputRef.current?.click()}
                >
                  {gameTransferAction === "importing"
                    ? "Loading…"
                    : "Load saved game"}
                </button>
                <input
                  ref={importInputRef}
                  className={styles.fileInput}
                  type="file"
                  accept="application/json,.json"
                  aria-label="Choose saved game file"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void importSavedGame(file);
                  }}
                />
              </div>
            </div>
            <p id="game-save-note" className={styles.gameSaveNote}>
              Save files use this installation&apos;s immutable image library;
              missing local images are rejected without changing the current
              game.
            </p>
            {gameTransferError ? (
              <p className={styles.transferError} role="alert">
                {gameTransferError}
              </p>
            ) : null}
            <div className={styles.freshGameSection}>
              <span>
                <strong>Start fresh</strong>
                <small>
                  Clears the current round, history, and preference profile.
                  Learned pool ratings and image files stay available.
                </small>
              </span>
              <button
                type="button"
                className={styles.newGameButton}
                disabled={gameTransferAction !== null}
                onClick={() => void startFreshGame()}
              >
                {gameTransferAction === "resetting"
                  ? "Starting…"
                  : "Start new game"}
              </button>
            </div>
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.utilityButton}
                disabled={gameTransferAction !== null}
                onClick={() => setNewGameOpen(false)}
              >
                Cancel
              </button>
            </div>
          </>
        </ModalShell>
      ) : null}

      {preferencesOpen && game ? (
        <ModalShell
          className={styles.preferencesModal}
          onClose={closePreferences}
          ariaBusy={preferencesBusy}
          ariaLabelledBy="preferences-title"
          ariaDescribedBy={
            selectionBoundWait
              ? "preferences-description preferences-wait-note"
              : "preferences-description"
          }
          initialFocusSelector="#preference-themes"
        >
          <>
            <div className={styles.preferenceTitleRow}>
              <h2 id="preferences-title">Preference profile</h2>
              <div className={styles.adaptationFreedom}>
                <label htmlFor="adaptation-freedom">
                  Model freedom <strong>{adaptationFreedom}</strong>
                </label>
                <input
                  id="adaptation-freedom"
                  type="range"
                  min="0"
                  max="2"
                  step="1"
                  value={adaptationFreedomValue}
                  style={
                    {
                      "--adaptation-fill": `${adaptationFreedomValue * 50}%`,
                    } as CSSProperties
                  }
                  disabled={preferencesBusy}
                  aria-label="Model rewrite freedom"
                  aria-valuetext={
                    adaptationFreedom === "frozen"
                      ? "Frozen"
                      : adaptationFreedom === "guided"
                        ? "Guided, every 15 rounds"
                        : "Unfettered, every 5 rounds"
                  }
                  onChange={(event) => {
                    const freedom = ["frozen", "guided", "unfettered"] as const;
                    setAdaptationFreedom(
                      freedom[Number(event.target.value)] ?? "guided",
                    );
                  }}
                />
                <span className={styles.adaptationFreedomTicks}>
                  <small>Frozen</small>
                  <small>Guided</small>
                  <small>Unfettered</small>
                </span>
              </div>
            </div>
            <p id="preferences-description">
              {adaptationFreedom === "frozen"
                ? "Frozen preserves every field exactly as saved."
                : adaptationFreedom === "guided"
                  ? "Guided allows restrained, leaderboard-driven refinements across the profile after every 15 completed rounds."
                  : "Unfettered lets the model rewrite every preference field after every 5 completed rounds."}{" "}
              {adaptationFreedom !== "frozen" &&
              preferenceDraft.adaptationSourceWinnerIds.length +
                preferenceDraft.adaptationSourceRejectedIds.length >
                0
                ? `Evidence — winners: ${preferenceDraft.adaptationSourceWinnerIds.length}; rejected: ${preferenceDraft.adaptationSourceRejectedIds.length}. `
                : null}
              Novelty rules still take priority.
            </p>
            {adaptationProgress ? (
              <div
                className={styles.adaptationCadence}
                role="status"
                aria-label="Preference rewrite cadence"
              >
                <span>
                  {adaptationProgress.due
                    ? "Rewrite checkpoint ready"
                    : `Next rewrite checkpoint in ${adaptationProgress.remaining} ${adaptationProgress.remaining === 1 ? "round" : "rounds"}`}
                </span>
                <progress
                  aria-label="Rounds toward next preference rewrite"
                  max={adaptationProgress.interval}
                  value={adaptationProgress.completed}
                />
                <small>
                  {adaptationProgress.due
                    ? "The next winning generated candidate may update this profile."
                    : `${adaptationProgress.completed} of ${adaptationProgress.interval} rounds completed since the last rewrite checkpoint.`}
                </small>
              </div>
            ) : null}
            <div className={styles.sourceProfileImport}>
              <span>
                <strong>Start from an image</strong>
                <small>
                  Infer transferable content and style, then review every field
                  before saving.
                </small>
              </span>
              <input
                ref={sourceProfileInputRef}
                className={styles.hiddenFileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                aria-label="Choose source image"
                disabled={preferencesBusy}
                onChange={(event) => {
                  const image = event.target.files?.[0];
                  if (image) void analyzeSourceImage(image);
                }}
              />
              <button
                type="button"
                className={styles.utilityButton}
                disabled={preferencesBusy}
                onClick={() => sourceProfileInputRef.current?.click()}
              >
                Analyze image
              </button>
            </div>
            <div className={styles.preferenceGrid}>
              <div className={styles.fieldWide}>
                <label htmlFor="preference-themes">
                  <span>Themes &amp; subjects</span>
                </label>
                <textarea
                  id="preference-themes"
                  value={preferenceDraft.themes}
                  disabled={preferencesBusy}
                  onChange={(event) =>
                    setPreferenceField("themes", event.target.value)
                  }
                  rows={4}
                  minLength={20}
                  maxLength={2000}
                  placeholder="What worlds, subjects, or ideas should the game explore?"
                  aria-describedby="preference-themes-hint"
                />
                <small id="preference-themes-hint">20–2,000 characters.</small>
              </div>
              <div className={styles.fieldWide}>
                <label htmlFor="preference-inspiration">
                  <span>Inspiration</span>
                </label>
                <textarea
                  id="preference-inspiration"
                  value={preferenceDraft.inspiration}
                  disabled={preferencesBusy}
                  onChange={(event) =>
                    setPreferenceField("inspiration", event.target.value)
                  }
                  rows={3}
                  maxLength={1000}
                  placeholder="Optional composition, lighting, mood, or treatment cues"
                  aria-describedby="preference-inspiration-hint"
                />
                <small id="preference-inspiration-hint">
                  Optional composition, lighting, mood, or treatment cues.
                </small>
              </div>
              <label className={styles.field}>
                <span>Preferred media</span>
                <input
                  value={preferenceDraft.mediaTypes}
                  disabled={preferencesBusy}
                  maxLength={500}
                  onChange={(event) =>
                    setPreferenceField("mediaTypes", event.target.value)
                  }
                  placeholder="Photography, oil paint, linocut…"
                />
              </label>
              <label className={styles.field}>
                <span>Visual style &amp; mood</span>
                <input
                  value={preferenceDraft.visualStyle}
                  disabled={preferencesBusy}
                  maxLength={500}
                  onChange={(event) =>
                    setPreferenceField("visualStyle", event.target.value)
                  }
                  placeholder="Cinematic, eerie, playful…"
                />
              </label>
              <label className={styles.field}>
                <span>Color palette</span>
                <input
                  value={preferenceDraft.colorPalette}
                  disabled={preferencesBusy}
                  maxLength={500}
                  onChange={(event) =>
                    setPreferenceField("colorPalette", event.target.value)
                  }
                  placeholder="Oxblood, copper, ultraviolet…"
                />
              </label>
              <fieldset className={`${styles.field} ${styles.contentField}`}>
                <legend>Content range</legend>
                <div className={styles.contentChoices}>
                  <label className={styles.contentChoice}>
                    <input
                      type="radio"
                      name="content-range"
                      value="family-friendly"
                      disabled={preferencesBusy}
                      checked={
                        preferenceDraft.contentLevel === "family-friendly"
                      }
                      onChange={() =>
                        setPreferenceField("contentLevel", "family-friendly")
                      }
                    />
                    <span>
                      Family-friendly
                      <small>Broadly suitable imagery</small>
                    </span>
                  </label>
                  <label className={styles.contentChoice}>
                    <input
                      type="radio"
                      name="content-range"
                      value="adult-allowed"
                      disabled={preferencesBusy}
                      checked={preferenceDraft.contentLevel === "adult-allowed"}
                      onChange={() =>
                        setPreferenceField("contentLevel", "adult-allowed")
                      }
                    />
                    <span>
                      Adult themes
                      <small>Mature, never explicit</small>
                    </span>
                  </label>
                </div>
              </fieldset>
              <label className={styles.fieldWide}>
                <span>Avoid or de-emphasize</span>
                <textarea
                  value={preferenceDraft.avoid}
                  disabled={preferencesBusy}
                  maxLength={800}
                  onChange={(event) =>
                    setPreferenceField("avoid", event.target.value)
                  }
                  rows={2}
                  placeholder="Subjects, clichés, media, or colors you would rather see less often"
                />
              </label>
            </div>
            {sourceProfileAnalyzing ? (
              <div
                className={styles.preferenceSaveProgress}
                role="status"
                aria-live="polite"
              >
                <span
                  className={styles.preferenceSaveSpinner}
                  data-testid="source-profile-spinner"
                  aria-hidden="true"
                />
                <span>
                  <strong>Analyzing source image</strong>
                  <small>
                    Extracting transferable themes, composition, style, and
                    palette…
                  </small>
                </span>
              </div>
            ) : sourceProfileError ? (
              <p className={styles.sourceProfileError} role="alert">
                {sourceProfileError}
              </p>
            ) : sourceProfileSummary ? (
              <p className={styles.sourceProfileSummary} role="status">
                Profile populated for review. {sourceProfileSummary}
              </p>
            ) : null}
            {preferencesSaving ? (
              <div
                id={selectionBoundWait ? "preferences-wait-note" : undefined}
                className={styles.preferenceSaveProgress}
                role="status"
                aria-live="polite"
              >
                <span
                  className={styles.preferenceSaveSpinner}
                  data-testid="preference-save-spinner"
                  aria-hidden="true"
                />
                <span>
                  <strong>
                    {preferenceSaveQueued && selectionBoundWait
                      ? "Profile queued"
                      : "Saving profile"}
                  </strong>
                  <small>
                    {preferenceSaveQueued && selectionBoundWait
                      ? "Waiting for the challenger to arrive…"
                      : "Applying your preferences…"}
                  </small>
                </span>
              </div>
            ) : selectionBoundWait ? (
              <p
                id="preferences-wait-note"
                className={styles.preferenceNotice}
                role="status"
              >
                Save now to apply these changes when the challenger arrives.
              </p>
            ) : null}
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.utilityButton}
                disabled={preferencesBusy}
                onClick={closePreferences}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.newGameButton}
                disabled={
                  preferencesBusy || preferenceDraft.themes.trim().length < 20
                }
                onClick={() => void savePreferences()}
              >
                {preferencesSaving
                  ? preferenceSaveQueued && selectionBoundWait
                    ? "Waiting…"
                    : "Saving…"
                  : "Save profile"}
              </button>
            </div>
          </>
        </ModalShell>
      ) : null}
    </main>
  );
}
