import { beforeEach, describe, expect, it, vi } from "vitest";

const getOrCreateGame = vi.fn();
const getBufferHealth = vi.fn();
const getDisplayedEloRatings = vi.fn();
const getGameStartupStatus = vi.fn();
const getImportProgress = vi.fn();
const refreshBufferHealth = vi.fn();
const resetGame = vi.fn();
const exportGameSnapshot = vi.fn();
const importGameSnapshot = vi.fn();
const publishGameExport = vi.fn();
const select = vi.fn();
const tie = vi.fn();
const bothLose = vi.fn();
const selectGameRound = vi.fn(
  (selection: {
    winnerSide?: "left" | "right";
    outcome?: "tie" | "both-lose";
    roundNumber: number;
  }) =>
    selection.outcome === "tie"
      ? tie(selection.roundNumber)
      : selection.outcome === "both-lose"
        ? bothLose(selection.roundNumber)
        : select(selection.winnerSide, selection.roundNumber),
);
const updatePreferenceSeed = vi.fn();
const savePreferencePreset = vi.fn();
const deletePreferencePreset = vi.fn();
const createPromptCard = vi.fn();
const updatePromptDeck = vi.fn();
const requestPromptCardBlend = vi.fn();
const requestPromptCardWriter = vi.fn();
const requestCustomPromptCardWriter = vi.fn();
const dismissGenerationNotice = vi.fn();
const requestSourceProfile = vi.fn();
const getSourceProfileStatus = vi.fn();
const acknowledgeSourceProfile = vi.fn();
const getGameRules = vi.fn();
const updateGameRules = vi.fn();

vi.mock("@/server/runtime", () => ({
  generationProvider: "mock",
  getBufferHealth,
  getDisplayedEloRatings,
  getGameStartupStatus,
  getImportProgress,
  getOrCreateGame,
  refreshBufferHealth,
  resetGame,
  exportGameSnapshot,
  importGameSnapshot,
  publishGameExport,
  gameService: { select, tie, bothLose },
  selectGameRound,
  updatePreferenceSeed,
  savePreferencePreset,
  deletePreferencePreset,
  createPromptCard,
  updatePromptDeck,
  requestPromptCardBlend,
  requestPromptCardWriter,
  requestCustomPromptCardWriter,
  dismissGenerationNotice,
  requestSourceProfile,
  getSourceProfileStatus,
  acknowledgeSourceProfile,
  getGameRules,
  updateGameRules,
}));

beforeEach(() => {
  getDisplayedEloRatings.mockReset();
  getDisplayedEloRatings.mockResolvedValue({ left: 1016, right: 984 });
  getImportProgress.mockReset();
  getImportProgress.mockResolvedValue(null);
});

