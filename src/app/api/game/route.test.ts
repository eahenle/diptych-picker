import { beforeEach, describe, expect, it, vi } from "vitest";

const getOrCreateGame = vi.fn();

vi.mock("@/server/runtime", () => ({
  generationProvider: "mock",
  getOrCreateGame,
  updatePreferenceSeed: vi.fn(),
}));

describe("GET /api/game", () => {
  beforeEach(() => {
    getOrCreateGame.mockReset();
    getOrCreateGame.mockResolvedValue({ status: "initializing" });
  });

  it("reports the live generation provider in a response header", async () => {
    const { GET } = await import("./route");

    const response = await GET();

    expect(response.headers.get("X-Diptych-Generation-Provider")).toBe("mock");
  });
});
