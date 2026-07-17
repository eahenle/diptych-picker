import { beforeEach, describe, expect, it, vi } from "vitest";

const getOrCreateGame = vi.fn();
const getBufferHealth = vi.fn();
const refreshBufferHealth = vi.fn();
const resetGame = vi.fn();
const select = vi.fn();
const updatePreferenceSeed = vi.fn();

vi.mock("@/server/runtime", () => ({
  generationProvider: "mock",
  getBufferHealth,
  getOrCreateGame,
  refreshBufferHealth,
  resetGame,
  gameService: { select },
  updatePreferenceSeed,
}));

describe("GET /api/game", () => {
  beforeEach(() => {
    getOrCreateGame.mockReset();
    getBufferHealth.mockReset();
    getOrCreateGame.mockResolvedValue({ status: "initializing" });
    getBufferHealth.mockResolvedValue({
      ready: 5,
      inFlight: 0,
      target: 5,
      pool: 30,
      poolMaximum: 50,
    });
  });

  it("reports the live generation provider in a response header", async () => {
    const { GET } = await import("./route");

    const response = await GET();

    expect(response.headers.get("X-Diptych-Generation-Provider")).toBe("mock");
  });

  it("includes narrow buffer health data with a ready game", async () => {
    getOrCreateGame.mockResolvedValue({
      status: "ready",
      game: { round: { status: "idle" } },
    });
    const { GET } = await import("./route");

    const response = await GET();

    expect(await response.json()).toMatchObject({
      status: "ready",
      bufferHealth: {
        ready: 5,
        inFlight: 0,
        target: 5,
        pool: 30,
        poolMaximum: 50,
      },
    });
  });
});

describe("GET /api/game/health", () => {
  it("returns the current buffer health snapshot", async () => {
    const health = {
      ready: 4,
      inFlight: 1,
      target: 5,
      pool: 12,
      poolMaximum: 50,
    };
    refreshBufferHealth.mockResolvedValue(health);
    const { GET } = await import("./health/route");

    const response = await GET();

    expect(await response.json()).toEqual(health);
  });
});

describe("POST /api/game/start", () => {
  it("includes fresh buffer health when a reset is immediately ready", async () => {
    resetGame.mockResolvedValue({
      status: "ready",
      game: { round: { status: "idle" } },
    });
    getBufferHealth.mockResolvedValue({
      ready: 5,
      inFlight: 0,
      target: 5,
      pool: 7,
      poolMaximum: 50,
    });
    const { POST } = await import("./start/route");

    const response = await POST();

    expect(await response.json()).toMatchObject({
      status: "ready",
      bufferHealth: { ready: 5, pool: 7 },
    });
  });
});

describe("PATCH /api/game", () => {
  beforeEach(() => {
    updatePreferenceSeed.mockReset();
    updatePreferenceSeed.mockResolvedValue({ round: { status: "idle" } });
  });

  it("composes and persists a fine-grained preference profile", async () => {
    const preferenceProfile = {
      themes: "mythic engineering and strange ecosystems",
      mediaTypes: "large-format photography",
      visualStyle: "cinematic and tactile",
      colorPalette: "ultraviolet, copper, and oxblood",
      contentLevel: "adult-allowed",
      avoid: "readable text",
    };
    const { PATCH } = await import("./route");

    const response = await PATCH(
      new Request("http://localhost/api/game", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferenceProfile }),
      }),
    );

    expect(response.status).toBe(200);
    expect(updatePreferenceSeed).toHaveBeenCalledWith(
      [
        "Themes and subjects: mythic engineering and strange ecosystems",
        "Preferred media: large-format photography",
        "Visual style and mood: cinematic and tactile",
        "Color palette: ultraviolet, copper, and oxblood",
        "Content range: Adult themes may be used when relevant; keep content non-explicit and depict only clearly adult people.",
        "Avoid or de-emphasize: readable text",
      ].join("\n"),
      preferenceProfile,
    );
  });

  it("rejects an underspecified themes field", async () => {
    const { PATCH } = await import("./route");

    const response = await PATCH(
      new Request("http://localhost/api/game", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preferenceProfile: {
            themes: "too short",
            mediaTypes: "",
            visualStyle: "",
            colorPalette: "",
            contentLevel: "family-friendly",
            avoid: "",
          },
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(updatePreferenceSeed).not.toHaveBeenCalled();
  });

  it("returns a client error for malformed JSON", async () => {
    const { PATCH } = await import("./route");

    const response = await PATCH(
      new Request("http://localhost/api/game", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "{not-json",
      }),
    );

    expect(response.status).toBe(400);
    expect(updatePreferenceSeed).not.toHaveBeenCalled();
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
