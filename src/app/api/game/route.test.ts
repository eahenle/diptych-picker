import { beforeEach, describe, expect, it, vi } from "vitest";

const getOrCreateGame = vi.fn();
const getBufferHealth = vi.fn();
const getDisplayedEloRatings = vi.fn();
const refreshBufferHealth = vi.fn();
const resetGame = vi.fn();
const exportGameSnapshot = vi.fn();
const importGameSnapshot = vi.fn();
const publishGameExport = vi.fn();
const select = vi.fn();
const tie = vi.fn();
const bothLose = vi.fn();
const updatePreferenceSeed = vi.fn();
const dismissGenerationNotice = vi.fn();
const requestSourceProfile = vi.fn();
const getSourceProfileStatus = vi.fn();
const acknowledgeSourceProfile = vi.fn();

vi.mock("@/server/runtime", () => ({
  generationProvider: "mock",
  getBufferHealth,
  getDisplayedEloRatings,
  getOrCreateGame,
  refreshBufferHealth,
  resetGame,
  exportGameSnapshot,
  importGameSnapshot,
  publishGameExport,
  gameService: { select, tie, bothLose },
  updatePreferenceSeed,
  dismissGenerationNotice,
  requestSourceProfile,
  getSourceProfileStatus,
  acknowledgeSourceProfile,
}));

beforeEach(() => {
  getDisplayedEloRatings.mockReset();
  getDisplayedEloRatings.mockResolvedValue({ left: 1016, right: 984 });
});

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
      eloRatings: { left: 1016, right: 984 },
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
      eloRatings: { left: 1016, right: 984 },
    });
  });
});

