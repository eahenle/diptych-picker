"use client";

/* eslint-disable @next/next/no-img-element -- Favorite thumbnails use immutable local candidate assets. */

import type { FavoriteGalleryEntry } from "@/domain/challenger-state";
import { ModalShell } from "./modal-shell";
import modalStyles from "./game-modal.module.css";
import styles from "./favorites-gallery.module.css";

interface FavoritesGalleryProps {
  entries: readonly FavoriteGalleryEntry[];
  loading: boolean;
  error: string | null;
  favoriteError: string | null;
  favoriteSaving: string | null;
  onClose: () => void;
  onInspect: (candidate: FavoriteGalleryEntry["candidate"]) => void;
  onExplore: (candidate: FavoriteGalleryEntry["candidate"]) => void;
  onRemoveFavorite: (candidateId: string) => void;
}

export function FavoritesGallery({
  entries,
  loading,
  error,
  favoriteError,
  favoriteSaving,
  onClose,
  onInspect,
  onExplore,
  onRemoveFavorite,
}: FavoritesGalleryProps) {
  return (
    <ModalShell
      className={`${modalStyles.dialog} ${modalStyles.wider}`}
      onClose={onClose}
      ariaLabelledBy="favorites-gallery-title"
      ariaDescribedBy="favorites-gallery-description"
    >
      <>
        <button
          type="button"
          className={modalStyles.closeButton}
          aria-label="Close favorites"
          onClick={onClose}
        >
          ×
        </button>
        <h2 id="favorites-gallery-title">Favorites</h2>
        <p id="favorites-gallery-description">
          Every saved image, ranked by Elo. Favorites remain here after leaving
          the reusable pool.
        </p>
        {favoriteError ? (
          <p className={modalStyles.alert} role="alert">
            {favoriteError}
          </p>
        ) : null}
        {loading ? (
          <p className={modalStyles.state} role="status">
            Gathering favorites…
          </p>
        ) : error ? (
          <p className={modalStyles.alert} role="alert">
            {error}
          </p>
        ) : entries.length === 0 ? (
          <p className={modalStyles.state}>
            No favorites yet. Save standout images from history or the pool.
          </p>
        ) : (
          <ol className={styles.grid}>
            {entries.map((entry) => (
              <li key={entry.candidate.id}>
                <button
                  type="button"
                  className={styles.imageButton}
                  aria-label={`View ${entry.candidate.concept} larger`}
                  onClick={() => onInspect(entry.candidate)}
                >
                  <img
                    src={entry.candidate.imageUrl}
                    alt=""
                    width={220}
                    height={220}
                  />
                </button>
                <div className={styles.details}>
                  <span className={styles.heading}>
                    <strong>{entry.candidate.concept}</strong>
                    <small>#{entry.rank}</small>
                  </span>
                  <span className={styles.tags}>
                    {entry.candidate.style.slice(0, 3).join(" · ")}
                  </span>
                  <span className={styles.record}>
                    <strong>{entry.rating} Elo</strong>
                    <small>
                      {entry.wins}W–{entry.losses}L ·{" "}
                      {entry.source === "curated" ? "Curated" : "Generated"} ·{" "}
                      {entry.poolMember ? "In pool" : "Archived"}
                    </small>
                  </span>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      onClick={() => onExplore(entry.candidate)}
                    >
                      Explore variations
                    </button>
                    <button
                      type="button"
                      disabled={favoriteSaving === entry.candidate.id}
                      onClick={() => onRemoveFavorite(entry.candidate.id)}
                    >
                      Remove favorite
                    </button>
                  </div>
                </div>
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
