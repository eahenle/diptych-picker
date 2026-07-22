"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  beginChampionRetirement,
  beginBothLose,
  beginSelection,
  beginTie,
  mergeServerResult,
  willRetireChampion,
  type DisplayedEloRatings,
  type GameStartState,
  type GameState,
  type Side,
} from "@/domain/game";
import { readJson } from "./game-api";
import { preloadChangedAssets, preloadImage } from "./image-preload";

const POLL_INTERVAL_MS = 150;
const MAX_RECONNECT_DELAY_MS = 2_400;
const RECONNECT_MESSAGE = "Connection interrupted. Reconnecting…";

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

interface UseSelectionControllerOptions {
  game: GameState | null;
  gameRef: RefObject<GameState | null>;
  commitGame: (next: GameState) => void;
  commitStartState: (next: GameStartState) => void;
  setConnectionStatus: Dispatch<SetStateAction<string | null>>;
  setEloRatings: Dispatch<SetStateAction<DisplayedEloRatings | null>>;
  setLocalError: Dispatch<SetStateAction<string | null>>;
}

function reconnectDelay(attempt: number): number {
  return Math.min(
    POLL_INTERVAL_MS * 2 ** Math.min(attempt, 8),
    MAX_RECONNECT_DELAY_MS,
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

export function useSelectionController({
  game,
  gameRef,
  commitGame,
  commitStartState,
  setConnectionStatus,
  setEloRatings,
  setLocalError,
}: UseSelectionControllerOptions) {
  const [reconcilingRetry, setReconcilingRetry] = useState(false);
  const selectionLockedRef = useRef(false);
  const activeSelectionRef = useRef<ActiveSelection | null>(null);
  const retryControllerRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelActiveSelection = useCallback(() => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
    activeSelectionRef.current?.controller.abort();
    activeSelectionRef.current = null;
    retryControllerRef.current?.abort();
    retryControllerRef.current = null;
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    selectionLockedRef.current = false;
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
        selectionLockedRef.current = false;
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
            await preloadImage(
              challenger.imageUrl,
              selection.controller.signal,
            );
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
    [
      commitGame,
      commitStartState,
      gameRef,
      setConnectionStatus,
      setEloRatings,
      setLocalError,
    ],
  );

  useEffect(() => cancelActiveSelection, [cancelActiveSelection]);

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
    selectionLockedRef.current = true;
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

      selectionLockedRef.current = true;
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
            selectionLockedRef.current = false;
            setConnectionStatus(null);
            setLocalError(null);
            commitGame(server);
            return;
          }
          const challenger =
            winnerSide === "left"
              ? server.round.rightCandidate
              : server.round.leftCandidate;
          await preloadImage(challenger.imageUrl, selection.controller.signal);
          if (activeSelectionRef.current?.token !== selection.token) return;
          activeSelectionRef.current = null;
          selectionLockedRef.current = false;
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
    [
      commitGame,
      setConnectionStatus,
      setEloRatings,
      setLocalError,
      startPolling,
    ],
  );

  const submitPairDecision = useCallback(
    async (current: GameState, outcome: "tie" | "both-lose") => {
      const selectedAt = new Date().toISOString();
      const optimistic =
        outcome === "tie"
          ? beginTie(current, "left", selectedAt)
          : beginBothLose(current, "left", selectedAt);
      if (!optimistic) return;

      selectionLockedRef.current = true;
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
          selectionLockedRef.current = false;
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
    [
      commitGame,
      setConnectionStatus,
      setEloRatings,
      setLocalError,
      startPolling,
    ],
  );

  const select = useCallback(
    (winnerSide: Side) => {
      const current = gameRef.current;
      if (
        !current ||
        selectionLockedRef.current ||
        current.round.status === "generating"
      ) {
        return;
      }
      void submitSelection(current, winnerSide);
    },
    [gameRef, submitSelection],
  );

  const tie = useCallback(() => {
    const current = gameRef.current;
    if (
      !current ||
      selectionLockedRef.current ||
      current.round.status === "generating"
    ) {
      return;
    }
    void submitPairDecision(current, "tie");
  }, [gameRef, submitPairDecision]);

  const bothLose = useCallback(() => {
    const current = gameRef.current;
    if (
      !current ||
      selectionLockedRef.current ||
      current.round.status === "generating"
    ) {
      return;
    }
    void submitPairDecision(current, "both-lose");
  }, [gameRef, submitPairDecision]);

  const retrySelection = useCallback(() => {
    const failed = gameRef.current;
    if (
      !failed ||
      failed.round.status !== "error" ||
      !failed.pendingSelection ||
      selectionLockedRef.current
    ) {
      return;
    }

    selectionLockedRef.current = true;
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
          selectionLockedRef.current = false;
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
          else selectionLockedRef.current = false;
          return;
        }

        selectionLockedRef.current = false;
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
    gameRef,
    setConnectionStatus,
    setEloRatings,
    setLocalError,
    startPolling,
    submitPairDecision,
    submitSelection,
  ]);

  return {
    cancelActiveSelection,
    reconcilingRetry,
    selectionLockedRef,
    bothLose,
    retrySelection,
    select,
    tie,
  };
}
