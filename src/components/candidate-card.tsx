"use client";

/* eslint-disable @next/next/no-img-element -- The product invariant requires two stable native img elements. */

import { memo } from "react";
import type { Candidate, DisplayedScore, Side } from "@/domain/game";
import styles from "./game-screen.module.css";

interface CandidateCardProps {
  candidate: Candidate;
  side: Side;
  label: "A" | "B";
  loading: boolean;
  disabled: boolean;
  eloRating?: DisplayedScore;
  onSelect: (side: Side) => void;
  onInspect: (candidate: Candidate) => void;
}

export const CandidateCard = memo(function CandidateCard({
  candidate,
  side,
  label,
  loading,
  disabled,
  eloRating,
  onSelect,
  onInspect,
}: CandidateCardProps) {
  const scoreDescription =
    eloRating === "new"
      ? "First appearance"
      : eloRating === "pool-exit"
        ? "Leaves the reusable pool if it loses"
        : eloRating === undefined
          ? null
          : `Elo rating ${eloRating}`;
  const scoreSymbol = eloRating === "new" ? "✦" : "⊖";

  return (
    <div className={`${styles.candidatePanel} ${styles[side]}`}>
      <button
        type="button"
        className={styles.candidateCard}
        onClick={() => onSelect(side)}
        disabled={disabled}
        aria-label={`Choose image ${label}: ${candidate.concept}${scoreDescription ? `. ${scoreDescription}` : ""}`}
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
          <span
            className={styles.eloLabel}
            data-score-state={typeof eloRating === "number" ? "elo" : eloRating}
            title={scoreDescription ?? undefined}
            aria-hidden="true"
          >
            {typeof eloRating === "number" ? (
              <>
                Elo <strong>{eloRating}</strong>
              </>
            ) : (
              <strong className={styles.scoreSymbol}>{scoreSymbol}</strong>
            )}
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
      <button
        type="button"
        className={styles.inspectButton}
        aria-label={`View image ${label} larger`}
        title="View larger"
        onClick={() => onInspect(candidate)}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="10.5" cy="10.5" r="5.5" />
          <path d="m15 15 5 5" />
        </svg>
      </button>
    </div>
  );
});
