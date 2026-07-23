import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  CandidateFavoriteNotFoundError,
  getFavoriteGallery,
  setCandidateFavorite,
} = vi.hoisted(() => ({
  CandidateFavoriteNotFoundError: class extends Error {},
  getFavoriteGallery: vi.fn(),
  setCandidateFavorite: vi.fn(),
}));

vi.mock("@/server/runtime", () => ({
  CandidateFavoriteNotFoundError,
  getFavoriteGallery,
  setCandidateFavorite,
}));

beforeEach(() => {
  getFavoriteGallery.mockReset();
  setCandidateFavorite.mockReset();
});

describe("GET /api/game/favorites", () => {
  it("returns the display-safe gallery without caching it", async () => {
    getFavoriteGallery.mockResolvedValue({
      entries: [{ rank: 1, candidate: { id: "favorite" } }],
    });
    const { GET } = await import("./route");

    const response = await GET();

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      entries: [{ rank: 1, candidate: { id: "favorite" } }],
    });
  });
});

describe("PUT /api/game/favorites", () => {
  it("updates a candidate favorite", async () => {
    setCandidateFavorite.mockResolvedValue({
      candidateId: "favorite",
      favorite: false,
    });
    const { PUT } = await import("./route");

    const response = await PUT(
      new Request("http://localhost/api/game/favorites", {
        method: "PUT",
        body: JSON.stringify({ candidateId: "favorite", favorite: false }),
      }),
    );

    expect(response.status).toBe(200);
    expect(setCandidateFavorite).toHaveBeenCalledWith("favorite", false);
  });

  it("returns 404 when the candidate is unavailable", async () => {
    setCandidateFavorite.mockRejectedValue(
      new CandidateFavoriteNotFoundError("Candidate missing"),
    );
    const { PUT } = await import("./route");

    const response = await PUT(
      new Request("http://localhost/api/game/favorites", {
        method: "PUT",
        body: JSON.stringify({ candidateId: "missing", favorite: true }),
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Candidate missing" });
  });
});
