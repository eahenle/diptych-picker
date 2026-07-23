"use client";

import { useCallback, useState, type MutableRefObject } from "react";
import type { GameState } from "@/domain/game";
import type {
  ComparisonHistoryCandidate,
  ComparisonHistoryEntry,
  FavoriteGalleryEntry,
  PoolLeaderboardEntry,
} from "@/domain/challenger-state";
import { readJson } from "./game-api";
import type {
  ImageInspectorState,
  InspectableCandidate,
} from "./image-inspector";

interface UseCandidateBrowserOptions {
  gameRef: MutableRefObject<GameState | null>;
}

export function useCandidateBrowser({ gameRef }: UseCandidateBrowserOptions) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [favoriteEntries, setFavoriteEntries] = useState<
    FavoriteGalleryEntry[]
  >([]);
  const [favoritesLoading, setFavoritesLoading] = useState(false);
  const [favoritesError, setFavoritesError] = useState<string | null>(null);
  const [imageInspector, setImageInspector] =
    useState<ImageInspectorState | null>(null);
  const [historyEntries, setHistoryEntries] = useState<
    ComparisonHistoryEntry[]
  >([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);
  const [leaderboardEntries, setLeaderboardEntries] = useState<
    PoolLeaderboardEntry[]
  >([]);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [leaderboardError, setLeaderboardError] = useState<string | null>(null);
  const [favoriteSaving, setFavoriteSaving] = useState<string | null>(null);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);

  const openImageInspector = useCallback(
    (
      candidate: InspectableCandidate,
      candidates: readonly InspectableCandidate[],
      returnTarget: ImageInspectorState["returnTarget"] = null,
    ) => {
      const titledCandidates = candidates.map((item) => ({
        ...item,
        ...(item.promptCardId
          ? {
              promptCardTitle: gameRef.current?.promptDeck?.cards.find(
                (card) => card.id === item.promptCardId,
              )?.title,
            }
          : {}),
      }));
      const uniqueCandidates = titledCandidates.filter(
        (item, index) =>
          item.imageUrl &&
          titledCandidates.findIndex(
            (candidate) => candidate.id === item.id,
          ) === index,
      );
      const index = uniqueCandidates.findIndex(
        (item) => item.id === candidate.id,
      );
      setImageInspector({
        candidates:
          uniqueCandidates.length > 0 ? uniqueCandidates : [candidate],
        index: index >= 0 ? index : 0,
        returnTarget,
      });
    },
    [gameRef],
  );

  const openComparisonHistory = useCallback(async () => {
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryError(null);
    setFavoriteError(null);
    try {
      const response = await fetch("/api/game/history", {
        cache: "no-store",
      });
      const data = await readJson<{
        entries: ComparisonHistoryEntry[];
        total: number;
      }>(response);
      setHistoryEntries(data.entries);
      setHistoryTotal(data.total);
    } catch (caught) {
      setHistoryError(
        caught instanceof Error ? caught.message : "Could not load history",
      );
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const inspectLeaderboardCandidate = useCallback(
    (candidate: PoolLeaderboardEntry["candidate"]) => {
      setLeaderboardOpen(false);
      openImageInspector(
        candidate,
        leaderboardEntries.map((entry) => entry.candidate),
        "leaderboard",
      );
    },
    [leaderboardEntries, openImageInspector],
  );

  const inspectFavoriteCandidate = useCallback(
    (candidate: FavoriteGalleryEntry["candidate"]) => {
      setFavoritesOpen(false);
      openImageInspector(
        candidate,
        favoriteEntries.map((entry) => entry.candidate),
        "favorites",
      );
    },
    [favoriteEntries, openImageInspector],
  );

  const closeImageInspector = useCallback(() => {
    const returnTarget = imageInspector?.returnTarget ?? null;
    setImageInspector(null);
    if (returnTarget === "favorites") setFavoritesOpen(true);
    if (returnTarget === "leaderboard") setLeaderboardOpen(true);
  }, [imageInspector?.returnTarget]);

  const dismissImageInspector = useCallback(() => setImageInspector(null), []);

  const navigateImageInspector = useCallback((direction: -1 | 1) => {
    setImageInspector((current) =>
      current
        ? {
            ...current,
            index:
              (current.index + direction + current.candidates.length) %
              current.candidates.length,
          }
        : current,
    );
  }, []);

  const inspectHistoryCandidate = useCallback(
    (candidate: ComparisonHistoryCandidate) => {
      if (!candidate.imageUrl) return;
      setHistoryOpen(false);
      const candidates = historyEntries.flatMap((entry) =>
        entry.outcome === "tie" || entry.outcome === "both-lose"
          ? [entry.left, entry.right]
          : [entry.winner, entry.loser],
      );
      openImageInspector(
        {
          id: candidate.id,
          imageUrl: candidate.imageUrl,
          concept: candidate.concept,
        },
        candidates.flatMap((item) =>
          item.imageUrl
            ? [{ id: item.id, imageUrl: item.imageUrl, concept: item.concept }]
            : [],
        ),
      );
    },
    [historyEntries, openImageInspector],
  );

  const openPoolLeaderboard = useCallback(async () => {
    setLeaderboardOpen(true);
    setLeaderboardLoading(true);
    setLeaderboardError(null);
    setFavoriteError(null);
    try {
      const response = await fetch("/api/game/leaderboard", {
        cache: "no-store",
      });
      const data = await readJson<{
        entries: PoolLeaderboardEntry[];
        poolMaximum: number;
      }>(response);
      setLeaderboardEntries(data.entries);
    } catch (caught) {
      setLeaderboardError(
        caught instanceof Error ? caught.message : "Could not load the pool",
      );
    } finally {
      setLeaderboardLoading(false);
    }
  }, []);

  const openFavoritesGallery = useCallback(async () => {
    setFavoritesOpen(true);
    setFavoritesLoading(true);
    setFavoritesError(null);
    setFavoriteError(null);
    try {
      const response = await fetch("/api/game/favorites", {
        cache: "no-store",
      });
      const data = await readJson<{ entries: FavoriteGalleryEntry[] }>(
        response,
      );
      setFavoriteEntries(data.entries);
    } catch (caught) {
      setFavoritesError(
        caught instanceof Error ? caught.message : "Could not load favorites",
      );
    } finally {
      setFavoritesLoading(false);
    }
  }, []);

  const updateFavorite = useCallback(
    async (candidateId: string, favorite: boolean) => {
      setFavoriteSaving(candidateId);
      setFavoriteError(null);
      try {
        await readJson<{ candidateId: string; favorite: boolean }>(
          await fetch("/api/game/favorites", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ candidateId, favorite }),
          }),
        );
        setHistoryEntries((entries) =>
          entries.map((entry) =>
            entry.outcome === "tie" || entry.outcome === "both-lose"
              ? {
                  ...entry,
                  left:
                    entry.left.id === candidateId
                      ? { ...entry.left, favorite }
                      : entry.left,
                  right:
                    entry.right.id === candidateId
                      ? { ...entry.right, favorite }
                      : entry.right,
                }
              : {
                  ...entry,
                  winner:
                    entry.winner.id === candidateId
                      ? { ...entry.winner, favorite }
                      : entry.winner,
                  loser:
                    entry.loser.id === candidateId
                      ? { ...entry.loser, favorite }
                      : entry.loser,
                },
          ),
        );
        setLeaderboardEntries((entries) =>
          entries.map((entry) =>
            entry.candidate.id === candidateId ? { ...entry, favorite } : entry,
          ),
        );
        setFavoriteEntries((entries) =>
          favorite
            ? entries
            : entries.filter((entry) => entry.candidate.id !== candidateId),
        );
      } catch (caught) {
        setFavoriteError(
          caught instanceof Error
            ? caught.message
            : "Could not update favorite",
        );
      } finally {
        setFavoriteSaving(null);
      }
    },
    [],
  );

  const closeComparisonHistory = useCallback(() => setHistoryOpen(false), []);
  const closeFavoritesGallery = useCallback(() => setFavoritesOpen(false), []);
  const closePoolLeaderboard = useCallback(() => setLeaderboardOpen(false), []);

  return {
    favoriteEntries,
    favoriteError,
    favoriteSaving,
    favoritesError,
    favoritesLoading,
    favoritesOpen,
    historyEntries,
    historyError,
    historyLoading,
    historyOpen,
    historyTotal,
    imageInspector,
    leaderboardEntries,
    leaderboardError,
    leaderboardLoading,
    leaderboardOpen,
    closeComparisonHistory,
    closeFavoritesGallery,
    closeImageInspector,
    closePoolLeaderboard,
    dismissImageInspector,
    inspectFavoriteCandidate,
    inspectHistoryCandidate,
    inspectLeaderboardCandidate,
    navigateImageInspector,
    openComparisonHistory,
    openFavoritesGallery,
    openImageInspector,
    openPoolLeaderboard,
    updateFavorite,
  };
}
