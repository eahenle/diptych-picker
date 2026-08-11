"use client";

import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { ImportImageEditor } from "./import-image-editor";
import { ModalShell } from "./modal-shell";
import type { useImageImport } from "./use-image-import";
import modalStyles from "./game-modal.module.css";
import styles from "./image-import-modal.module.css";

type ImageImportController = ReturnType<typeof useImageImport>;

interface ImageImportModalProps {
  controller: ImageImportController;
}

export function ImageImportModal({ controller }: ImageImportModalProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [confirmingAbandon, setConfirmingAbandon] = useState(false);
  const status = controller.status;
  const close = () => {
    if (controller.unresolved || controller.busy) return;
    if (controller.canPause) {
      void controller.pause();
    } else if (!status) {
      controller.dismiss();
    }
  };

  const chooseFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    input.value = "";
    void controller.selectFiles(files);
  };

  return (
    <ModalShell
      className={`${modalStyles.dialog} ${modalStyles.wider} ${styles.dialog}`}
      onClose={close}
      ariaLabelledBy="image-import-title"
      ariaDescribedBy="image-import-description"
      ariaBusy={controller.busy}
    >
      <h2 id="image-import-title">Import images for a new game</h2>
      <p id="image-import-description">
        Review every image separately. Only the square PNG shown in the editor
        is uploaded; the original file stays in this browser.
      </p>

      {controller.error ? (
        <p className={modalStyles.alert} role="alert">
          {controller.error}
        </p>
      ) : null}

      {!status && controller.busy ? (
        <div className={modalStyles.state}>Opening image import…</div>
      ) : null}

      {status ? (
        <div className={styles.layout}>
          <section className={styles.workspace}>
            {status.status === "editing" ? (
              <div className={styles.filePicker}>
                <div>
                  <strong>Choose source images</strong>
                  <span>
                    Still PNG, JPEG, or WebP files up to 4096 pixels per side.
                  </span>
                </div>
                <button
                  type="button"
                  className={modalStyles.actionButton}
                  disabled={controller.busy}
                  onClick={() => inputRef.current?.click()}
                >
                  Choose images
                </button>
                <input
                  ref={inputRef}
                  className={styles.fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
                  aria-label="Choose images for a new game"
                  multiple
                  disabled={controller.busy}
                  onChange={chooseFiles}
                />
              </div>
            ) : null}

            {controller.currentInput ? (
              controller.currentInput.validating ? (
                <div className={modalStyles.state}>
                  Inspecting {controller.currentInput.file.name}…
                </div>
              ) : controller.currentInput.source ? (
                <>
                  {controller.currentInput.error ? (
                    <p className={modalStyles.alert} role="alert">
                      {controller.currentInput.error}
                    </p>
                  ) : null}
                  <ImportImageEditor
                    key={controller.currentInput.id}
                    source={controller.currentInput.source}
                    position={controller.currentIndex + 1}
                    total={controller.localInputs.length}
                    busy={controller.busy}
                    onApprove={controller.approveCurrent}
                    onRemove={() => void controller.removeCurrent()}
                    onPrevious={controller.previous}
                    onNext={controller.next}
                  />
                </>
              ) : (
                <div className={styles.invalidFile}>
                  <strong>{controller.currentInput.file.name}</strong>
                  <p role="alert">
                    {controller.currentInput.error ??
                      "This image could not be inspected."}
                  </p>
                  <div>
                    <button
                      type="button"
                      className={modalStyles.actionButton}
                      disabled={controller.busy || controller.currentIndex <= 0}
                      onClick={controller.previous}
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      className={modalStyles.actionButton}
                      disabled={
                        controller.busy ||
                        controller.currentIndex >=
                          controller.localInputs.length - 1
                      }
                      onClick={controller.next}
                    >
                      Next
                    </button>
                    <button
                      type="button"
                      className={modalStyles.actionButton}
                      disabled={controller.busy}
                      onClick={() => void controller.removeCurrent()}
                    >
                      Remove image
                    </button>
                  </div>
                </div>
              )
            ) : status.status === "editing" ? (
              <div className={styles.browserOnlyNote}>
                <p>
                  Unapproved files exist only in this browser. If this import
                  was reopened after a refresh, select those files again.
                </p>
                {controller.hasSelectedFiles || status.counts.total > 0 ? (
                  <button
                    type="button"
                    className={`${modalStyles.actionButton} ${styles.primaryAction}`}
                    disabled={controller.busy}
                    onClick={() => void controller.seal()}
                  >
                    Finish image selection
                  </button>
                ) : null}
              </div>
            ) : (
              <ImportServerProgress controller={controller} />
            )}

            {status.items.some((item) => item.status === "failed") ? (
              <section
                className={styles.failures}
                aria-label="Failed imported images"
              >
                <h3>Images needing attention</h3>
                {status.items
                  .filter((item) => item.status === "failed")
                  .map((item) => (
                    <FailedImportItem
                      key={item.id}
                      item={item}
                      busy={controller.busy}
                      onRetry={() => void controller.retryItem(item.id)}
                      onManual={(input) =>
                        controller.manualItem(item.id, input)
                      }
                      onRemove={() => void controller.removeItem(item.id)}
                    />
                  ))}
              </section>
            ) : null}

            {status.initialFill.failed > 0 ? (
              <div className={styles.initialFillFailure} role="status">
                <p>
                  {status.initialFill.failureMessage ??
                    "Starter candidate generation did not finish."}
                </p>
                <button
                  type="button"
                  className={modalStyles.actionButton}
                  disabled={controller.busy}
                  onClick={() => void controller.retryInitialFill()}
                >
                  Retry initial fill
                </button>
              </div>
            ) : null}
          </section>

          <aside className={styles.summary} aria-label="Image import progress">
            <h3>Progress</h3>
            <StatusCount
              label="Editing"
              value={controller.localInputs.length}
            />
            <StatusCount label="Annotating" value={status.counts.annotating} />
            <StatusCount label="Ready" value={status.counts.ready} />
            <StatusCount label="Failed" value={status.counts.failed} />
            <StatusCount label="Removed" value={status.counts.removed} />
            <div className={styles.activationProgress}>
              <span>Starter pool</span>
              <strong>
                {status.activationReady}/{status.activationTarget}
              </strong>
            </div>
          </aside>
        </div>
      ) : null}

      <div className={`${modalStyles.actions} ${styles.footerActions}`}>
        {controller.canAbandon ? (
          confirmingAbandon ? (
            <div className={styles.abandonConfirmation} role="alert">
              <span>Discard this import and all server-owned progress?</span>
              <button
                type="button"
                className={modalStyles.actionButton}
                disabled={controller.busy}
                onClick={() => void controller.abandon()}
              >
                Confirm abandon
              </button>
              <button
                type="button"
                className={modalStyles.actionButton}
                disabled={controller.busy}
                onClick={() => setConfirmingAbandon(false)}
              >
                Keep import
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={modalStyles.actionButton}
              disabled={controller.busy}
              onClick={() => setConfirmingAbandon(true)}
            >
              Abandon import
            </button>
          )
        ) : null}
        {controller.canPause ? (
          <button
            type="button"
            className={modalStyles.actionButton}
            disabled={controller.busy}
            onClick={() => void controller.pause()}
          >
            Close / Pause
          </button>
        ) : null}
        {!status && !controller.busy && !controller.unresolved ? (
          <button
            type="button"
            className={modalStyles.actionButton}
            onClick={controller.dismiss}
          >
            Close
          </button>
        ) : null}
      </div>
    </ModalShell>
  );
}

