"use client";

import { useRef, type ChangeEvent } from "react";
import type { GameTransferAction } from "./game-transfer-modal";
import { ModalShell } from "./modal-shell";
import modalStyles from "./game-modal.module.css";
import styles from "./game-startup-modal.module.css";

export interface GameStartupStatus {
  canResume: boolean;
  importInProgress: boolean;
}

interface GameStartupModalProps {
  status: GameStartupStatus | null;
  statusError: string | null;
  action: GameTransferAction | null;
  actionError: string | null;
  onRetryStatus: () => void;
  onResume: () => void;
  onLoad: (file: File) => Promise<void>;
  onInitialize: () => void;
  onImport: () => void;
}

export function GameStartupModal({
  status,
  statusError,
  action,
  actionError,
  onRetryStatus,
  onResume,
  onLoad,
  onInitialize,
  onImport,
}: GameStartupModalProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const busy = action !== null;
  const canResume = status?.canResume ?? false;
  const checking = status === null && statusError === null;

  const importSelectedFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    try {
      await onLoad(file);
    } finally {
      input.value = "";
    }
  };

  return (
    <ModalShell
      className={`${modalStyles.dialog} ${styles.dialog}`}
      onClose={() => undefined}
      ariaLabelledBy="game-startup-title"
      ariaDescribedBy="game-startup-description"
      ariaBusy={busy || checking}
      initialFocusSelector={
        canResume
          ? '[data-startup-action="resume"]'
          : '[data-startup-action="initialize"]'
      }
    >
      <h2 id="game-startup-title">Open Diptych Picker</h2>
      <p id="game-startup-description">
        Choose how to enter the game. Nothing is replaced until your choice
        succeeds.
      </p>
      <div className={styles.options}>
        <div className={styles.option}>
          <span>
            <strong>Resume</strong>
            <small>
              {checking
                ? "Checking for a game already in progress…"
                : canResume
                  ? "Continue the current game or finish its initial comparison."
                  : "There is no current game to resume."}
            </small>
          </span>
          <button
            type="button"
            className={`${modalStyles.actionButton} ${styles.primaryAction}`}
            data-startup-action="resume"
            disabled={busy || checking || !canResume}
            onClick={onResume}
          >
            Resume
          </button>
        </div>
        <div className={styles.option}>
          <span>
            <strong>Load</strong>
            <small>
              Restore a saved game after its state and local images pass
              validation.
            </small>
          </span>
          <button
            type="button"
            className={modalStyles.actionButton}
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {action === "importing" ? "Loading…" : "Load"}
          </button>
          <input
            ref={inputRef}
            className={styles.fileInput}
            type="file"
            accept="application/json,.json"
            aria-label="Choose saved game file"
            disabled={busy}
            onChange={(event) => void importSelectedFile(event)}
          />
        </div>
        <div className={styles.option}>
          <span>
            <strong>Initialize</strong>
            <small>
              Start a clean game with the default preference seed and a fresh
              comparison.
            </small>
          </span>
          <button
            type="button"
            className={modalStyles.actionButton}
            data-startup-action="initialize"
            disabled={busy}
            onClick={onInitialize}
          >
            {action === "resetting" ? "Initializing…" : "Initialize"}
          </button>
        </div>
        <div className={styles.option}>
          <span>
            <strong>Import</strong>
            <small>
              {status?.importInProgress
                ? "Continue the image-pool import already in progress."
                : "Build a new challenger pool from image seeds, including awkward crops or dimensions."}
            </small>
          </span>
          <button
            type="button"
            className={modalStyles.actionButton}
            disabled={busy}
            onClick={onImport}
          >
            Import
          </button>
        </div>
      </div>
      {statusError ? (
        <div className={styles.statusError} role="alert">
          <span>{statusError}</span>
          <button
            type="button"
            className={modalStyles.actionButton}
            disabled={busy}
            onClick={onRetryStatus}
          >
            Check again
          </button>
        </div>
      ) : null}
      {actionError ? (
        <p className={modalStyles.alert} role="alert">
          {actionError}
        </p>
      ) : null}
    </ModalShell>
  );
}
