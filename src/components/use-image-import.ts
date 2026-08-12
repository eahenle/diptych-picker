"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type { GameStartState, GameState } from "@/domain/game";
import type { ImportProgress } from "@/domain/import-progress";
import { readJson } from "./game-api";
import {
  ImportImageFileError,
  inspectImportFile,
  type ImportSource,
} from "./import-image-file";
import {
  createInitialImportEditState,
  type ImportEditState,
} from "./import-image-transform";
import { preloadChangedAssets } from "./image-preload";

const IMPORT_POLL_INTERVAL_MS = 500;

export interface ImportSessionItemStatus {
  id: string;
  status: "annotating" | "ready" | "failed" | "removed" | "served";
  asset: { url: string; width: number; height: number };
  annotation: {
    concept: string;
    prompt: string;
    style: string[];
    reasoningSummary: string;
    source: "automated" | "manual";
  } | null;
  candidateId: string | null;
  failureMessage: string | null;
  approvedAt: string;
}

export interface ImportSessionStatus {
  sessionId: string;
  status: "editing" | "preparing" | "active" | "completed";
  createdAt: string;
  sealedAt: string | null;
  activatedAt: string | null;
  activationTarget: number;
  activationReady: number;
  counts: {
    total: number;
    annotating: number;
    ready: number;
    failed: number;
    removed: number;
    served: number;
  };
  items: ImportSessionItemStatus[];
  initialFill: {
    pending: number;
    ready: number;
    failed: number;
    failedAttemptId: string | null;
    failureMessage: string | null;
  };
}

export interface LocalImportInput {
  id: string;
  file: File;
  source: ImportSource | null;
  validating: boolean;
  error: string | null;
  edit: ImportEditState;
}

export interface ManualImportAnnotation {
  concept: string;
  prompt: string;
  style: string[];
}

interface UseImageImportOptions {
  modalOpen: boolean;
  gameRef: MutableRefObject<GameState | null>;
  selectionLockedRef: MutableRefObject<boolean>;
  commitStartState: (state: GameStartState) => void;
  cancelActiveSelection: () => void;
  onDismiss: () => void;
  onActivated: () => void;
  setImportProgress?: (
    update: (current: ImportProgress | null) => ImportProgress | null,
  ) => void;
}

class ImportRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function readImportJson<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new ImportRequestError(
      data.error ?? "Image import request failed",
      response.status,
    );
  }
  return data;
}

function createClientId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function shouldPoll(status: ImportSessionStatus): boolean {
  if (status.counts.annotating > 0 || status.initialFill.pending > 0) {
    return true;
  }
  if (status.status === "preparing") {
    return status.counts.failed === 0 && status.initialFill.failed === 0;
  }
  return status.status === "active" && status.activatedAt === null;
}

