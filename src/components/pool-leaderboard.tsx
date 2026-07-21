"use client";

/* eslint-disable @next/next/no-img-element -- Leaderboard thumbnails use immutable local candidate assets. */

import type { PoolLeaderboardEntry } from "@/domain/challenger-state";
import { ModalShell } from "./modal-shell";
import modalStyles from "./game-modal.module.css";
import styles from "./pool-leaderboard.module.css";

interface PoolLeaderboardProps {
  entries: readonly PoolLeaderboardEntry[];
  loading: boolean;
  error: string | null;
  favoriteError: string | null;
  favoriteSaving: string | null;
  onClose: () => void;
  onInspect: (candidate: PoolLeaderboardEntry["candidate"]) => void;
  onToggleFavorite: (candidateId: string, favorite: boolean) => void;
}

export function PoolLeaderboard({
  entries,
  loading,
  error,
  favoriteError,
  favoriteSaving,
  onClose,
  onInspect,
  onToggleFavorite,
}: PoolLeaderboardProps) {
  return (
    <ModalShell
      className={`${modalStyles.dialog} ${modalStyles.wide}`}
      onClose={onClose}
      ariaLabelledBy="pool-leaderboard-title"
      ariaDescribedBy="pool-leaderboard-description"
    >
      <>
        <button
          type="button"
          className={modalStyles.closeButton}
          aria-label="Close leaderboard"
          onClick={onClose}
        >
          ×
        </button>
        <h2 id="pool-leaderboard-title">Pool leaderboard</h2>
        <p id="pool-leaderboard-description">
          Reusable images ranked by Elo. Compared generated challengers can
          enter the pool; the strongest entries remain available for paced
          fallback comparisons.
        </p>
        {favoriteError ? (
          <p className={modalStyles.alert} role="alert">
            {favoriteError}
          </p>
        ) : null}
        {loading ? (
          <p className={modalStyles.state} role="status">
            Ranking the pool…
          </p>
        ) : error ? (
          <p className={modalStyles.alert} role="alert">
            {error}
          </p>
        ) : entries.length === 0 ? (
          <p className={modalStyles.state}>The pool is empty.</p>
        ) : (
          <ol className={styles.list}>
            {entries.map((entry) => (
              <li key={entry.candidate.id}>
                <button
                  type="button"
                  className={styles.entryButton}
                  aria-label={`View ${entry.candidate.concept} larger`}
                  onClick={() => onInspect(entry.candidate)}
                >
                  <span className={styles.rank}>{entry.rank}</span>
                  <img
                    src={entry.candidate.imageUrl}
                    alt=""
                    width={72}
                    height={72}
                  />
                  <span className={styles.identity}>
                    <strong>{entry.candidate.concept}</strong>
                    <small>
                      {entry.candidate.style.slice(0, 3).join(" · ")}
                    </small>
                    <em>
                      {entry.source === "curated" ? "Curated" : "Generated"}
                    </em>
                  </span>
                  <span
                    className={styles.score}
                    aria-label={`Elo ${entry.rating}; ${entry.wins} wins and ${entry.losses} losses`}
                  >
                    <strong>{entry.rating}</strong>
                    <small>
                      {entry.wins}W–{entry.losses}L
                    </small>
                  </span>
                </button>
                <button
                  type="button"
                  className={modalStyles.favoriteButton}
                  aria-label={`${entry.favorite ? "Remove" : "Add"} ${entry.candidate.concept} ${entry.favorite ? "from" : "to"} favorites`}
                  title={
                    entry.favorite
                      ? "Remove from favorites"
                      : "Add to favorites"
                  }
                  aria-pressed={entry.favorite}
                  disabled={favoriteSaving === entry.candidate.id}
                  onClick={() =>
                    onToggleFavorite(entry.candidate.id, !entry.favorite)
                  }
                >
                  {entry.favorite ? "★" : "☆"}
                </button>
              </li>
            ))}
          </ol>
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
