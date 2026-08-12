"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ImportSource } from "./import-image-file";
import {
  renderNormalizedImport,
  transformForEdit,
  type ImportEditState,
} from "./import-image-transform";
import styles from "./import-image-editor.module.css";

interface ImportImageEditorProps {
  source: ImportSource;
  position: number;
  total: number;
  busy?: boolean;
  edit: ImportEditState;
  onEditChange: (edit: ImportEditState) => void;
  onApprove: (normalizedPng: Blob) => Promise<void> | void;
  onRemove: () => void;
  onPrevious: () => void;
  onNext: () => void;
}

export function ImportImageEditor({
  source,
  position,
  total,
  busy = false,
  edit,
  onEditChange,
  onApprove,
  onRemove,
  onPrevious,
  onNext,
}: ImportImageEditorProps) {
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const pending = busy || rendering;
  const fitMode = edit.mode === "fit";
  const sourceLabel = useMemo(
    () => `${source.file.name}, image ${position} of ${total}`,
    [position, source.file.name, total],
  );

  useEffect(() => {
    const canvas = previewRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const transform = transformForEdit(
      { width: source.width, height: source.height },
      edit,
      { width: canvas.width, height: canvas.height },
    );
    context.save();
    context.fillStyle = fitMode ? edit.background : "#000000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.translate(
      canvas.width / 2 + transform.panX,
      canvas.height / 2 + transform.panY,
    );
    context.rotate(transform.rotationRadians);
    context.scale(transform.scale, transform.scale);
    context.drawImage(source.bitmap, -source.width / 2, -source.height / 2);
    context.restore();
  }, [edit, fitMode, source]);

  const update = <K extends keyof ImportEditState>(
    key: K,
    value: ImportEditState[K],
  ) => onEditChange({ ...edit, [key]: value });

  const setMode = (mode: ImportEditState["mode"]) => {
    onEditChange({
      ...edit,
      mode,
      ...(mode === "fit" ? { zoom: 1, panX: 0, panY: 0 } : {}),
    });
  };

  const approve = async () => {
    setRendering(true);
    setError(null);
    try {
      const normalized = await renderNormalizedImport(source.bitmap, edit);
      await onApprove(normalized);
    } catch {
      setError("This image could not be normalized. Try another edit.");
    } finally {
      setRendering(false);
    }
  };

  return (
    <section className={styles.editor} aria-label={`Edit ${sourceLabel}`}>
      <div className={styles.previewFrame}>
        <canvas
          ref={previewRef}
          className={styles.preview}
          width={512}
          height={512}
          aria-label="Square normalized image preview"
          role="img"
        />
      </div>
      <div className={styles.controls}>
        <p className={styles.position}>{sourceLabel}</p>
        <fieldset disabled={pending}>
          <legend>Framing</legend>
          <label>
            <input
              type="radio"
              name="import-framing"
              value="crop"
              checked={!fitMode}
              onChange={() => setMode("crop")}
            />
            Crop to fill
          </label>
          <label>
            <input
              type="radio"
              name="import-framing"
              value="fit"
              checked={fitMode}
              onChange={() => setMode("fit")}
            />
            Fit full image
          </label>
        </fieldset>
        <label>
          Rotation: {edit.rotation}°
          <input
            type="range"
            min="-180"
            max="180"
            step="1"
            value={edit.rotation}
            disabled={pending}
            onChange={(event) =>
              update("rotation", Number(event.currentTarget.value))
            }
          />
        </label>
        <label>
          Zoom: {edit.zoom.toFixed(2)}×
          <input
            type="range"
            min="1"
            max="4"
            step="0.01"
            value={edit.zoom}
            disabled={pending || fitMode}
            onChange={(event) =>
              update("zoom", Number(event.currentTarget.value))
            }
          />
        </label>
        <div className={styles.panControls}>
          <label>
            Horizontal position
            <input
              type="range"
              min="-512"
              max="512"
              value={edit.panX}
              disabled={pending || fitMode}
              onChange={(event) =>
                update("panX", Number(event.currentTarget.value))
              }
            />
          </label>
          <label>
            Vertical position
            <input
              type="range"
              min="-512"
              max="512"
              value={edit.panY}
              disabled={pending || fitMode}
              onChange={(event) =>
                update("panY", Number(event.currentTarget.value))
              }
            />
          </label>
        </div>
        {fitMode ? (
          <>
            <label>
              Fit background
              <input
                type="color"
                value={edit.background}
                disabled={pending}
                onChange={(event) =>
                  update("background", event.currentTarget.value)
                }
              />
            </label>
            <p className={styles.help}>
              Fit keeps every rotated source pixel visible; pan and zoom are
              locked.
            </p>
          </>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        <div className={styles.actions}>
          <button
            type="button"
            disabled={pending || position <= 1}
            onClick={onPrevious}
          >
            Previous
          </button>
          <button
            type="button"
            disabled={pending || position >= total}
            onClick={onNext}
          >
            Next
          </button>
          <button type="button" disabled={pending} onClick={onRemove}>
            Remove image
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => void approve()}
          >
            {pending ? "Approving…" : "Approve image"}
          </button>
        </div>
      </div>
    </section>
  );
}
