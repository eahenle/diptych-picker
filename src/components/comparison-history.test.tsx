// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComparisonHistoryEntry } from "@/domain/challenger-state";
import { ComparisonHistory } from "./comparison-history";

afterEach(cleanup);

const favoriteCandidate = {
  id: "winner",
  imageUrl: "/api/assets/winner.png",
  concept: "Copper winner",
  style: ["copper", "portrait", "unused"],
  favorite: true,
};

const challenger = {
  id: "challenger",
  imageUrl: "/api/assets/challenger.png",
  concept: "Violet challenger",
  style: ["violet", "editorial"],
  favorite: false,
};

const entries: ComparisonHistoryEntry[] = [
  {
    outcome: "selection",
    decisionNumber: 3,
    selectedAt: "2026-07-21T12:00:00.000Z",
    winner: favoriteCandidate,
    loser: challenger,
  },
  {
    outcome: "tie",
    decisionNumber: 2,
    selectedAt: "2026-07-21T11:00:00.000Z",
    left: { ...favoriteCandidate, id: "tie-left", favorite: null },
    right: { ...challenger, id: "tie-right", favorite: null },
  },
  {
    outcome: "both-lose",
    decisionNumber: 1,
    selectedAt: "invalid-time",
    left: { ...favoriteCandidate, id: "rejected-left", favorite: null },
    right: { ...challenger, id: "rejected-right", favorite: null },
  },
];

function renderHistory(
  overrides: Partial<React.ComponentProps<typeof ComparisonHistory>> = {},
) {
  const props: React.ComponentProps<typeof ComparisonHistory> = {
    entries,
    total: 10,
    loading: false,
    error: null,
    favoriteError: null,
    favoriteSaving: null,
    onClose: vi.fn(),
    onInspect: vi.fn(),
    onToggleFavorite: vi.fn(),
    ...overrides,
  };
  render(<ComparisonHistory {...props} />);
  return props;
}

describe("ComparisonHistory", () => {
  it("renders each decision type and delegates candidate actions", () => {
    const props = renderHistory();

    expect(
      screen.getByRole("dialog", { name: "Comparison history" }),
    ).toHaveTextContent("Showing 3 of 10 decisions");
    expect(screen.getByText("Winner")).toBeVisible();
    expect(screen.getAllByText("Tied")).toHaveLength(2);
    expect(screen.getAllByText("Rejected")).toHaveLength(3);
    expect(screen.getByText("invalid-time")).toBeVisible();

    fireEvent.click(
      screen.getAllByRole("button", {
        name: "View Copper winner larger",
      })[0],
    );
    expect(props.onInspect).toHaveBeenCalledWith(favoriteCandidate);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove Copper winner from favorites",
      }),
    );
    expect(props.onToggleFavorite).toHaveBeenCalledWith("winner", false);
    fireEvent.click(screen.getByRole("button", { name: "Close history" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ loading: true }, "Rebuilding the timeline…"],
    [{ error: "History failed" }, "History failed"],
    [{ entries: [] }, "No comparisons have been decided yet."],
  ] as const)("renders the non-ready state %s", (overrides, message) => {
    renderHistory(overrides);
    expect(screen.getByText(message)).toBeVisible();
  });

  it("surfaces favorite errors and disables the saving candidate", () => {
    renderHistory({
      favoriteError: "Favorite update failed",
      favoriteSaving: "winner",
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Favorite update failed",
    );
    expect(
      screen.getByRole("button", {
        name: "Remove Copper winner from favorites",
      }),
    ).toBeDisabled();
  });
});