function ImportServerProgress({
  controller,
}: {
  controller: ImageImportController;
}) {
  const status = controller.status;
  if (!status) return null;
  if (status.activatedAt) {
    return (
      <div className={modalStyles.state} role="status">
        Loading the imported game…
      </div>
    );
  }
  if (status.counts.annotating > 0) {
    return (
      <div className={modalStyles.state} role="status">
        Describing {status.counts.annotating} approved image
        {status.counts.annotating === 1 ? "" : "s"}…
      </div>
    );
  }
  if (status.initialFill.pending > 0) {
    return (
      <div className={modalStyles.state} role="status">
        Creating {status.initialFill.pending} starter challenger
        {status.initialFill.pending === 1 ? "" : "s"}…
      </div>
    );
  }
  return (
    <div className={modalStyles.state} role="status">
      Preparing the imported game…
    </div>
  );
}

function StatusCount({ label, value }: { label: string; value: number }) {
  return (
    <div className={styles.statusCount}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function FailedImportItem({
  item,
  busy,
  onRetry,
  onManual,
  onRemove,
}: {
  item: NonNullable<ImageImportController["status"]>["items"][number];
  busy: boolean;
  onRetry: () => void;
  onManual: (input: {
    concept: string;
    prompt: string;
    style: string[];
  }) => Promise<void>;
  onRemove: () => void;
}) {
  const [manualOpen, setManualOpen] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);

  const submitManual = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const concept = String(form.get("concept") ?? "").trim();
    const prompt = String(form.get("prompt") ?? "").trim();
    const style = Array.from(
      new Set(
        String(form.get("style") ?? "")
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    );
    if (!concept || !prompt || style.length < 1 || style.length > 8) {
      setManualError(
        "Add a concept, description, and one through eight comma-separated style tags.",
      );
      return;
    }
    setManualError(null);
    void onManual({ concept, prompt, style });
  };

  return (
    <article className={styles.failedItem}>
      {/* The status API exposes only the normalized asset and display-safe failure. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={item.asset.url} alt="Imported image needing attention" />
      <div>
        <p>{item.failureMessage ?? "Automatic annotation failed."}</p>
        <div className={styles.failureActions}>
          <button type="button" disabled={busy} onClick={onRetry}>
            Retry
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setManualOpen((open) => !open)}
          >
            Annotate manually
          </button>
          <button type="button" disabled={busy} onClick={onRemove}>
            Remove
          </button>
        </div>
        {manualOpen ? (
          <form className={styles.manualForm} onSubmit={submitManual}>
            <label>
              Concept
              <input name="concept" maxLength={120} disabled={busy} required />
            </label>
            <label>
              Description
              <textarea
                name="prompt"
                maxLength={500}
                disabled={busy}
                required
              />
            </label>
            <label>
              Style tags
              <input
                name="style"
                placeholder="editorial, warm light, geometric"
                disabled={busy}
                required
              />
            </label>
            {manualError ? <p role="alert">{manualError}</p> : null}
            <button type="submit" disabled={busy}>
              Save annotation
            </button>
          </form>
        ) : null}
      </div>
    </article>
  );
}
