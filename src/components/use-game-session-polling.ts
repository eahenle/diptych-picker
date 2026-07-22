"use client";

import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { BufferHealth, GameStartState, GameState } from "@/domain/game";
import { readJson } from "./game-api";

const POLL_INTERVAL_MS = 150;
const HEALTH_POLL_INTERVAL_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 2_400;
const RECONNECT_MESSAGE = "Connection interrupted. Reconnecting…";

interface UseGameSessionPollingOptions {
  bufferHealth: BufferHealth | null;
  game: GameState | null;
  startState: GameStartState | null;
  commitGame: (next: GameState) => void;
  commitStartState: (next: GameStartState) => void;
  setBufferHealth: Dispatch<SetStateAction<BufferHealth | null>>;
  setConnectionStatus: Dispatch<SetStateAction<string | null>>;
  setInitializing: Dispatch<SetStateAction<boolean>>;
  setLocalError: Dispatch<SetStateAction<string | null>>;
}

function reconnectDelay(attempt: number): number {
  return Math.min(
    POLL_INTERVAL_MS * 2 ** Math.min(attempt, 8),
    MAX_RECONNECT_DELAY_MS,
  );
}

export function useGameSessionPolling({
  bufferHealth,
  game,
  startState,
  commitGame,
  commitStartState,
  setBufferHealth,
  setConnectionStatus,
  setInitializing,
  setLocalError,
}: UseGameSessionPollingOptions) {
  const initialPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const healthPollingEnabled = game !== null && bufferHealth !== null;
  const healthRound = game?.round.roundNumber ?? null;
  const promptCardBackgroundJobIds = [
    game?.promptDeck?.editorJob?.jobId,
    game?.promptDeck?.blendJob?.jobId,
  ].filter((jobId): jobId is string => Boolean(jobId));
  const promptCardBackgroundJobKey = promptCardBackgroundJobIds.join(":");

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
  }, [commitStartState, setConnectionStatus, setInitializing, setLocalError]);

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
  }, [
    commitStartState,
    setConnectionStatus,
    setLocalError,
    startState?.status,
  ]);

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
  }, [healthPollingEnabled, healthRound, setBufferHealth]);

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

  const retryInitial = useCallback(async () => {
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
  }, [commitStartState, setInitializing, setLocalError]);

  return { retryInitial };
}
