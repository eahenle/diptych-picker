"use client";

/* eslint-disable @next/next/no-img-element -- The product invariant requires two stable native img elements. */

import { memo } from "react";
import type { Candidate, Side } from "@/domain/game";
import styles from "./game-screen.module.css";

interface CandidateCardProps {
  candidate: Candidate;
  side: Side;
  label: "A" | "B";
  loading: boolean;
  disabled: boolean;
  eloRating?: number;
  onSelect: (side: Side) => void;
}

export const CandidateCard = memo(function CandidateCard({
  candidate,
  side,
  label,
  loading,
  disabled,
  eloRating,
  onSelect,
}: CandidateCardProps) {
  return (
    <button
      type="button"
      className={`${styles.candidateCard} ${styles[side]}`}
      onClick={() => onSelect(side)}
      disabled={disabled}
      aria-label={`Choose image ${label}: ${candidate.concept}${eloRating === undefined ? "" : `. Elo rating ${eloRating}`}`}
      data-testid={`candidate-card-${side}`}
      data-candidate-id={candidate.id}
    >
      <img
        key={candidate.id}
        className={styles.candidateImage}
        src={candidate.imageUrl}
        alt={candidate.concept}
        draggable={false}
        data-testid="candidate-image"
      />
      <span className={styles.candidateLabel} aria-hidden="true">
        {label}
      </span>
      <span className={styles.conceptLabel}>{candidate.concept}</span>
      {eloRating === undefined ? null : (
        <span className={styles.eloLabel} aria-hidden="true">
          Elo <strong>{eloRating}</strong>
        </span>
      )}
      {loading ? (
        <span
          className={styles.loadingVeil}
          data-testid={`loading-${side}`}
          aria-live="polite"
        >
          <span className={styles.spinner} aria-hidden="true" />
          <span>Loading</span>
        </span>
      ) : null}
    </button>
  );
});