describe("GET /api/game", () => {
  beforeEach(() => {
    getOrCreateGame.mockReset();
    getBufferHealth.mockReset();
    getOrCreateGame.mockResolvedValue({ status: "initializing" });
    getBufferHealth.mockResolvedValue({
      ready: 5,
      inFlight: 0,
      active: 0,
      pending: 0,
      draining: 0,
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
        active: 0,
        pending: 0,
        draining: 0,
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
      active: 1,
      pending: 0,
      draining: 0,
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

describe("GET and PATCH /api/game/rules", () => {
  const rules = {
    bufferTarget: 5,
    poolMaximum: 20,
    championRetirementStreak: 7,
    fallbackMaximumConsecutive: 4,
  };

  it("returns the current effective rules", async () => {
    getGameRules.mockResolvedValue(rules);
    const { GET } = await import("./rules/route");

    const response = await GET();

    expect(await response.json()).toEqual({ rules });
  });

  it("validates and persists all rule fields together", async () => {
    updateGameRules.mockResolvedValue({
      gameRules: rules,
      round: { status: "idle" },
    });
    const { PATCH } = await import("./rules/route");

    const response = await PATCH(
      new Request("http://localhost/api/game/rules", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rules),
      }),
    );

    expect(response.status).toBe(200);
    expect(updateGameRules).toHaveBeenCalledWith(rules);
    expect(await response.json()).toMatchObject({ gameRules: rules });
  });

  it("rejects fractional or out-of-range rules", async () => {
    updateGameRules.mockReset();
    const { PATCH } = await import("./rules/route");

    const response = await PATCH(
      new Request("http://localhost/api/game/rules", {
        method: "PATCH",
        body: JSON.stringify({
          ...rules,
          championRetirementStreak: 1.5,
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(updateGameRules).not.toHaveBeenCalled();
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
      active: 0,
      pending: 0,
      draining: 0,
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

describe("GET /api/game/start", () => {
  it("reports resumable and unfinished-import state without opening a game", async () => {
    getOrCreateGame.mockClear();
    getGameStartupStatus.mockReset();
    getGameStartupStatus.mockResolvedValue({
      canResume: true,
      importInProgress: true,
    });
    const { GET } = await import("./start/route");

    const response = await GET();

    expect(getGameStartupStatus).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({
      canResume: true,
      importInProgress: true,
    });
    expect(getOrCreateGame).not.toHaveBeenCalled();
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
      active: 1,
      pending: 1,
      draining: 0,
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
          variationSourceCandidateId: "candidate-parent",
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
      "candidate-parent",
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

describe("preference presets", () => {
  const profile = {
    themes: "mythic engineering and strange ecosystems",
    inspiration: "sharp off-axis lighting",
    adaptationMode: "static" as const,
    adaptationStrength: "guided" as const,
    adaptationLastDecision: 0,
    adaptationSourceWinnerIds: [],
    adaptationSourceRejectedIds: [],
    mediaTypes: "large-format photography",
    visualStyle: "cinematic and tactile",
    colorPalette: "ultraviolet, copper, and oxblood",
    contentLevel: "family-friendly" as const,
    avoid: "readable text",
  };

  beforeEach(() => {
    savePreferencePreset.mockReset();
    deletePreferencePreset.mockReset();
    savePreferencePreset.mockResolvedValue({ preferencePresets: [] });
    deletePreferencePreset.mockResolvedValue({ preferencePresets: [] });
  });

  it("saves the current draft under a trimmed name", async () => {
    const { POST } = await import("./preferences/presets/route");
    const response = await POST(
      new Request("http://localhost/api/game/preferences/presets", {
        method: "POST",
        body: JSON.stringify({ name: " Copper study ", profile }),
      }),
    );

    expect(response.status).toBe(200);
    expect(savePreferencePreset).toHaveBeenCalledWith("Copper study", profile);
  });

  it("deletes a preset by id and rejects malformed saves", async () => {
    const { DELETE, POST } = await import("./preferences/presets/route");
    const deleted = await DELETE(
      new Request("http://localhost/api/game/preferences/presets", {
        method: "DELETE",
        body: JSON.stringify({ presetId: "preset-1" }),
      }),
    );
    const malformed = await POST(
      new Request("http://localhost/api/game/preferences/presets", {
        method: "POST",
        body: JSON.stringify({ name: "", profile }),
      }),
    );

    expect(deleted.status).toBe(200);
    expect(deletePreferencePreset).toHaveBeenCalledWith("preset-1");
    expect(malformed.status).toBe(400);
    expect(savePreferencePreset).not.toHaveBeenCalled();
  });
});

describe("prompt deck", () => {
  beforeEach(() => {
    createPromptCard.mockReset();
    updatePromptDeck.mockReset();
    requestPromptCardBlend.mockReset();
    requestPromptCardWriter.mockReset();
    requestCustomPromptCardWriter.mockReset();
    createPromptCard.mockResolvedValue({ promptDeck: { cards: [] } });
    updatePromptDeck.mockResolvedValue({ promptDeck: { cards: [] } });
    requestPromptCardBlend.mockResolvedValue({ promptDeck: { cards: [] } });
    requestPromptCardWriter.mockResolvedValue({ promptDeck: { cards: [] } });
    requestCustomPromptCardWriter.mockResolvedValue({
      promptDeck: { cards: [] },
    });
  });

  it("creates a validated prompt card", async () => {
    const { POST } = await import("./preferences/deck/route");
    const input = {
      title: "Copper nocturne",
      prompt: "A severe copper-lit industrial editorial portrait.",
      negativePrompt: "readable text",
      weight: 1,
      tags: ["portrait", "copper"],
    };
    const response = await POST(
      new Request("http://localhost/api/game/preferences/deck", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );

    expect(response.status).toBe(200);
    expect(createPromptCard).toHaveBeenCalledWith(input);
  });

  it("requests a validated prompt-card blend", async () => {
    const { POST } = await import("./preferences/deck/blend/route");
    const response = await POST(
      new Request("http://localhost/api/game/preferences/deck/blend", {
        method: "POST",
        body: JSON.stringify({ cardIds: ["card-1", "card-2"], ratio: 0.5 }),
      }),
    );

    expect(response.status).toBe(200);
    expect(requestPromptCardBlend).toHaveBeenCalledWith(
      ["card-1", "card-2"],
      0.5,
    );
  });

  it("requests a validated prompt card from generated favorites", async () => {
    const { POST } = await import("./preferences/deck/write/route");
    const candidateIds = ["generated-1", "generated-2", "generated-3"];
    const response = await POST(
      new Request("http://localhost/api/game/preferences/deck/write", {
        method: "POST",
        body: JSON.stringify({ candidateIds }),
      }),
    );

    expect(response.status).toBe(200);
    expect(requestPromptCardWriter).toHaveBeenCalledWith(candidateIds);
  });

  it("requests a prompt card from private seed images and text", async () => {
    const { POST } = await import("./preferences/deck/write/custom/route");
    const form = new FormData();
    form.set("guidance", "Preserve the monumental negative space.");
    form.append(
      "images",
      new File([new Uint8Array([1, 2, 3])], "seed.png", {
        type: "image/png",
      }),
    );
    const response = await POST(
      new Request("http://localhost/api/game/preferences/deck/write/custom", {
        method: "POST",
        body: form,
      }),
    );

    expect(response.status).toBe(200);
    expect(requestCustomPromptCardWriter).toHaveBeenCalledWith({
      guidance: "Preserve the monumental negative space.",
      images: [
        expect.objectContaining({
          filename: "seed.png",
          contentType: "image/png",
          contents: new Uint8Array([1, 2, 3]),
        }),
      ],
    });
  });

  it("updates deck and card controls", async () => {
    const { PATCH } = await import("./preferences/deck/route");
    const response = await PATCH(
      new Request("http://localhost/api/game/preferences/deck", {
        method: "PATCH",
        body: JSON.stringify({ kind: "deck", enabled: true }),
      }),
    );

    expect(response.status).toBe(200);
    expect(updatePromptDeck).toHaveBeenCalledWith({
      kind: "deck",
      enabled: true,
    });

    const suggestionResponse = await PATCH(
      new Request("http://localhost/api/game/preferences/deck", {
        method: "PATCH",
        body: JSON.stringify({
          kind: "suggestion",
          suggestionId: "suggestion-1",
          action: "accept",
        }),
      }),
    );
    expect(suggestionResponse.status).toBe(200);
    expect(updatePromptDeck).toHaveBeenLastCalledWith({
      kind: "suggestion",
      suggestionId: "suggestion-1",
      action: "accept",
    });
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
