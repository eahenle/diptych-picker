"use client";

import type { BufferHealth } from "@/domain/game";
import { ModalShell } from "./modal-shell";
import modalStyles from "./game-modal.module.css";
import styles from "./queue-details.module.css";

interface QueueDetailsProps {
  health: BufferHealth;
  onClose: () => void;
}

export function QueueDetails({ health, onClose }: QueueDetailsProps) {
  return (
    <ModalShell
      className={modalStyles.dialog}
      onClose={onClose}
      ariaLabelledBy="queue-details-title"
      ariaDescribedBy="queue-details-description"
    >
      <>
        <button
          type="button"
          className={modalStyles.closeButton}
          aria-label="Close queue details"
          onClick={onClose}
        >
          ×
        </button>
        <h2 id="queue-details-title">Generation queue</h2>
        <p id="queue-details-description">
          The compact +{health.inFlight} count includes both jobs currently
          generating and jobs waiting for a worker. It is queue capacity, not a
          worker count.
        </p>
        <dl className={styles.breakdown}>
          <div>
            <dt>Ready to compare</dt>
            <dd>{health.ready}</dd>
          </div>
          <div>
            <dt>Generating now</dt>
            <dd>{health.active}</dd>
          </div>
          <div>
            <dt>Waiting for a worker</dt>
            <dd>{health.pending}</dd>
          </div>
          <div>
            <dt>Queue target</dt>
            <dd>{health.target}</dd>
          </div>
        </dl>
        {health.draining > 0 ? (
          <p className={styles.draining} role="status">
            {health.draining} old-profile job
            {health.draining === 1 ? " is" : "s are"} finishing without entering
            the ready queue. Its replacement is counted within the same target
            once capacity opens.
          </p>
        ) : null}
        <p className={styles.note}>
          Ready images and in-flight jobs share the configured target of{" "}
          {health.target}. The runner may process only part of the waiting work
          at once.
        </p>
        <div className={modalStyles.actions}>
          <button
            type="button"
            className={modalStyles.actionButton}
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </>
    </ModalShell>
  );
}
