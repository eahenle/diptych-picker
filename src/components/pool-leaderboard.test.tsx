// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PoolLeaderboardEntry } from "@/domain/challenger-state";
import { PoolLeaderboard } from "./pool-leaderboard";

afterEach(cleanup);

const entries: PoolLeaderboardEntry[] = [
  {
    rank: 1,
    candidate: {
      id: "leader",
      imageUrl: "/api/assets/leader.png",
      concept: "Pool leader",
      style: ["copper", "cinematic", "portrait", "unused"],
    },
    rating: 1110,
    wins: 8,
    losses: 2,
    source: "generated",
    favorite: true,
  },
];

function renderLeaderboard(
  overrides: Partial<React.ComponentProps<typeof PoolLeaderboard>> = {},
) {
  const props: React.ComponentProps<typeof PoolLeaderboard> = {
    entries,
    loading: false,
    error: null,
    favoriteError: null,
    favoriteSaving: null,
    onClose: vi.fn(),
    onInspect: vi.fn(),
    onToggleFavorite: vi.fn(),
    ...overrides,
  };
  render(<PoolLeaderboard {...props} />);
  return props;
}

describe("PoolLeaderboard", () => {
  it("renders display-safe rankings and delegates interactions", () => {
    const props = renderLeaderboard();

    const dialog = screen.getByRole("dialog", { name: "Pool leaderboard" });
    expect(dialog).toHaveTextContent("Pool leader");
    expect(dialog).toHaveTextContent("copper · cinematic · portrait");
    expect(dialog).toHaveTextContent("1110");
    expect(dialog).toHaveTextContent("8W–2L");

    fireEvent.click(
      screen.getByRole("button", { name: "View Pool leader larger" }),
    );
    expect(props.onInspect).toHaveBeenCalledWith(entries[0].candidate);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove Pool leader from favorites",
      }),
    );
    expect(props.onToggleFavorite).toHaveBeenCalledWith("leader", false);
    fireEvent.click(screen.getByRole("button", { name: "Close leaderboard" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ loading: true }, "Ranking the pool…"],
    [{ error: "Leaderboard failed" }, "Leaderboard failed"],
    [{ entries: [] }, "The pool is empty."],
  ] as const)("renders the non-ready state %s", (overrides, message) => {
    renderLeaderboard(overrides);
    expect(screen.getByText(message)).toBeVisible();
  });
});
