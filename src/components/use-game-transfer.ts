"use client";

import {
  useCallback,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { GameStartState, GameState } from "@/domain/game";
import { readJson } from "./game-api";
import type { GameTransferAction } from "./game-transfer-modal";
import { preloadChangedAssets } from "./image-preload";

const MAX_GAME_SAVE_BYTES = 25 * 1024 * 1024;

interface UseGameTransferOptions {
  gameRef: MutableRefObject<GameState | null>;
  selectionLockedRef: MutableRefObject<boolean>;
  commitStartState: (state: GameStartState) => void;
  cancelActiveSelection: () => void;
  setInitializing: Dispatch<SetStateAction<boolean>>;
  setLocalError: Dispatch<SetStateAction<string | null>>;
  onSessionReady?: () => void;
}

export function useGameTransfer({
  gameRef,
  selectionLockedRef,
  commitStartState,
  cancelActiveSelection,
  setInitializing,
  setLocalError,
  onSessionReady,
}: UseGameTransferOptions) {
  const [newGameOpen, setNewGameOpen] = useState(false);
  const [loadGameOpen, setLoadGameOpen] = useState(false);
  const [imageImportOpen, setImageImportOpen] = useState(false);
  const [action, setAction] = useState<GameTransferAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  const openNewGame = useCallback(() => {
    setError(null);
    setLoadGameOpen(false);
    setImageImportOpen(false);
    setNewGameOpen(true);
  }, []);

  const openLoadGame = useCallback(() => {
    setError(null);
    setNewGameOpen(false);
    setImageImportOpen(false);
    setLoadGameOpen(true);
  }, []);

  const openImageImport = useCallback(() => {
    setError(null);
    setLoadGameOpen(false);
    setNewGameOpen(false);
    setImageImportOpen(true);
  }, []);

  const closeNewGame = useCallback(() => setNewGameOpen(false), []);
  const closeLoadGame = useCallback(() => setLoadGameOpen(false), []);
  const closeImageImport = useCallback(() => setImageImportOpen(false), []);
  const finishImageImport = useCallback(() => {
    setImageImportOpen(false);
    setNewGameOpen(false);
    setLoadGameOpen(false);
    setLocalError(null);
    onSessionReady?.();
  }, [onSessionReady, setLocalError]);

  const exportCurrentGame = useCallback(async () => {
    setAction("exporting");
    setError(null);
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
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Could not export this game";
      if (newGameOpen || loadGameOpen) setError(message);
      else setLocalError(message);
    } finally {
      setAction(null);
    }
  }, [gameRef, loadGameOpen, newGameOpen, setLocalError]);

  const importSavedGame = useCallback(
    async (file: File) => {
      if (file.size > MAX_GAME_SAVE_BYTES) {
        setError("The selected save file is too large");
        return;
      }
      setAction("importing");
      setError(null);
      selectionLockedRef.current = true;
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
        onSessionReady?.();
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : "Could not load this game",
        );
      } finally {
        selectionLockedRef.current = false;
        setAction(null);
      }
    },
    [
      commitStartState,
      gameRef,
      onSessionReady,
      selectionLockedRef,
      setLocalError,
    ],
  );

  const startFreshGame = useCallback(async () => {
    cancelActiveSelection();
    selectionLockedRef.current = true;
    setInitializing(true);
    setAction("resetting");
    setError(null);
    try {
      const state = await readJson<GameStartState>(
        await fetch("/api/game/start", { method: "POST" }),
      );
      commitStartState(state);
      setNewGameOpen(false);
      setLoadGameOpen(false);
      setLocalError(null);
      onSessionReady?.();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not start a new game",
      );
    } finally {
      selectionLockedRef.current = false;
      setInitializing(false);
      setAction(null);
    }
  }, [
    cancelActiveSelection,
    commitStartState,
    onSessionReady,
    selectionLockedRef,
    setInitializing,
    setLocalError,
  ]);

  return {
    action,
    error,
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
  };
}