export function useImageImport({
  modalOpen,
  gameRef,
  selectionLockedRef,
  commitStartState,
  cancelActiveSelection,
  onDismiss,
  onActivated,
  setImportProgress,
}: UseImageImportOptions) {
  const [status, setStatus] = useState<ImportSessionStatus | null>(null);
  const [localInputs, setLocalInputs] = useState<LocalImportInput[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSelectedFiles, setHasSelectedFiles] = useState(false);
  const [activationRetry, setActivationRetry] = useState(0);
  const localInputsRef = useRef<LocalImportInput[]>([]);
  const statusRef = useRef<ImportSessionStatus | null>(null);
  const activatedSessionRef = useRef<string | null>(null);
  const activationInFlightRef = useRef(false);
  const retryRequestRef = useRef<{
    failedAttemptId: string;
    requestId: string;
  } | null>(null);

  const replaceInputs = useCallback((next: LocalImportInput[]) => {
    localInputsRef.current = next;
    setLocalInputs(next);
    setCurrentIndex((index) => Math.max(0, Math.min(index, next.length - 1)));
  }, []);

  const applyStatus = useCallback(
    (next: ImportSessionStatus) => {
      statusRef.current = next;
      setStatus(next);
      setImportProgress?.((current) => ({
        status: next.status,
        annotating: next.counts.annotating,
        ready: next.counts.ready,
        failed: next.counts.failed,
        unserved: next.counts.ready,
        activationDisplayServed: current?.activationDisplayServed ?? 0,
        dequeueServed: current?.dequeueServed ?? 0,
        initialFillPending: next.initialFill.pending,
        initialFillFailed: next.initialFill.failed,
        initialFillAttemptId:
          next.initialFill.failedAttemptId ??
          (next.initialFill.pending > 0
            ? (current?.initialFillAttemptId ?? null)
            : null),
        initialFillFailureMessage: next.initialFill.failureMessage,
        activationTarget: 5,
      }));
      return next;
    },
    [setImportProgress],
  );

  const activateReadyGame = useCallback(
    async (nextStatus: ImportSessionStatus) => {
      if (
        !nextStatus.activatedAt ||
        activatedSessionRef.current === nextStatus.sessionId ||
        activationInFlightRef.current
      ) {
        return;
      }
      activationInFlightRef.current = true;
      selectionLockedRef.current = true;
      cancelActiveSelection();
      try {
        const next = await readJson<
          GameStartState & { importProgress?: ImportProgress | null }
        >(await fetch("/api/game", { cache: "no-store" }));
        if (next.status !== "ready") {
          throw new Error("The imported game is still preparing for display");
        }
        const current = gameRef.current;
        const comparisonChanged =
          !current ||
          current.round.leftCandidate.id !== next.game.round.leftCandidate.id ||
          current.round.rightCandidate.id !== next.game.round.rightCandidate.id;
        if (current && comparisonChanged) {
          await preloadChangedAssets(
            current,
            next.game,
            new AbortController().signal,
          );
        }
        activatedSessionRef.current = nextStatus.sessionId;
        setActivationRetry(0);
        if ("importProgress" in next) {
          setImportProgress?.(() => next.importProgress ?? null);
        }
        if (comparisonChanged) commitStartState(next);
        setError(null);
        if (comparisonChanged) onActivated();
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "The imported game could not be displayed",
        );
        setActivationRetry((attempt) => attempt + 1);
      } finally {
        selectionLockedRef.current = false;
        activationInFlightRef.current = false;
      }
    },
    [
      cancelActiveSelection,
      commitStartState,
      gameRef,
      onActivated,
      selectionLockedRef,
      setImportProgress,
    ],
  );

  const applyAndActivate = useCallback(
    async (next: ImportSessionStatus) => {
      applyStatus(next);
      await activateReadyGame(next);
      return next;
    },
    [activateReadyGame, applyStatus],
  );

  const refresh = useCallback(async () => {
    const current = statusRef.current;
    if (!current) return null;
    const next = await readImportJson<ImportSessionStatus>(
      await fetch(
        `/api/game/import?sessionId=${encodeURIComponent(current.sessionId)}`,
        { cache: "no-store" },
      ),
    );
    return applyAndActivate(next);
  }, [applyAndActivate]);

  const begin = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await readImportJson<ImportSessionStatus>(
        await fetch("/api/game/import", { method: "POST" }),
      );
      if (statusRef.current?.sessionId !== next.sessionId) {
        activatedSessionRef.current = null;
        retryRequestRef.current = null;
        setActivationRetry(0);
        setHasSelectedFiles(false);
        replaceInputs([]);
      }
      await applyAndActivate(next);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The image import could not be opened",
      );
    } finally {
      setBusy(false);
    }
  }, [applyAndActivate, replaceInputs]);

  const seal = useCallback(async () => {
    const current = statusRef.current;
    if (!current || localInputsRef.current.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const next = await readImportJson<ImportSessionStatus>(
        await fetch("/api/game/import/seal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: current.sessionId }),
        }),
      );
      await applyAndActivate(next);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The image import could not be sealed",
      );
    } finally {
      setBusy(false);
    }
  }, [applyAndActivate]);

  const selectFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setHasSelectedFiles(true);
      setError(null);
      const additions: LocalImportInput[] = files.map((file) => ({
        id: createClientId("local-image"),
        file,
        source: null,
        validating: true,
        error: null,
        edit: createInitialImportEditState(),
      }));
      const startIndex = localInputsRef.current.length;
      replaceInputs([...localInputsRef.current, ...additions]);
      setCurrentIndex(startIndex);

      await Promise.all(
        additions.map(async (entry) => {
          let source: ImportSource | null = null;
          let inspectionError: string | null = null;
          try {
            source = await inspectImportFile(entry.file);
          } catch (caught) {
            inspectionError =
              caught instanceof ImportImageFileError
                ? caught.message
                : "The selected image could not be inspected.";
          }
          const next = localInputsRef.current.map((candidate) =>
            candidate.id === entry.id
              ? {
                  ...candidate,
                  source,
                  validating: false,
                  error: inspectionError,
                }
              : candidate,
          );
          replaceInputs(next);
        }),
      );
    },
    [replaceInputs],
  );

  const finishLocalInput = useCallback(
    async (id: string) => {
      const removed = localInputsRef.current.find((entry) => entry.id === id);
      removed?.source?.bitmap.close();
      const next = localInputsRef.current.filter((entry) => entry.id !== id);
      replaceInputs(next);
      if (next.length === 0) await seal();
    },
    [replaceInputs, seal],
  );

  const approveCurrent = useCallback(
    async (normalizedPng: Blob) => {
      const currentStatus = statusRef.current;
      const input = localInputsRef.current[currentIndex];
      if (!currentStatus || !input || !input.source) return;
      setBusy(true);
      setError(null);
      try {
        const form = new FormData();
        form.append("sessionId", currentStatus.sessionId);
        form.append("image", normalizedPng, "normalized.png");
        const next = await readImportJson<ImportSessionStatus>(
          await fetch("/api/game/import/items", {
            method: "POST",
            body: form,
          }),
        );
        applyStatus(next);
        await finishLocalInput(input.id);
      } catch (caught) {
        const message =
          caught instanceof Error
            ? caught.message
            : "This normalized image could not be uploaded";
        replaceInputs(
          localInputsRef.current.map((entry) =>
            entry.id === input.id ? { ...entry, error: message } : entry,
          ),
        );
      } finally {
        setBusy(false);
      }
    },
    [applyStatus, currentIndex, finishLocalInput, replaceInputs],
  );

  const removeCurrent = useCallback(async () => {
    const input = localInputsRef.current[currentIndex];
    if (input) await finishLocalInput(input.id);
  }, [currentIndex, finishLocalInput]);

  const updateCurrentEdit = useCallback(
    (edit: ImportEditState) => {
      const input = localInputsRef.current[currentIndex];
      if (!input) return;
      replaceInputs(
        localInputsRef.current.map((entry) =>
          entry.id === input.id ? { ...entry, edit } : entry,
        ),
      );
    },
    [currentIndex, replaceInputs],
  );

  const mutateItem = useCallback(
    async (
      itemId: string,
      action:
        | { action: "retry" }
        | ({ action: "manual" } & ManualImportAnnotation)
        | { action: "remove" },
    ) => {
      const current = statusRef.current;
      if (!current) return;
      setBusy(true);
      setError(null);
      try {
        const next = await readImportJson<ImportSessionStatus>(
          await fetch(`/api/game/import/items/${encodeURIComponent(itemId)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...action, sessionId: current.sessionId }),
          }),
        );
        await applyAndActivate(next);
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "The imported image could not be updated",
        );
      } finally {
        setBusy(false);
      }
    },
    [applyAndActivate],
  );

  const retryInitialFill = useCallback(async () => {
    const current = statusRef.current;
    const failedAttemptId = current?.initialFill.failedAttemptId;
    if (!current || !failedAttemptId) return;
    const retry =
      retryRequestRef.current?.failedAttemptId === failedAttemptId
        ? retryRequestRef.current
        : {
            failedAttemptId,
            requestId: createClientId("initial-fill-retry"),
          };
    retryRequestRef.current = retry;
    setBusy(true);
    setError(null);
    try {
      const next = await readImportJson<ImportSessionStatus>(
        await fetch("/api/game/import", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "retry-initial-fill",
            sessionId: current.sessionId,
            failedAttemptId: retry.failedAttemptId,
            requestId: retry.requestId,
          }),
        }),
      );
      retryRequestRef.current = null;
      await applyAndActivate(next);
    } catch (caught) {
      if (caught instanceof ImportRequestError && caught.status === 409) {
        try {
          const refreshed = await refresh();
          if (
            refreshed?.initialFill.failedAttemptId !== retry.failedAttemptId
          ) {
            retryRequestRef.current = null;
          }
        } catch {
          // Preserve the stale-attempt message when the supporting refresh fails.
        }
      }
      setError(
        caught instanceof Error
          ? caught.message
          : "The initial fill could not be retried",
      );
    } finally {
      setBusy(false);
    }
  }, [applyAndActivate, refresh]);

  const pause = useCallback(async () => {
    const current = statusRef.current;
    if (!current || current.status === "editing") return;
    setBusy(true);
    setError(null);
    try {
      const next = await readImportJson<ImportSessionStatus>(
        await fetch("/api/game/import", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "pause",
            sessionId: current.sessionId,
          }),
        }),
      );
      applyStatus(next);
      onDismiss();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The import could not pause",
      );
    } finally {
      setBusy(false);
    }
  }, [applyStatus, onDismiss]);

  const abandon = useCallback(async () => {
    const current = statusRef.current;
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/game/import", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: current.sessionId }),
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new ImportRequestError(
          data.error ?? "The import could not be abandoned",
          response.status,
        );
      }
      for (const input of localInputsRef.current) input.source?.bitmap.close();
      replaceInputs([]);
      statusRef.current = null;
      setStatus(null);
      setImportProgress?.(() => null);
      setHasSelectedFiles(false);
      retryRequestRef.current = null;
      onDismiss();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The import could not be abandoned",
      );
    } finally {
      setBusy(false);
    }
  }, [onDismiss, replaceInputs, setImportProgress]);

  useEffect(() => {
    if (!modalOpen || localInputs.length === 0) return;
    const protectBrowserInputs = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectBrowserInputs);
    return () =>
      window.removeEventListener("beforeunload", protectBrowserInputs);
  }, [localInputs.length, modalOpen]);

  useEffect(() => {
    if (!status || !shouldPoll(status)) return;
    const timer = window.setTimeout(() => {
      void refresh().catch((caught: unknown) => {
        setError(
          caught instanceof Error
            ? caught.message
            : "Image import status could not be refreshed",
        );
      });
    }, IMPORT_POLL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [refresh, status]);

  useEffect(() => {
    if (
      !status?.activatedAt ||
      activatedSessionRef.current === status.sessionId ||
      activationRetry === 0
    ) {
      return;
    }
    const timer = window.setTimeout(
      () => void activateReadyGame(status),
      IMPORT_POLL_INTERVAL_MS,
    );
    return () => window.clearTimeout(timer);
  }, [activateReadyGame, activationRetry, status]);

  const currentInput: LocalImportInput | null =
    localInputs.length > 0 ? localInputs[currentIndex]! : null;
  const unresolved = localInputs.length > 0;
  const canPause = Boolean(
    status && status.status !== "editing" && !unresolved,
  );
  const canAbandon = Boolean(
    status && status.status !== "active" && status.status !== "completed",
  );

  return {
    abandon,
    approveCurrent,
    begin,
    busy,
    canAbandon,
    canPause,
    currentIndex,
    currentInput,
    dismiss: onDismiss,
    error,
    hasSelectedFiles,
    localInputs,
    manualItem: (itemId: string, input: ManualImportAnnotation) =>
      mutateItem(itemId, { action: "manual", ...input }),
    next: () =>
      setCurrentIndex((index) => Math.min(index + 1, localInputs.length - 1)),
    pause,
    previous: () => setCurrentIndex((index) => Math.max(0, index - 1)),
    refresh,
    removeCurrent,
    removeItem: (itemId: string) => mutateItem(itemId, { action: "remove" }),
    retryInitialFill,
    retryItem: (itemId: string) => mutateItem(itemId, { action: "retry" }),
    seal,
    selectFiles,
    status,
    unresolved,
    updateCurrentEdit,
  };
}
