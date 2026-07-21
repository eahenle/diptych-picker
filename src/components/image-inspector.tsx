"use client";

/* eslint-disable @next/next/no-img-element -- Inspector displays immutable local candidate assets. */

import { useEffect } from "react";
import type { Candidate } from "@/domain/game";
import { ModalShell } from "./modal-shell";
import styles from "./image-inspector.module.css";

export type InspectableCandidate = Pick<
  Candidate,
  "id" | "imageUrl" | "concept" | "lineage"
>;

export interface ImageInspectorState {
  candidates: InspectableCandidate[];
  index: number;
  returnTarget: "leaderboard" | null;
}

interface ImageInspectorProps {
  state: ImageInspectorState;
  onClose: () => void;
  onNavigate: (direction: -1 | 1) => void;
  onExplore: (candidate: InspectableCandidate) => void;
}

export function ImageInspector({
  state,
  onClose,
  onNavigate,
  onExplore,
}: ImageInspectorProps) {
  const candidate = state.candidates[state.index];

  useEffect(() => {
    const navigate = (event: KeyboardEvent) => {
      const direction =
        event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (direction === 0 || state.candidates.length < 2) return;
      event.preventDefault();
      onNavigate(direction);
    };
    window.addEventListener("keydown", navigate);
    return () => window.removeEventListener("keydown", navigate);
  }, [onNavigate, state.candidates.length]);

  if (!candidate) return null;

  return (
    <ModalShell
      className={styles.dialog}
      ariaLabel={`Expanded image: ${candidate.concept}`}
      onClose={onClose}
    >
      <>
        <button
          type="button"
          className={styles.closeButton}
          aria-label="Close expanded image"
          onClick={onClose}
        >
          ×
        </button>
        {state.candidates.length > 1 ? (
          <>
            <button
              type="button"
              className={`${styles.navigation} ${styles.previous}`}
              aria-label="Previous expanded image"
              onClick={() => onNavigate(-1)}
            >
              ‹
            </button>
            <button
              type="button"
              className={`${styles.navigation} ${styles.next}`}
              aria-label="Next expanded image"
              onClick={() => onNavigate(1)}
            >
              ›
            </button>
          </>
        ) : null}
        <figure>
          <img src={candidate.imageUrl} alt={candidate.concept} />
          <figcaption>
            {candidate.concept}
            {state.candidates.length > 1 ? (
              <small>
                {state.index + 1} of {state.candidates.length}
                {" · Use Left and Right arrow keys"}
              </small>
            ) : null}
            {candidate.lineage ? (
              <small>Variation of {candidate.lineage.parentConcept}</small>
            ) : null}
          </figcaption>
          <button
            type="button"
            className={styles.exploreButton}
            onClick={() => onExplore(candidate)}
          >
            Explore variations
          </button>
        </figure>
      </>
    </ModalShell>
  );
}
