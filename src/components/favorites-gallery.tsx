"use client";

/* eslint-disable @next/next/no-img-element -- Favorite thumbnails use immutable local candidate assets. */

import { useState } from "react";
import type { FavoriteGalleryEntry } from "@/domain/challenger-state";
import { candidateSourceLabel } from "./candidate-source-label";
import { ModalShell } from "./modal-shell";
import modalStyles from "./game-modal.module.css";
import styles from "./favorites-gallery.module.css";

interface FavoritesGalleryProps {
  entries: readonly FavoriteGalleryEntry[];
  loading: boolean;
  error: string | null;
  favoriteError: string | null;
  favoriteSaving: string | null;
  writerActive: boolean;
  writerBusy: boolean;
  writerError: string | null;
  onClose: () => void;
  onInspect: (candidate: FavoriteGalleryEntry["candidate"]) => void;
  onExplore: (candidate: FavoriteGalleryEntry["candidate"]) => void;
  onRemoveFavorite: (candidateId: string) => void;
  onWritePromptCard: (candidateIds: string[]) => Promise<boolean>;
}

export function FavoritesGallery({
  entries,
  loading,
  error,
  favoriteError,
  favoriteSaving,
  writerActive,
  writerBusy,
  writerError,
  onClose,
  onInspect,
  onExplore,
  onRemoveFavorite,
  onWritePromptCard,
}: FavoritesGalleryProps) {
  const [writerSelection, setWriterSelection] = useState<string[]>([]);
  const eligibleIds = new Set(
    entries
      .filter(({ source }) => source === "generated")
      .map(({ candidate }) => candidate.id),
  );
  const selectedIds = writerSelection.filter((id) => eligibleIds.has(id));

  const toggleWriterSource = (candidateId: string) => {
    setWriterSelection((current) => {
      const eligible = current.filter((id) => eligibleIds.has(id));
      return eligible.includes(candidateId)
        ? eligible.filter((id) => id !== candidateId)
        : eligible.length < 5
          ? [...eligible, candidateId]
          : eligible;
    });
  };

  const writePromptCard = async () => {
    if (selectedIds.length < 3 || selectedIds.length > 5) return;
    if (await onWritePromptCard(selectedIds)) setWriterSelection([]);
  };

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
        {writerError ? (
          <p className={modalStyles.alert} role="alert">
            {writerError}
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
                      {candidateSourceLabel(entry.source)} ·{" "}
                      {entry.poolMember ? "In pool" : "Archived"}
                    </small>
                  </span>
                  <div className={styles.actions}>
                    {entry.source === "generated" ? (
                      <button
                        type="button"
                        aria-pressed={selectedIds.includes(entry.candidate.id)}
                        disabled={
                          writerBusy ||
                          writerActive ||
                          (!selectedIds.includes(entry.candidate.id) &&
                            selectedIds.length >= 5)
                        }
                        onClick={() => toggleWriterSource(entry.candidate.id)}
                      >
                        {selectedIds.includes(entry.candidate.id)
                          ? "Selected for card"
                          : "Select for card"}
                      </button>
                    ) : null}
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
        {entries.some(({ source }) => source === "generated") ? (
          <div className={styles.writerControls}>
            <span>
              {writerActive
                ? "A card is being drafted from saved images."
                : `${selectedIds.length}/5 generated favorites selected · choose at least 3`}
            </span>
            <button
              type="button"
              disabled={
                writerBusy ||
                writerActive ||
                selectedIds.length < 3 ||
                selectedIds.length > 5
              }
              onClick={() => void writePromptCard()}
            >
              {writerBusy ? "Starting writer…" : "Draft prompt card"}
            </button>
          </div>
        ) : null}
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
