// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FavoriteGalleryEntry } from "@/domain/challenger-state";
import { FavoritesGallery } from "./favorites-gallery";

afterEach(cleanup);

const entries: FavoriteGalleryEntry[] = [
  {
    rank: 1,
    candidate: {
      id: "favorite",
      imageUrl: "/api/assets/favorite.png",
      concept: "Copper archive",
      style: ["editorial", "violet", "tactile"],
    },
    rating: 1084,
    wins: 6,
    losses: 3,
    source: "generated",
    poolMember: false,
  },
];

function renderGallery(
  overrides: Partial<React.ComponentProps<typeof FavoritesGallery>> = {},
) {
  const props: React.ComponentProps<typeof FavoritesGallery> = {
    entries,
    loading: false,
    error: null,
    favoriteError: null,
    favoriteSaving: null,
    writerActive: false,
    writerBusy: false,
    writerError: null,
    onClose: vi.fn(),
    onInspect: vi.fn(),
    onExplore: vi.fn(),
    onRemoveFavorite: vi.fn(),
    onWritePromptCard: vi.fn(async () => true),
    ...overrides,
  };
  render(<FavoritesGallery {...props} />);
  return props;
}

describe("FavoritesGallery", () => {
  it("renders archived favorites and delegates every action", () => {
    const props = renderGallery();

    const dialog = screen.getByRole("dialog", { name: "Favorites" });
    expect(dialog).toHaveTextContent("Copper archive");
    expect(dialog).toHaveTextContent("1084 Elo");
    expect(dialog).toHaveTextContent("6W–3L · Generated · Archived");

    fireEvent.click(
      screen.getByRole("button", { name: "View Copper archive larger" }),
    );
    expect(props.onInspect).toHaveBeenCalledWith(entries[0].candidate);
    fireEvent.click(screen.getByRole("button", { name: "Explore variations" }));
    expect(props.onExplore).toHaveBeenCalledWith(entries[0].candidate);
    fireEvent.click(screen.getByRole("button", { name: "Remove favorite" }));
    expect(props.onRemoveFavorite).toHaveBeenCalledWith("favorite");
    fireEvent.click(screen.getByRole("button", { name: "Close favorites" }));
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("drafts from three selected generated favorites", async () => {
    const generated = ["favorite", "second", "third"].map((id, index) => ({
      ...entries[0],
      rank: index + 1,
      candidate: {
        ...entries[0].candidate,
        id,
        concept: `${id} concept`,
      },
    }));
    const props = renderGallery({ entries: generated });

    for (const button of screen.getAllByRole("button", {
      name: "Select for card",
    })) {
      fireEvent.click(button);
    }
    fireEvent.click(screen.getByRole("button", { name: "Draft prompt card" }));

    await waitFor(() =>
      expect(props.onWritePromptCard).toHaveBeenCalledWith([
        "favorite",
        "second",
        "third",
      ]),
    );
  });

  it.each([
    [{ loading: true }, "Gathering favorites…"],
    [{ error: "Favorites failed" }, "Favorites failed"],
    [
      { entries: [] },
      "No favorites yet. Save standout images from history or the pool.",
    ],
  ] as const)("renders the non-ready state %s", (overrides, message) => {
    renderGallery(overrides);
    expect(screen.getByText(message)).toBeVisible();
  });
});
