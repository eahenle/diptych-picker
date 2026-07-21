"use client";

/* eslint-disable @next/next/no-img-element -- History thumbnails use immutable local candidate assets. */

import type {
  ComparisonHistoryCandidate,
  ComparisonHistoryEntry,
} from "@/domain/challenger-state";
import { ModalShell } from "./modal-shell";
import modalStyles from "./game-modal.module.css";
import styles from "./comparison-history.module.css";

interface ComparisonHistoryProps {
  entries: readonly ComparisonHistoryEntry[];
  total: number;
  loading: boolean;
  error: string | null;
  favoriteError: string | null;
  favoriteSaving: string | null;
  onClose: () => void;
  onInspect: (candidate: ComparisonHistoryCandidate) => void;
  onToggleFavorite: (candidateId: string, favorite: boolean) => void;
}

function formatSelectionTime(selectedAt: string): string {
  const date = new Date(selectedAt);
  if (Number.isNaN(date.valueOf())) return selectedAt;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function HistoryCandidate({
  candidate,
  outcome,
  favoriteSaving,
  onInspect,
  onToggleFavorite,
}: {
  candidate: ComparisonHistoryCandidate;
  outcome: "Winner" | "Tied" | "Rejected";
  favoriteSaving: string | null;
  onInspect: (candidate: ComparisonHistoryCandidate) => void;
  onToggleFavorite: (candidateId: string, favorite: boolean) => void;
}) {
  return (
    <span className={styles.candidate}>
      {candidate.imageUrl ? (
        <button
          type="button"
          className={styles.imageButton}
          aria-label={`View ${candidate.concept} larger`}
          title="View larger"
          onClick={() => onInspect(candidate)}
        >
          <img src={candidate.imageUrl} alt="" width={64} height={64} />
        </button>
      ) : (
        <span className={styles.imagePlaceholder} aria-hidden="true">
          —
        </span>
      )}
      <span>
        <strong>{candidate.concept}</strong>
        <small>{candidate.style.slice(0, 2).join(" · ")}</small>
        <span className={styles.candidateFooter}>
          <em>{outcome}</em>
          {candidate.favorite !== null ? (
            <button
              type="button"
              className={modalStyles.favoriteButton}
              aria-label={`${candidate.favorite ? "Remove" : "Add"} ${candidate.concept} ${candidate.favorite ? "from" : "to"} favorites`}
              title={
                candidate.favorite
                  ? "Remove from favorites"
                  : "Add to favorites"
              }
              aria-pressed={candidate.favorite}
              disabled={favoriteSaving === candidate.id}
              onClick={() =>
                onToggleFavorite(candidate.id, !candidate.favorite)
              }
            >
              {candidate.favorite ? "★" : "☆"}
            </button>
          ) : null}
        </span>
      </span>
    </span>
  );
}

export function ComparisonHistory({
  entries,
  total,
  loading,
  error,
  favoriteError,
  favoriteSaving,
  onClose,
  onInspect,
  onToggleFavorite,
}: ComparisonHistoryProps) {
  return (
    <ModalShell
      className={`${modalStyles.dialog} ${modalStyles.wider}`}
      onClose={onClose}
      ariaLabelledBy="comparison-history-title"
      ariaDescribedBy="comparison-history-description"
    >
      <>
        <button
          type="button"
          className={modalStyles.closeButton}
          aria-label="Close history"
          onClick={onClose}
        >
          ×
        </button>
        <h2 id="comparison-history-title">Comparison history</h2>
        <p id="comparison-history-description">
          Newest choices first. Each row shows the two candidates and the
          decision without exposing their generation prompts.
        </p>
        {favoriteError ? (
          <p className={modalStyles.alert} role="alert">
            {favoriteError}
          </p>
        ) : null}
        {loading ? (
          <p className={modalStyles.state} role="status">
            Rebuilding the timeline…
          </p>
        ) : error ? (
          <p className={modalStyles.alert} role="alert">
            {error}
          </p>
        ) : entries.length === 0 ? (
          <p className={modalStyles.state}>
            No comparisons have been decided yet.
          </p>
        ) : (
          <>
            <p className={styles.count}>
              Showing {entries.length} of {total} decisions
            </p>
            <ol className={styles.list}>
              {entries.map((entry) => {
                const pairDecision =
                  entry.outcome === "tie" || entry.outcome === "both-lose";
                const primary = pairDecision ? entry.left : entry.winner;
                const secondary = pairDecision ? entry.right : entry.loser;
                return (
                  <li key={`${entry.decisionNumber}-${entry.selectedAt}`}>
                    <span className={styles.decision}>
                      #{entry.decisionNumber}
                    </span>
                    <HistoryCandidate
                      candidate={primary}
                      outcome={
                        entry.outcome === "tie"
                          ? "Tied"
                          : entry.outcome === "both-lose"
                            ? "Rejected"
                            : "Winner"
                      }
                      favoriteSaving={favoriteSaving}
                      onInspect={onInspect}
                      onToggleFavorite={onToggleFavorite}
                    />
                    <span className={styles.versus} aria-hidden="true">
                      {entry.outcome === "tie"
                        ? "with"
                        : entry.outcome === "both-lose"
                          ? "and"
                          : "over"}
                    </span>
                    <HistoryCandidate
                      candidate={secondary}
                      outcome={entry.outcome === "tie" ? "Tied" : "Rejected"}
                      favoriteSaving={favoriteSaving}
                      onInspect={onInspect}
                      onToggleFavorite={onToggleFavorite}
                    />
                    <time dateTime={entry.selectedAt}>
                      {formatSelectionTime(entry.selectedAt)}
                    </time>
                  </li>
                );
              })}
            </ol>
          </>
        )}
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
