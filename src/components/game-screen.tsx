"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  beginSelection,
  mergeServerResult,
  type GameStartState,
  type GameState,
  type Side,
} from "@/domain/game";
import { CandidateCard } from "./candidate-card";
import styles from "./game-screen.module.css";

async function readJson<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

const POLL_INTERVAL_MS = 150;
const MAX_RECONNECT_DELAY_MS = 2_400;
const RECONNECT_MESSAGE = "Connection interrupted. Reconnecting…";

interface ActiveSelection {
  token: string;
  original: GameState;
  winnerSide: Side;
  expectedRound: number;
  generationJobId: string | null;
  controller: AbortController;
  polling: boolean;
  retryAttempt: number;
}

function reconnectDelay(attempt: number): number {
  return Math.min(
    POLL_INTERVAL_MS * 2 ** Math.min(attempt, 8),
    MAX_RECONNECT_DELAY_MS,
  );
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
  return (
    selection.generationJobId !== null &&
    server.round.roundNumber === selection.expectedRound &&
    server.pendingSelection?.kind === "generation" &&
    server.pendingSelection?.generationJobId === selection.generationJobId
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
  const winner =
    selection.winnerSide === "left"
      ? selection.original.round.leftCandidate
      : selection.original.round.rightCandidate;
  const loser =
    selection.winnerSide === "left"
      ? selection.original.round.rightCandidate
      : selection.original.round.leftCandidate;
  return history?.winnerId === winner.id && history.loserId === loser.id;
}

export function GameScreen() {
  const [game, setGame] = useState<GameState | null>(null);
  const [startState, setStartState] = useState<GameStartState | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [preferenceDraft, setPreferenceDraft] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<string | null>(null);
  const [reconcilingRetry, setReconcilingRetry] = useState(false);
  const selectionLocked = useRef(false);
  const gameRef = useRef<GameState | null>(null);
  const activeSelectionRef = useRef<ActiveSelection | null>(null);
  const retryControllerRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commitGame = useCallback((next: GameState) => {
    gameRef.current = next;
    setGame(next);
  }, []);

  const commitStartState = useCallback(
    (next: GameStartState) => {
      setStartState(next);
      if (next.status === "ready") {
        commitGame(next.game);
        setPreferenceDraft(next.game.preferenceSeed);
      } else {
        gameRef.current = null;
        setGame(null);
        setPreferenceDraft(next.preferenceSeed);
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

  useEffect(() => {
    if (
      game?.round.status !== "generating" ||
      !game.pendingSelection ||
      game.pendingSelection.kind !== "generation" ||
      activeSelectionRef.current
    ) {
      return;
    }
    const selection: ActiveSelection = {
      token: crypto.randomUUID(),
      original: game,
      winnerSide: game.pendingSelection.winnerSide,
      expectedRound: game.round.roundNumber,
      generationJobId: game.pendingSelection.generationJobId,
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
      const optimistic = beginSelection(
        current,
        winnerSide,
        new Date().toISOString(),
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
        const server = await readJson<GameState>(response);
        if (activeSelectionRef.current?.token !== selection.token) return;
        if (
          server.round.roundNumber === selection.expectedRound &&
          server.pendingSelection?.kind === "generation"
        ) {
          selection.generationJobId = server.pendingSelection.generationJobId;
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
        await preloadChangedAssets(
          gameRef.current ?? failed,
          server,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        retryControllerRef.current = null;
        setConnectionStatus(null);
        setLocalError(null);

        if (
          server.round.status === "generating" &&
          server.pendingSelection?.kind === "generation"
        ) {
          const selection: ActiveSelection = {
            token: crypto.randomUUID(),
            original: server,
            winnerSide: server.pendingSelection.winnerSide,
            expectedRound: server.round.roundNumber,
            generationJobId: server.pendingSelection.generationJobId,
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

        if (
          server.round.status === "error" &&
          server.pendingSelection?.kind === "generation"
        ) {
          setReconcilingRetry(false);
          commitGame(server);
          void submitSelection(server, server.pendingSelection.winnerSide);
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
  }, [commitGame, commitStartState, startPolling, submitSelection]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat)
        return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("textarea, input, button")) return;
      const key = event.key.toLowerCase();
      if (key === "a" || key === "1") void select("left");
      if (key === "b" || key === "2") void select("right");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [select]);

  const newGame = async () => {
    if (
      !window.confirm(
        "Start a new game? This clears the current round and selection history.",
      )
    )
      return;
    cancelActiveSelection();
    selectionLocked.current = true;
    setInitializing(true);
    try {
      const state = await readJson<GameStartState>(
        await fetch("/api/game/start", { method: "POST" }),
      );
      commitStartState(state);
      setLocalError(null);
    } catch (error) {
      setLocalError(
        error instanceof Error ? error.message : "Could not start a new game",
      );
    } finally {
      selectionLocked.current = false;
      setInitializing(false);
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

  const savePreferences = async () => {
    try {
      const state = await readJson<GameState>(
        await fetch("/api/game", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preferenceSeed: preferenceDraft }),
        }),
      );
      commitGame(state);
      setPreferencesOpen(false);
      setLocalError(null);
    } catch (error) {
      setLocalError(
        error instanceof Error ? error.message : "Could not save preferences",
      );
    }
  };

  const retryAvailable =
    game?.round.status === "error" && Boolean(game.pendingSelection);
  const status = game?.round.status;
  const streak = game?.round.winStreak ?? 0;

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <h1>
          Diptych <em>Picker</em>
        </h1>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.utilityButton}
            disabled={
              !game ||
              status === "generating" ||
              reconcilingRetry ||
              initializing
            }
            onClick={() => setPreferencesOpen(true)}
          >
            Preferences
          </button>
          <button
            type="button"
            className={styles.newGameButton}
            disabled={
              status === "generating" || reconcilingRetry || initializing
            }
            onClick={newGame}
          >
            New game
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
            <span>
              Round <strong>{game.round.roundNumber}</strong>
            </span>
            <i aria-hidden="true" />
            <span>
              Win streak <strong>{streak}</strong>
            </span>
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
                  status === "generating" && game.round.replacingSide === "left"
                }
                disabled={status === "generating" || reconcilingRetry}
                onSelect={select}
              />
              <CandidateCard
                candidate={game.round.rightCandidate}
                side="right"
                label="B"
                loading={
                  status === "generating" &&
                  game.round.replacingSide === "right"
                }
                disabled={status === "generating" || reconcilingRetry}
                onSelect={select}
              />
            </section>
          </div>

          <p className={styles.shortcuts}>
            Choose with <kbd>A</kbd> or <kbd>1</kbd> for left <span>•</span>{" "}
            <kbd>B</kbd> or <kbd>2</kbd> for right
          </p>

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
        </>
      ) : null}

      {preferencesOpen && game ? (
        <div
          className={styles.modalBackdrop}
          role="presentation"
          onMouseDown={() => setPreferencesOpen(false)}
        >
          <section
            className={styles.preferencesModal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="preferences-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="preferences-title">Preference profile</h2>
            <p>
              Inspiration for future challengers. Novelty rules still take
              priority.
            </p>
            <textarea
              value={preferenceDraft}
              onChange={(event) => setPreferenceDraft(event.target.value)}
              rows={9}
            />
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.utilityButton}
                onClick={() => setPreferencesOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.newGameButton}
                onClick={savePreferences}
              >
                Save profile
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