describe("GET and PUT /api/game/snapshot", () => {
  beforeEach(() => {
    exportGameSnapshot.mockReset();
    importGameSnapshot.mockReset();
    publishGameExport.mockReset();
    publishGameExport.mockResolvedValue({
      digest: "a".repeat(64),
      filename: `${"a".repeat(64)}.json`,
      path: `/repo/output/artifacts/${"a".repeat(64)}.json`,
    });
    exportGameSnapshot.mockResolvedValue({
      format: "diptych-picker-game",
      version: 1,
      exportedAt: "2026-07-17T12:00:00.000Z",
      game: { round: { roundNumber: 8 } },
      challengers: { sessionId: "session" },
    });
    importGameSnapshot.mockResolvedValue({
      round: { status: "idle", roundNumber: 8 },
    });
    getBufferHealth.mockResolvedValue({
      ready: 3,
      inFlight: 2,
      target: 5,
      pool: 20,
      poolMaximum: 50,
    });
  });

  it("downloads a named, no-store JSON snapshot", async () => {
    const { GET } = await import("./snapshot/route");

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="${"a".repeat(64)}.json"`,
    );
    expect(response.headers.get("x-diptych-export-path")).toBe(
      `/repo/output/artifacts/${"a".repeat(64)}.json`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      format: "diptych-picker-game",
      version: 1,
    });
    expect(publishGameExport).toHaveBeenCalledOnce();
  });

  it("imports a JSON snapshot and returns the ready restored game", async () => {
    const save = { format: "diptych-picker-game", version: 1 };
    const { PUT } = await import("./snapshot/route");

    const response = await PUT(
      new Request("http://localhost/api/game/snapshot", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(save),
      }),
    );

    expect(response.status).toBe(200);
    expect(importGameSnapshot).toHaveBeenCalledWith(save);
    expect(await response.json()).toMatchObject({
      status: "ready",
      game: { round: { roundNumber: 8 } },
      bufferHealth: { ready: 3, inFlight: 2 },
      eloRatings: { left: 1016, right: 984 },
    });
  });

  it("rejects malformed JSON without attempting an import", async () => {
    const { PUT } = await import("./snapshot/route");

    const response = await PUT(
      new Request("http://localhost/api/game/snapshot", {
        method: "PUT",
        body: "{not-json",
      }),
    );

    expect(response.status).toBe(400);
    expect(importGameSnapshot).not.toHaveBeenCalled();
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
      inspiration: "  sharp off-axis lighting  ",
      adaptationMode: "adaptive" as const,
      adaptationStrength: "guided" as const,
      adaptationLastDecision: 0,
      adaptationSourceWinnerIds: [],
      adaptationSourceRejectedIds: [],
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
        body: JSON.stringify({
          preferenceProfile,
          expectedPreferenceProfile: {
            ...preferenceProfile,
            adaptationMode: "static",
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(updatePreferenceSeed).toHaveBeenCalledWith(
      [
        "Themes and subjects: mythic engineering and strange ecosystems",
        "Inspiration: sharp off-axis lighting",
        "Preferred media: large-format photography",
        "Visual style and mood: cinematic and tactile",
        "Color palette: ultraviolet, copper, and oxblood",
        "Content range: Adult themes may be used when relevant; keep content non-explicit and depict only clearly adult people.",
        "Avoid or de-emphasize: readable text",
      ].join("\n"),
      preferenceProfile,
      { ...preferenceProfile, adaptationMode: "static" },
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

describe("DELETE /api/game/notice", () => {
  it("dismisses the current generation notice", async () => {
    dismissGenerationNotice.mockResolvedValue({
      round: { status: "idle" },
    });
    const { DELETE } = await import("./notice/route");

    const response = await DELETE();

    expect(response.status).toBe(200);
    expect(dismissGenerationNotice).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({ round: { status: "idle" } });
  });
});

describe("source-image preference profile analysis", () => {
  beforeEach(() => {
    requestSourceProfile.mockReset();
    getSourceProfileStatus.mockReset();
    acknowledgeSourceProfile.mockReset();
  });

  it("uploads one image and starts a durable analysis job", async () => {
    requestSourceProfile.mockResolvedValue({
      status: "analyzing",
      jobId: "source-job-1",
    });
    const form = new FormData();
    form.set(
      "image",
      new File([new Uint8Array([1, 2, 3])], "reference.png", {
        type: "image/png",
      }),
    );
    const { POST } = await import("./preferences/source/route");

    const response = await POST(
      new Request("http://localhost/api/game/preferences/source", {
        method: "POST",
        body: form,
      }),
    );

    expect(response.status).toBe(202);
    expect(requestSourceProfile).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3]),
      "image/png",
    );
    expect(await response.json()).toEqual({
      status: "analyzing",
      jobId: "source-job-1",
    });
  });

  it("returns and acknowledges a completed editable profile", async () => {
    getSourceProfileStatus.mockResolvedValue({
      status: "completed",
      jobId: "source-job-1",
      profile: {
        themes: "source-derived architectural portrait studies",
      },
      reasoningSummary: "Transfers composition without identity.",
    });
    const { GET, DELETE } = await import("./preferences/source/route");
    const url =
      "http://localhost/api/game/preferences/source?jobId=source-job-1";

    const response = await GET(new Request(url));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "completed",
      profile: { themes: "source-derived architectural portrait studies" },
    });

    const acknowledged = await DELETE(new Request(url, { method: "DELETE" }));
    expect(acknowledged.status).toBe(204);
    expect(acknowledgeSourceProfile).toHaveBeenCalledWith("source-job-1");
  });
});

describe("POST /api/game/select", () => {
  beforeEach(() => {
    select.mockReset();
    tie.mockReset();
    bothLose.mockReset();
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
    expect(await response.json()).toMatchObject({
      eloRatings: { left: 1016, right: 984 },
    });
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
    expect(await response.json()).toMatchObject({
      eloRatings: { left: 1016, right: 984 },
    });
  });

  it("declares a tie without inventing a winner side", async () => {
    tie.mockResolvedValue({ round: { status: "idle" } });
    const { POST } = await import("./select/route");

    const response = await POST(
      new Request("http://localhost/api/game/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome: "tie", roundNumber: 5 }),
      }),
    );

    expect(response.status).toBe(200);
    expect(tie).toHaveBeenCalledWith(5);
    expect(select).not.toHaveBeenCalled();
  });

  it("rejects both candidates without inventing a winner side", async () => {
    bothLose.mockResolvedValue({ round: { status: "idle" } });
    const { POST } = await import("./select/route");

    const response = await POST(
      new Request("http://localhost/api/game/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome: "both-lose", roundNumber: 6 }),
      }),
    );

    expect(response.status).toBe(200);
    expect(bothLose).toHaveBeenCalledWith(6);
    expect(select).not.toHaveBeenCalled();
  });

  it("returns a client error for malformed selection JSON", async () => {
    const { POST } = await import("./select/route");

    const response = await POST(
      new Request("http://localhost/api/game/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not-json",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Selection must be valid JSON.",
    });
    expect(select).not.toHaveBeenCalled();
    expect(tie).not.toHaveBeenCalled();
    expect(bothLose).not.toHaveBeenCalled();
  });

  it("rejects ambiguous selection payloads", async () => {
    const { POST } = await import("./select/route");

    const response = await POST(
      new Request("http://localhost/api/game/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          winnerSide: "left",
          outcome: "tie",
          roundNumber: 7,
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(select).not.toHaveBeenCalled();
    expect(tie).not.toHaveBeenCalled();
    expect(bothLose).not.toHaveBeenCalled();
  });
});
