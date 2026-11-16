"use client";

import { useState } from "react";
import { candidateAt, type Round, type Side } from "@/domain/game";
import {
  parseIterationCommand,
  type IterationSelection,
} from "@/domain/image-iteration";
import type { InspectableCandidate } from "./image-inspector";
import { ModalShell } from "./modal-shell";
import styles from "./iteration-dialog.module.css";

interface IterationDialogProps {
  source: InspectableCandidate;
  round: Round;
  onClose: () => void;
  onEditPreferences: () => void;
  onSubmit: (
    winnerSide: Side,
    roundNumber: number,
    iteration: IterationSelection,
  ) => void;
}

export function IterationDialog({
  source,
  round,
  onClose,
  onEditPreferences,
  onSubmit,
}: IterationDialogProps) {
  const [command, setCommand] = useState("iterate");
  const [winnerSide, setWinnerSide] = useState<Side | "">(() => {
    if (source.id === round.leftCandidate.id) return "left";
    if (source.id === round.rightCandidate.id) return "right";
    if (round.retainedCandidateId === round.leftCandidate.id) return "left";
    if (round.retainedCandidateId === round.rightCandidate.id) return "right";
    return "";
  });
  const [error, setError] = useState<string | null>(null);
  let temperature = 0.5;
  try {
    temperature = parseIterationCommand(command).temperature;
  } catch {
    // The command may be incomplete while the user is typing.
  }

  return (
    <ModalShell
      className={styles.dialog}
      ariaLabelledBy="iteration-heading"
      onClose={onClose}
    >
      <h2 id="iteration-heading">Explore variations</h2>
      <p>
        Source image <strong>{source.concept}</strong>
      </p>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (!winnerSide) return;
          try {
            parseIterationCommand(command);
          } catch (cause) {
            setError((cause as Error).message);
            return;
          }
          onSubmit(winnerSide, round.roundNumber, {
            command: command.trim(),
            sourceCandidateId: source.id,
            winnerCandidateId: candidateAt(round, winnerSide).id,
          });
        }}
      >
        <label>
          Image to keep
          <select
            required
            value={winnerSide}
            onChange={(event) =>
              setWinnerSide(event.currentTarget.value as Side | "")
            }
          >
            <option value="" disabled>
              Choose an image
            </option>
            <option value="left">A · {round.leftCandidate.concept}</option>
            <option value="right">B · {round.rightCandidate.concept}</option>
          </select>
        </label>
        <label>
          Iteration temperature <output>{temperature}</output>
          <input
            type="range"
            min="0"
            max="1"
            step="any"
            value={temperature}
            onChange={(event) => {
              const clauses = command.indexOf(",");
              setCommand(
                `iterate ${event.currentTarget.value}${clauses < 0 ? "" : command.slice(clauses)}`,
              );
              setError(null);
            }}
          />
        </label>
        <p className={styles.help}>
          Higher values allow bigger changes in composition, setting, and visual
          direction.
        </p>
        <label>
          Iteration command
          <input
            type="text"
            maxLength={4000}
            value={command}
            placeholder="iterate hot, preserve [red scarf]"
            onChange={(event) => {
              setCommand(event.currentTarget.value);
              setError(null);
            }}
          />
        </label>
        <p className={styles.help}>
          Add <code>, preserve [detail]</code> for each detail that must appear
          in the challenger.
        </p>
        {error ? <p role="alert">{error}</p> : null}
        <div className={styles.actions}>
          <button type="submit" disabled={!winnerSide}>
            Keep this image and generate a variation
          </button>
          <button type="button" onClick={onEditPreferences}>
            Edit variation preferences
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
