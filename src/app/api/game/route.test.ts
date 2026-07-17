import { beforeEach, describe, expect, it, vi } from "vitest";

const getOrCreateGame = vi.fn();
const select = vi.fn();

vi.mock("@/server/runtime", () => ({
  generationProvider: "mock",
  getOrCreateGame,
  gameService: { select },
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

describe("POST /api/game/select", () => {
  beforeEach(() => {
    select.mockReset();
  });

  it("returns 200 when a buffered challenger completes the round", async () => {
    select.mockResolvedValue({ round: { status: "idle" } });
    const { POST } = await import("./select/route");

    const response = await POST(
      new Request("http://localhost/api/game/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ winnerSide: "left", roundNumber: 3 }),
      }),
    );

    expect(response.status).toBe(200);
  });

  it("returns 202 when the selected round is waiting for buffer capacity", async () => {
    select.mockResolvedValue({ round: { status: "generating" } });
    const { POST } = await import("./select/route");

    const response = await POST(
      new Request("http://localhost/api/game/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ winnerSide: "right", roundNumber: 4 }),
      }),
    );

    expect(response.status).toBe(202);
  });
});
