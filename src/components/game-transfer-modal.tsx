"use client";

import { useRef, type ChangeEvent } from "react";
import { ModalShell } from "./modal-shell";
import modalStyles from "./game-modal.module.css";
import styles from "./game-transfer-modal.module.css";

export type GameTransferAction = "exporting" | "importing" | "resetting";

interface GameTransferModalProps {
  mode: "load" | "new";
  action: GameTransferAction | null;
  error: string | null;
  onClose: () => void;
  onExport: () => void;
  onImport: (file: File) => Promise<void>;
  onStartFresh: () => void;
}

export function GameTransferModal({
  mode,
  action,
  error,
  onClose,
  onExport,
  onImport,
  onStartFresh,
}: GameTransferModalProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const busy = action !== null;
  const loadMode = mode === "load";
  const titleId = loadMode ? "load-game-title" : "new-game-title";
  const descriptionId = loadMode
    ? "load-game-description"
    : "new-game-description";
  const saveNoteId = loadMode ? "load-game-save-note" : "game-save-note";

  const close = () => {
    if (!busy) onClose();
  };

  const importSelectedFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    try {
      await onImport(file);
    } finally {
      input.value = "";
    }
  };

  return (
    <ModalShell
      className={`${modalStyles.dialog} ${styles.dialog}`}
      onClose={close}
      ariaLabelledBy={titleId}
      ariaDescribedBy={`${descriptionId} ${saveNoteId}`}
      ariaBusy={busy}
    >
      <>
        <h2 id={titleId}>{loadMode ? "Load saved game" : "New game"}</h2>
        <p id={descriptionId}>
          {loadMode
            ? "Loading replaces the current round and learned state after the save and its local images pass validation."
            : "Save this exact game before starting over, or restore a game you saved earlier."}
        </p>
        <div className={styles.options}>
          <div className={styles.option}>
            <span>
              <strong>
                {loadMode ? "Keep this game first" : "Keep this game"}
              </strong>
              <small>
                {loadMode
                  ? "Download the current round, history, preferences, queue, ratings, and pool membership before loading another save."
                  : "Export the round, history, preferences, queue, ratings, and pool membership."}
              </small>
            </span>
            <button
              type="button"
              className={modalStyles.actionButton}
              disabled={busy}
              onClick={onExport}
            >
              {action === "exporting"
                ? "Exporting…"
                : loadMode
                  ? "Export current game first"
                  : "Export current game"}
            </button>
          </div>
          <div className={styles.option}>
            <span>
              <strong>
                {loadMode ? "Choose a saved game" : "Return to a saved game"}
              </strong>
              <small>
                {loadMode
                  ? "The current game stays unchanged if the save cannot be restored safely."
                  : "Loading a save replaces the current round and learned state after validation."}
              </small>
            </span>
            <button
              type="button"
              className={modalStyles.actionButton}
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              {action === "importing"
                ? "Loading…"
                : loadMode
                  ? "Choose saved game"
                  : "Load saved game"}
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
        </div>
        <p id={saveNoteId} className={styles.saveNote}>
          Save files use this installation&apos;s immutable image library;
          missing local images are rejected without changing the current game.
        </p>
        {error ? (
          <p className={modalStyles.alert} role="alert">
            {error}
          </p>
        ) : null}
        {!loadMode ? (
          <div className={`${styles.option} ${styles.freshSection}`}>
            <span>
              <strong>Start fresh</strong>
              <small>
                Clears the current round, history, and preference profile.
                Learned pool ratings and image files stay available.
              </small>
            </span>
            <button
              type="button"
              className={`${modalStyles.actionButton} ${styles.primaryAction}`}
              disabled={busy}
              onClick={onStartFresh}
            >
              {action === "resetting" ? "Starting…" : "Start new game"}
            </button>
          </div>
        ) : null}
        <div className={modalStyles.actions}>
          <button
            type="button"
            className={modalStyles.actionButton}
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </>
    </ModalShell>
  );
}
