// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preferenceProfileFromSeed, type GameState } from "@/domain/game";
import { GameScreen } from "./game-screen";

const initializedGame: GameState = {
  round: {
    leftCandidate: {
      id: "generated-left",
      imageUrl: "/api/assets/generated-left.png",
      prompt: "left prompt",
      concept: "left concept",
      style: ["left"],
      createdAt: "2026-07-16T12:00:00.000Z",
      winCount: 0,
    },
    rightCandidate: {
      id: "generated-right",
      imageUrl: "/api/assets/generated-right.png",
      prompt: "right prompt",
      concept: "right concept",
      style: ["right"],
      createdAt: "2026-07-16T12:00:00.000Z",
      winCount: 0,
    },
    status: "idle",
    replacingSide: null,
    roundNumber: 1,
    retainedCandidateId: null,
    winStreak: 0,
  },
  history: [],
  preferenceSeed: "prefer unfamiliar crafted scenes",
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function cloneGame(): GameState {
  return structuredClone(initializedGame);
}

function generatingGame(
  generationJobId = "job-1",
  winnerSide: "left" | "right" = "left",
): GameState {
  const game = cloneGame();
  game.round.status = "generating";
  game.round.replacingSide = winnerSide === "left" ? "right" : "left";
  game.pendingSelection = {
    kind: "generation",
    winnerSide,
    selectedAt: "2026-07-16T12:00:01.000Z",
    generationJobId,
  };
  return game;
}

function bufferedGeneratingGame(
  winnerSide: "left" | "right" = "left",
): GameState {
  const game = cloneGame();
  game.round.status = "generating";
  game.round.replacingSide = winnerSide === "left" ? "right" : "left";
  game.pendingSelection = {
    kind: "buffer",
    winnerSide,
    selectedAt: "2026-07-16T12:00:01.000Z",
  };
  return game;
}

function retirementGeneratingGame(
  winnerSide: "left" | "right" = "left",
): GameState {
  const game = cloneGame();
  game.round.status = "generating";
  game.round.replacingSide = null;
  game.round.retainedCandidateId =
    winnerSide === "left"
      ? game.round.leftCandidate.id
      : game.round.rightCandidate.id;
  game.round.winStreak = 9;
  game.pendingSelection = {
    kind: "retirement",
    winnerSide,
    selectedAt: "2026-07-16T12:00:01.000Z",
  };
  return game;
}

function tieGeneratingGame(): GameState {
  const game = cloneGame();
  game.round.status = "generating";
  game.round.replacingSide = null;
  game.pendingSelection = {
    kind: "tie",
    referenceSide: "left",
    selectedAt: "2026-07-16T12:00:01.000Z",
  };
  return game;
}

function completedTieGame(): GameState {
  const game = cloneGame();
  const tiedLeft = game.round.leftCandidate;
  const tiedRight = game.round.rightCandidate;
  game.round = {
    leftCandidate: {
      ...tiedLeft,
      id: "tie-left",
      imageUrl: "/api/assets/tie-left.png",
      concept: "tie replacement left",
    },
    rightCandidate: {
      ...tiedRight,
      id: "tie-right",
      imageUrl: "/api/assets/tie-right.png",
      concept: "tie replacement right",
    },
    status: "idle",
    replacingSide: null,
    roundNumber: 2,
    retainedCandidateId: null,
    winStreak: 0,
  };
  game.history.push({
    outcome: "tie",
    leftId: tiedLeft.id,
    rightId: tiedRight.id,
    leftPrompt: tiedLeft.prompt,
    rightPrompt: tiedRight.prompt,
    leftConcept: tiedLeft.concept,
    rightConcept: tiedRight.concept,
    selectedAt: "2026-07-16T12:00:01.000Z",
  });
  return game;
}

function bufferedErrorGame(): GameState {
  const game = cloneGame();
  game.round.status = "error";
  game.round.replacingSide = "right";
  game.pendingSelection = {
    kind: "buffer",
    winnerSide: "left",
    selectedAt: "2026-07-16T12:00:01.000Z",
  };
  game.errorMessage = "Buffered challenger was interrupted";
  return game;
}

function completedGame(winnerSide: "left" | "right" = "left"): GameState {
  const game = cloneGame();
  const winner =
    winnerSide === "left"
      ? game.round.leftCandidate
      : game.round.rightCandidate;
  const loser =
    winnerSide === "left"
      ? game.round.rightCandidate
      : game.round.leftCandidate;
  const challenger = {
    ...loser,
    id: "challenger-job-1",
    imageUrl: "/api/assets/challenger-job-1.png",
    concept: "new challenger",
  };
  game.round = {
    leftCandidate: winnerSide === "left" ? winner : challenger,
    rightCandidate: winnerSide === "right" ? winner : challenger,
    status: "idle",
    replacingSide: null,
    roundNumber: 2,
    retainedCandidateId: winner.id,
    winStreak: 1,
  };
  game.history = [
    {
      winnerId: winner.id,
      loserId: loser.id,
      winnerPrompt: winner.prompt,
      loserPrompt: loser.prompt,
      winnerConcept: winner.concept,
      loserConcept: loser.concept,
      selectedAt: "2026-07-16T12:00:01.000Z",
    },
  ];
  return game;
}

function completedRetirementGame(
  winnerSide: "left" | "right" = "left",
): GameState {
  const game = cloneGame();
  const winner =
    winnerSide === "left"
      ? game.round.leftCandidate
      : game.round.rightCandidate;
  const loser =
    winnerSide === "left"
      ? game.round.rightCandidate
      : game.round.leftCandidate;
  game.round = {
    leftCandidate: {
      ...game.round.leftCandidate,
      id: "retirement-left",
      imageUrl: "/api/assets/retirement-left.png",
    },
    rightCandidate: {
      ...game.round.rightCandidate,
      id: "retirement-right",
      imageUrl: "/api/assets/retirement-right.png",
    },
    status: "idle",
    replacingSide: null,
    roundNumber: 2,
    retainedCandidateId: null,
    winStreak: 0,
  };
  game.history = [
    {
      winnerId: winner.id,
      loserId: loser.id,
      winnerPrompt: winner.prompt,
      loserPrompt: loser.prompt,
      winnerConcept: winner.concept,
      loserConcept: loser.concept,
      selectedAt: "2026-07-16T12:00:01.000Z",
    },
  ];
  return game;
}

function installSuccessfulImagePreload() {
  class SuccessfulImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private value = "";

    set src(value: string) {
      this.value = value;
      if (value) queueMicrotask(() => this.onload?.());
    }

    get src() {
      return this.value;
    }
  }
  vi.stubGlobal("Image", SuccessfulImage);
}

function installRecordedImagePreload(urls: string[]) {
  class RecordedImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private value = "";

    set src(value: string) {
      this.value = value;
      if (!value) return;
      urls.push(value);
      queueMicrotask(() => this.onload?.());
    }

    get src() {
      return this.value;
    }
  }
  vi.stubGlobal("Image", RecordedImage);
}

function installFailOnceImagePreload() {
  let failuresRemaining = 1;
  class FailOnceImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private value = "";

    set src(value: string) {
      this.value = value;
      if (!value) return;
      queueMicrotask(() => {
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          this.onerror?.();
        } else {
          this.onload?.();
        }
      });
    }

    get src() {
      return this.value;
    }
  }
  vi.stubGlobal("Image", FailOnceImage);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GameScreen initial generation", () => {
  it("polls with zero candidate images until both initial candidates are ready", async () => {
    let requests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        requests += 1;
        if (requests < 3) {
          return json({
            status: "initializing",
            batchId: "batch-1",
            preferenceSeed: "prefer unfamiliar crafted scenes",
          });
        }
        return json({ status: "ready", game: initializedGame });
      }),
    );

    render(<GameScreen />);

    expect(
      await screen.findByText("Creating your first comparison…"),
    ).toBeVisible();
    expect(screen.queryAllByTestId("candidate-image")).toHaveLength(0);
    await waitFor(
      () => expect(screen.getAllByTestId("candidate-image")).toHaveLength(2),
      { timeout: 2_000 },
    );
  });

  it("keeps retrying initial polling after a transient network failure", async () => {
    let requests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        requests += 1;
        if (requests === 1) {
          return json({
            status: "initializing",
            batchId: "batch-1",
            preferenceSeed: "prefer unfamiliar crafted scenes",
          });
        }
        if (requests === 2) throw new Error("temporary network outage");
        return json({ status: "ready", game: initializedGame });
      }),
    );

    render(<GameScreen />);

    expect(
      await screen.findByText(/connection interrupted.*reconnecting/i),
    ).toBeVisible();
    await waitFor(
      () => expect(screen.getAllByTestId("candidate-image")).toHaveLength(2),
      { timeout: 2_000 },
    );
    expect(requests).toBeGreaterThanOrEqual(3);
  });

  it("shows retry after an initial batch failure and starts a fresh batch", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          return json({
            status: "initializing",
            batchId: "batch-2",
            preferenceSeed: "prefer unfamiliar crafted scenes",
          });
        }
        return json({
          status: "initialization-error",
          batchId: "batch-1",
          preferenceSeed: "prefer unfamiliar crafted scenes",
          errorMessage: "Initial generation failed: deterministic failure",
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<GameScreen />);

    expect(
      await screen.findByText(
        "Initial generation failed: deterministic failure",
      ),
    ).toBeVisible();
    expect(screen.queryAllByTestId("candidate-image")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/game/start", {
        method: "POST",
      }),
    );
    expect(
      await screen.findByText("Creating your first comparison…"),
    ).toBeVisible();
  });
});

describe("GameScreen challenger reconciliation", () => {
  it("shows live ready-queue and reusable-pool health", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          status: "ready",
          game: initializedGame,
          bufferHealth: {
            ready: 3,
            inFlight: 2,
            target: 5,
            pool: 30,
            poolMaximum: 50,
          },
          eloRatings: { left: 1017, right: 983 },
        }),
      ),
    );

    render(<GameScreen />);

    expect(
      await screen.findByLabelText("Ready queue 3 of 5; 2 generating"),
    ).toHaveTextContent("Queue3/5+2");
    expect(
      screen.getByLabelText("View pool leaderboard; 30 of 50 reusable images"),
    ).toHaveTextContent("Pool30/50");
    expect(screen.getByTestId("candidate-card-left")).toHaveTextContent(
      /Elo\s*1017/,
    );
    expect(screen.getByTestId("candidate-card-right")).toHaveTextContent(
      /Elo\s*983/,
    );
    expect(
      screen.getByRole("button", {
        name: "Choose image A: left concept. Elo rating 1017",
      }),
    ).toBeVisible();
  });

  it("opens the reusable-pool leaderboard from the Pool metric", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/api/game/leaderboard")
        ? json({
            entries: [
              {
                rank: 1,
                candidate: {
                  id: "pool-leader",
                  imageUrl: "/api/assets/pool-leader.png",
                  concept: "Copper portrait",
                  style: ["photography", "violet", "alt"],
                },
                rating: 1088,
                wins: 8,
                losses: 2,
                source: "generated",
              },
              {
                rank: 2,
                candidate: {
                  id: "pool-runner-up",
                  imageUrl: "/seed-assets/pool-runner-up.png",
                  concept: "Violet portrait",
                  style: ["editorial"],
                },
                rating: 1040,
                wins: 5,
                losses: 3,
                source: "curated",
              },
            ],
            poolMaximum: 50,
          })
        : json({
            status: "ready",
            game: initializedGame,
            bufferHealth: {
              ready: 5,
              inFlight: 0,
              target: 5,
              pool: 2,
              poolMaximum: 50,
            },
          }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<GameScreen />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "View pool leaderboard; 2 of 50 reusable images",
      }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Pool leaderboard",
    });
    expect(dialog).toHaveTextContent(/1Copper portrait.*1088.*8W–2L/);
    expect(dialog).toHaveTextContent(/2Violet portrait.*1040.*5W–3L/);
    expect(fetchMock).toHaveBeenCalledWith("/api/game/leaderboard", {
      cache: "no-store",
    });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(dialog).not.toBeInTheDocument();
  });

  it("opens newest-first comparison history from the Round metric", async () => {
    const game = cloneGame();
    game.history = [
      {
        winnerId: "older-winner",
        loserId: "older-loser",
        winnerPrompt: "private older winner prompt",
        loserPrompt: "private older loser prompt",
        winnerConcept: "Older winner",
        loserConcept: "Older rejected",
        selectedAt: "2026-07-16T10:00:00.000Z",
      },
      {
        winnerId: "latest-winner",
        loserId: "latest-loser",
        winnerPrompt: "private latest winner prompt",
        loserPrompt: "private latest loser prompt",
        winnerConcept: "Latest winner",
        loserConcept: "Latest rejected",
        selectedAt: "2026-07-16T11:00:00.000Z",
      },
    ];
    game.round.roundNumber = 3;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/api/game/history")
        ? json({
            total: 2,
            entries: [
              {
                decisionNumber: 2,
                selectedAt: "2026-07-16T11:00:00.000Z",
                winner: {
                  id: "latest-winner",
                  imageUrl: "/api/assets/latest-winner.png",
                  concept: "Latest winner",
                  style: ["editorial"],
                  favorite: false,
                },
                loser: {
                  id: "latest-loser",
                  imageUrl: "/api/assets/latest-loser.png",
                  concept: "Latest rejected",
                  style: ["linocut"],
                  favorite: false,
                },
              },
              {
                decisionNumber: 1,
                selectedAt: "2026-07-16T10:00:00.000Z",
                winner: {
                  id: "older-winner",
                  imageUrl: "/api/assets/older-winner.png",
                  concept: "Older winner",
                  style: [],
                  favorite: false,
                },
                loser: {
                  id: "older-loser",
                  imageUrl: null,
                  concept: "Older rejected",
                  style: [],
                  favorite: null,
                },
              },
            ],
          })
        : String(input).endsWith("/api/game/favorites")
          ? json({ candidateId: "latest-winner", favorite: true })
          : json({ status: "ready", game }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<GameScreen />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "View comparison history; 2 decisions",
      }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Comparison history",
    });
    expect(dialog).toHaveTextContent(
      /#2.*Latest winner.*Winner.*over.*Latest rejected.*Rejected/i,
    );
    expect(dialog).toHaveTextContent(/Showing 2 of 2 decisions/);
    expect(dialog.getElementsByTagName("li")).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledWith("/api/game/history", {
      cache: "no-store",
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Add Latest winner to favorites",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Remove Latest winner from favorites",
        }),
      ).toBeVisible(),
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/game/favorites", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        candidateId: "latest-winner",
        favorite: true,
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Close history" }));
    expect(dialog).not.toBeInTheDocument();
  });

  it("commits an instant buffered round after preloading only the losing asset", async () => {
    const preloadedUrls: string[] = [];
    installRecordedImagePreload(preloadedUrls);
    const completed = completedGame("left");
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "POST"
          ? json({ ...completed, eloRatings: { left: 1016, right: 1000 } })
          : json({
              status: "ready",
              game: initializedGame,
              eloRatings: { left: 1000, right: 1000 },
            }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<GameScreen />);
    const images = await screen.findAllByTestId("candidate-image");
    const winnerImage = images[0];
    const losingImage = images[1];
    fireEvent.click(screen.getByTestId("candidate-card-left"));

    await waitFor(() =>
      expect(screen.getByLabelText("Game status")).toHaveTextContent("Round 2"),
    );
    const updatedImages = screen.getAllByTestId("candidate-image");
    expect(updatedImages[0]).toBe(winnerImage);
    expect(updatedImages[1]).not.toBe(losingImage);
    expect(screen.getByTestId("candidate-card-left")).toHaveTextContent(
      /Elo\s*1016/,
    );
    expect(screen.getByTestId("candidate-card-right")).toHaveTextContent(
      /Elo\s*1000/,
    );
    expect(preloadedUrls).toEqual(["/api/assets/challenger-job-1.png"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows both cards loading while a champion waits for retirement replacements", async () => {
    const initial = cloneGame();
    initial.round.retainedCandidateId = initial.round.leftCandidate.id;
    initial.round.winStreak = 9;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "POST"
          ? json(retirementGeneratingGame(), 202)
          : json({ status: "ready", game: initial }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<GameScreen />);
    await screen.findAllByTestId("candidate-image");
    fireEvent.click(screen.getByTestId("candidate-card-left"));

    expect(await screen.findByTestId("loading-left")).toBeVisible();
    expect(screen.getByTestId("loading-right")).toBeVisible();
    expect(screen.getAllByTestId("candidate-image")).toHaveLength(2);
    expect(
      screen.getByText("Ten-win champion retired — preparing a fresh matchup…"),
    ).toBeVisible();
  });

  it("preloads and commits both replacements after instant retirement", async () => {
    const preloadedUrls: string[] = [];
    installRecordedImagePreload(preloadedUrls);
    const initial = cloneGame();
    initial.round.retainedCandidateId = initial.round.rightCandidate.id;
    initial.round.winStreak = 9;
    const completed = completedRetirementGame("right");
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "POST"
          ? json({ ...completed, eloRatings: { left: 1000, right: 1016 } })
          : json({ status: "ready", game: initial }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<GameScreen />);
    const originalImages = await screen.findAllByTestId("candidate-image");
    fireEvent.click(screen.getByTestId("candidate-card-right"));

    await waitFor(() =>
      expect(screen.getByLabelText("Game status")).toHaveTextContent("Round 2"),
    );
    const replacements = screen.getAllByTestId("candidate-image");
    expect(replacements[0]).not.toBe(originalImages[0]);
    expect(replacements[1]).not.toBe(originalImages[1]);
    expect(preloadedUrls).toEqual([
      "/api/assets/retirement-left.png",
      "/api/assets/retirement-right.png",
    ]);
    expect(screen.getByLabelText("Game status")).toHaveTextContent(
      "Win streak 0",
    );
  });

  it("declares a tie from the visible button and replaces both cards", async () => {
    const preloadedUrls: string[] = [];
    installRecordedImagePreload(preloadedUrls);
    const completed = completedTieGame();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "POST"
          ? json({ ...completed, eloRatings: { left: 1000, right: 1000 } })
          : json({
              status: "ready",
              game: initializedGame,
              eloRatings: { left: 1000, right: 1000 },
            }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<GameScreen />);
    const originalImages = await screen.findAllByTestId("candidate-image");
    fireEvent.click(screen.getByRole("button", { name: /declare tie/i }));

    await waitFor(() =>
      expect(screen.getByLabelText("Game status")).toHaveTextContent("Round 2"),
    );
    const replacements = screen.getAllByTestId("candidate-image");
    expect(replacements[0]).not.toBe(originalImages[0]);
    expect(replacements[1]).not.toBe(originalImages[1]);
    expect(preloadedUrls).toEqual([
      "/api/assets/tie-left.png",
      "/api/assets/tie-right.png",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      outcome: "tie",
      roundNumber: 1,
    });
  });

  it.each(["c", "3"])("maps %s to the tie action", async (key) => {
    installSuccessfulImagePreload();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "POST"
          ? json(tieGeneratingGame(), 202)
          : json({ status: "ready", game: initializedGame }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<GameScreen />);
    await screen.findAllByTestId("candidate-image");
    fireEvent.keyDown(document.body, { key });

    expect(await screen.findByTestId("loading-left")).toBeVisible();
    expect(screen.getByTestId("loading-right")).toBeVisible();
    expect(
      screen.getByText("Tie recorded — preparing a fresh matchup…"),
    ).toBeVisible();
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      outcome: "tie",
      roundNumber: 1,
    });
  });

  it("animates and completes a queued preference save after the challenger arrives", async () => {
    installSuccessfulImagePreload();
    const adaptiveCompletion = completedGame();
    adaptiveCompletion.preferenceSeed = initializedGame.preferenceSeed;
    adaptiveCompletion.preferenceProfile = {
      themes: initializedGame.preferenceSeed,
      inspiration: "",
      mediaTypes: "",
      visualStyle: "",
      colorPalette: "",
      contentLevel: "family-friendly",
      avoid: "",
      adaptationMode: "adaptive",
      adaptationSourceWinnerIds: ["generated-left"],
      adaptationSourceRejectedIds: ["generated-right"],
    };
    let getCount = 0;
    let resolvePatch!: (response: Response) => void;
    const patchResponse = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") return json(bufferedGeneratingGame(), 202);
        if (init?.method === "PATCH") return patchResponse;
        getCount += 1;
        return json({
          status: "ready",
          game: getCount === 1 ? initializedGame : adaptiveCompletion,
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<GameScreen />);
    await screen.findAllByTestId("candidate-image");
    fireEvent.click(screen.getByTestId("candidate-card-left"));
    await screen.findByTestId("loading-right");
    expect(screen.getByText("Loading")).toBeVisible();
    expect(screen.queryByText("Creating challenger")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preferences" }));

    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeEnabled();
    expect(
      screen.getByText(
        "Save now to apply these changes when the challenger arrives.",
      ),
    ).toBeVisible();
    fireEvent.change(screen.getByLabelText("Inspiration"), {
      target: { value: "queued diagonal lighting" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Profile queued")).toBeVisible();
    expect(
      screen.getByText("Waiting for the challenger to arrive…"),
    ).toBeVisible();
    expect(screen.getByTestId("preference-save-spinner")).toBeVisible();
    expect(screen.getByLabelText("Inspiration")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH"),
    ).toBe(false);

    expect(await screen.findByText("Saving profile")).toBeVisible();
    expect(screen.getByText("Applying your preferences…")).toBeVisible();
    const patchCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "PATCH",
    );
    expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({
      preferenceProfile: { inspiration: "queued diagonal lighting" },
      expectedPreferenceProfile: {
        adaptationMode: "adaptive",
        adaptationSourceWinnerIds: ["generated-left"],
        adaptationSourceRejectedIds: ["generated-right"],
      },
    });

    await act(async () => {
      resolvePatch(json(adaptiveCompletion));
      await patchResponse;
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("keeps the original profile version when an open editor outlives an adaptive update", async () => {
    installSuccessfulImagePreload();
    const adaptiveCompletion = completedGame();
    adaptiveCompletion.preferenceSeed = initializedGame.preferenceSeed;
    adaptiveCompletion.preferenceProfile = {
      themes: initializedGame.preferenceSeed,
      inspiration: "",
      mediaTypes: "",
      visualStyle: "",
      colorPalette: "",
      contentLevel: "family-friendly",
      avoid: "",
      adaptationMode: "adaptive",
      adaptationSourceWinnerIds: ["generated-left"],
      adaptationSourceRejectedIds: ["generated-right"],
    };
    let getCount = 0;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") return json(bufferedGeneratingGame(), 202);
        if (init?.method === "PATCH") {
          return json(
            {
              error:
                "Preferences changed while this editor was open. Reopen Preferences and try again.",
            },
            409,
          );
        }
        getCount += 1;
        return json({
          status: "ready",
          game: getCount === 1 ? initializedGame : adaptiveCompletion,
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<GameScreen />);
    await screen.findAllByTestId("candidate-image");
    fireEvent.click(screen.getByTestId("candidate-card-left"));
    await screen.findByTestId("loading-right");
    fireEvent.click(screen.getByRole("button", { name: "Preferences" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save profile" }),
      ).toBeEnabled(),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Game status")).toHaveTextContent("Round 2"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    await screen.findByText(
      "Preferences changed while this editor was open. Reopen Preferences and try again.",
    );
    const patchCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "PATCH",
    );
    expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({
      expectedPreferenceProfile: {
        themes: initializedGame.preferenceSeed,
        adaptationMode: "static",
        adaptationSourceWinnerIds: [],
        adaptationSourceRejectedIds: [],
      },
    });
  });

  it("keeps Preferences Save enabled outside a selection-bound wait", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ status: "ready", game: initializedGame })),
    );

    render(<GameScreen />);
    await screen.findAllByTestId("candidate-image");
    fireEvent.click(screen.getByRole("button", { name: "Preferences" }));

    expect(screen.getByRole("button", { name: "Save profile" })).toBeEnabled();
    expect(
      screen.queryByText("Changes can be saved after this challenger arrives."),
    ).not.toBeInTheDocument();
  });

  it("summarizes positive and negative adaptive evidence separately", async () => {
    const evidenceGame = cloneGame();
    evidenceGame.preferenceProfile = {
      ...preferenceProfileFromSeed(evidenceGame.preferenceSeed),
      adaptationMode: "adaptive",
      adaptationSourceWinnerIds: ["winner-1", "winner-2"],
      adaptationSourceRejectedIds: ["rejected-1"],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ status: "ready", game: evidenceGame })),
    );

    render(<GameScreen />);
    await screen.findAllByTestId("candidate-image");
    fireEvent.click(screen.getByRole("button", { name: "Preferences" }));

    expect(
      screen.getByText(
        /Adaptive evidence from generated images — winners: 2; rejected: 1/,
      ),
    ).toBeVisible();
  });

  it("surfaces a moderation notice and opens Preferences to adjust it", async () => {
    const blocked = cloneGame();
    blocked.generationNotice = {
      kind: "moderation-block",
      jobId: "blocked-refill",
      occurredAt: "2026-07-16T12:00:02.000Z",
      occurrenceCount: 2,
    };
    const cleared = cloneGame();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (
          String(input).endsWith("/api/game/notice") &&
          init?.method === "DELETE"
        ) {
          return json(cleared);
        }
        return json({ status: "ready", game: blocked });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<GameScreen />);

    expect(await screen.findByText("Generation was blocked")).toBeVisible();
    expect(screen.getByText(/2 recent attempts/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Adjust preferences" }));

    expect(
      await screen.findByRole("heading", { name: "Preference profile" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/game/notice", {
        method: "DELETE",
      }),
    );
    expect(
      screen.queryByText("Generation was blocked"),
    ).not.toBeInTheDocument();
  });

  it("saves fine-grained preference fields as one profile", async () => {
    const updated = cloneGame();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") return json(updated);
        return json({ status: "ready", game: initializedGame });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<GameScreen />);
    await screen.findAllByTestId("candidate-image");
    fireEvent.click(screen.getByRole("button", { name: "Preferences" }));

    expect(screen.getByLabelText("Themes & subjects")).toHaveValue(
      initializedGame.preferenceSeed,
    );
    expect(screen.getByRole("radio", { name: "Static" })).toBeChecked();
    fireEvent.change(screen.getByLabelText("Inspiration"), {
      target: { value: "high-contrast portrait lighting" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "Adaptive" }));
    fireEvent.change(screen.getByLabelText("Preferred media"), {
      target: { value: "linocut and large-format photography" },
    });
    fireEvent.change(screen.getByLabelText("Visual style & mood"), {
      target: { value: "tactile and cinematic" },
    });
    fireEvent.change(screen.getByLabelText("Color palette"), {
      target: { value: "copper and ultraviolet" },
    });
    fireEvent.click(screen.getByRole("radio", { name: /adult themes/i }));
    fireEvent.change(screen.getByLabelText("Avoid or de-emphasize"), {
      target: { value: "readable text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/game",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    const patchCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "PATCH",
    );
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
      expectedPreferenceProfile: {
        themes: initializedGame.preferenceSeed,
        inspiration: "",
        adaptationMode: "static",
        adaptationSourceWinnerIds: [],
        adaptationSourceRejectedIds: [],
        mediaTypes: "",
        visualStyle: "",
        colorPalette: "",
        contentLevel: "family-friendly",
        avoid: "",
      },
      preferenceProfile: {
        themes: initializedGame.preferenceSeed,
        inspiration: "high-contrast portrait lighting",
        adaptationMode: "adaptive",
        adaptationSourceWinnerIds: [],
        adaptationSourceRejectedIds: [],
        mediaTypes: "linocut and large-format photography",
        visualStyle: "tactile and cinematic",
        colorPalette: "copper and ultraviolet",
        contentLevel: "adult-allowed",
        avoid: "readable text",
      },
    });
  });

  it("abandons local preservation when polling observes a different generating job", async () => {
    installSuccessfulImagePreload();
    const otherJob = generatingGame("job-from-other-tab", "right");
    otherJob.round.leftCandidate = {
      ...otherJob.round.leftCandidate,
      id: "other-left",
      imageUrl: "/api/assets/other-left.png",
    };
    otherJob.round.rightCandidate = {
      ...otherJob.round.rightCandidate,
      id: "other-right",
      imageUrl: "/api/assets/other-right.png",
    };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") return json(generatingGame("job-1"), 202);
        if (fetchMock.mock.calls.length === 1) {
          return json({ status: "ready", game: initializedGame });
        }
        return json({ status: "ready", game: otherJob });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<GameScreen />);
    await screen.findAllByTestId("candidate-image");
    fireEvent.click(screen.getByTestId("candidate-card-left"));

    await waitFor(() => {
      expect(screen.getByTestId("candidate-card-left")).toHaveAttribute(
        "data-candidate-id",
        "other-left",
      );
      expect(screen.getByTestId("candidate-card-right")).toHaveAttribute(
        "data-candidate-id",
        "other-right",
      );
    });
    expect(screen.getByTestId("loading-left")).toBeVisible();
  });

  it("adopts an unrelated authoritative completion without merging the stale local winner", async () => {
    installSuccessfulImagePreload();
    const unrelated = completedGame("right");
    unrelated.round.leftCandidate = {
      ...unrelated.round.leftCandidate,
      id: "other-tab-challenger",
      imageUrl: "/api/assets/other-tab-challenger.png",
    };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") return json(generatingGame("job-1"), 202);
        if (fetchMock.mock.calls.length === 1) {
          return json({ status: "ready", game: initializedGame });
        }
        return json({ status: "ready", game: unrelated });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<GameScreen />);
    await screen.findAllByTestId("candidate-image");
    fireEvent.click(screen.getByTestId("candidate-card-left"));

    await waitFor(() =>
      expect(screen.getByTestId("candidate-card-left")).toHaveAttribute(
        "data-candidate-id",
        "other-tab-challenger",
      ),
    );
    expect(screen.getByLabelText("Game status")).toHaveTextContent("Round 2");
  });

  it("keeps the selection locked and retries after a transient poll failure", async () => {
    installSuccessfulImagePreload();
    let pollRequests = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") return json(bufferedGeneratingGame(), 202);
        if (
          String(input).endsWith("/api/game") &&
          fetchMock.mock.calls.length === 1
        ) {
          return json({ status: "ready", game: initializedGame });
        }
        pollRequests += 1;
        if (pollRequests === 1) throw new Error("temporary network outage");
        return json({ status: "ready", game: completedGame() });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<GameScreen />);
    const originalIds = (await screen.findAllByTestId("candidate-image")).map(
      (image) => image.getAttribute("src"),
    );
    fireEvent.click(screen.getByTestId("candidate-card-left"));

    expect(
      await screen.findByText(/connection interrupted.*reconnecting/i),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByTestId("candidate-card-left")).toBeDisabled();
    expect(
      screen
        .getAllByTestId("candidate-image")
        .map((image) => image.getAttribute("src")),
    ).toEqual(originalIds);

    await waitFor(
      () =>
        expect(screen.getByLabelText("Game status")).toHaveTextContent(
          "Round 2",
        ),
      { timeout: 2_000 },
    );
    expect(pollRequests).toBeGreaterThanOrEqual(2);
  });

  it("resumes polling a buffered selection restored on refresh", async () => {
    installSuccessfulImagePreload();
    let getRequests = 0;
    const fetchMock = vi.fn(async () => {
      getRequests += 1;
      return json({
        status: "ready",
        game: getRequests === 1 ? bufferedGeneratingGame() : completedGame(),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<GameScreen />);

    await waitFor(
      () =>
        expect(screen.getByLabelText("Game status")).toHaveTextContent(
          "Round 2",
        ),
      { timeout: 2_000 },
    );
    expect(getRequests).toBeGreaterThanOrEqual(2);
  });

  it("retries polling when preloading the completed challenger fails transiently", async () => {
    installFailOnceImagePreload();
    let getRequests = 0;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") return json(generatingGame(), 202);
        getRequests += 1;
        if (getRequests === 1) {
          return json({ status: "ready", game: initializedGame });
        }
        return json({ status: "ready", game: completedGame() });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<GameScreen />);
    await screen.findAllByTestId("candidate-image");
    fireEvent.click(screen.getByTestId("candidate-card-left"));

    expect(
      await screen.findByText(/connection interrupted.*reconnecting/i),
    ).toBeVisible();
    expect(screen.getByTestId("candidate-card-left")).toBeDisabled();
    await waitFor(
      () =>
        expect(screen.getByLabelText("Game status")).toHaveTextContent(
          "Round 2",
        ),
      { timeout: 2_000 },
    );
    expect(getRequests).toBeGreaterThanOrEqual(3);
  });

  it("refetches authoritative state before retry and does not conflict with an active original job", async () => {
    installSuccessfulImagePreload();
    const failed = generatingGame();
    failed.round.status = "error";
    failed.errorMessage = "Generation failed: deterministic test failure";
    let getRequests = 0;
    let selectionPosts = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/api/game/select")) {
          selectionPosts += 1;
          return json(
            { error: "A challenger is already being generated" },
            409,
          );
        }
        if (init?.method === "POST") throw new Error("unexpected POST");
        getRequests += 1;
        if (getRequests === 1) return json({ status: "ready", game: failed });
        if (getRequests === 2) {
          return json({ status: "ready", game: generatingGame() });
        }
        return json({ status: "ready", game: completedGame() });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<GameScreen />);
    expect(await screen.findByRole("button", { name: "Retry" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(
      () =>
        expect(screen.getByLabelText("Game status")).toHaveTextContent(
          "Round 2",
        ),
      { timeout: 2_000 },
    );
    expect(selectionPosts).toBe(0);
  });

  it("does not submit a generation retry for a buffered pending selection", async () => {
    installSuccessfulImagePreload();
    const failed = bufferedErrorGame();
    let getRequests = 0;
    let selectionPosts = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/api/game/select")) {
          selectionPosts += 1;
          return json(generatingGame(), 202);
        }
        if (init?.method === "POST") throw new Error("unexpected POST");
        getRequests += 1;
        return json({ status: "ready", game: failed });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<GameScreen />);
    expect(await screen.findByRole("button", { name: "Retry" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(getRequests).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(selectionPosts).toBe(0);
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });
});

describe("GameScreen game state transfer", () => {
  it("exposes accessible pictographic controls in the main header", async () => {
    const fetchMock = vi.fn(async () =>
      json({ status: "ready", game: initializedGame }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<GameScreen />);
    await screen.findAllByTestId("candidate-image");

    for (const name of ["Export", "Load", "Preferences", "New game"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeVisible();
      expect(button.querySelector("svg")).not.toBeNull();
      expect(button.textContent).toBe("");
    }

    fireEvent.click(screen.getByRole("button", { name: "Load" }));

    expect(
      screen.getByRole("dialog", { name: "Load saved game" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Export current game first" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Choose saved game" }),
    ).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("opens a save/reset dialog instead of immediately clearing the game", async () => {
    const confirm = vi.fn();
    vi.stubGlobal("confirm", confirm);
    const fetchMock = vi.fn(async () =>
      json({ status: "ready", game: initializedGame }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<GameScreen />);
    await screen.findAllByTestId("candidate-image");
    fireEvent.click(screen.getByRole("button", { name: "New game" }));

    expect(screen.getByRole("dialog", { name: "New game" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Export current game" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Load saved game" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Start new game" }),
    ).toBeVisible();
    expect(confirm).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("downloads the server-provided current-game snapshot", async () => {
    const snapshot = JSON.stringify({
      format: "diptych-picker-game",
      version: 1,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/api/game/snapshot")
        ? new Response(snapshot, {
            headers: {
              "Content-Type": "application/json",
              "Content-Disposition":
                'attachment; filename="diptych-picker-round-8.json"',
              "X-Diptych-Export-Path":
                "/repo/output/artifacts/diptych-picker-round-8.json",
            },
          })
        : json({ status: "ready", game: initializedGame }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const NativeURL = URL;
    const createObjectURL = vi.fn(() => "blob:game-save");
    const revokeObjectURL = vi.fn();
    class DownloadURL extends NativeURL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    }
    vi.stubGlobal("URL", DownloadURL);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    render(<GameScreen />);
    await screen.findAllByTestId("candidate-image");
    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:game-save");
    expect(screen.getByRole("status")).toHaveTextContent(
      /exported diptych-picker-round-8\.json.*\/repo\/output\/artifacts\/diptych-picker-round-8\.json/i,
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/game/snapshot", {
      cache: "no-store",
    });
  });

  it("exports the last stable game while a buffered challenger is loading", async () => {
    const snapshot = JSON.stringify({
      format: "diptych-picker-game",
      version: 1,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/api/game/snapshot")
        ? new Response(snapshot, {
            headers: {
              "Content-Type": "application/json",
              "Content-Disposition":
                'attachment; filename="diptych-picker-round-1.json"',
            },
          })
        : json({ status: "ready", game: bufferedGeneratingGame() }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const NativeURL = URL;
    class DownloadURL extends NativeURL {
      static createObjectURL = vi.fn(() => "blob:stable-game");
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", DownloadURL);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      () => undefined,
    );

    render(<GameScreen />);
    await screen.findAllByTestId("candidate-image");
    const exportButton = screen.getByRole("button", { name: "Export" });
    expect(exportButton).toBeEnabled();
    fireEvent.click(exportButton);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/game/snapshot", {
        cache: "no-store",
      }),
    );
  });

  it("starts fresh only after the explicit dialog action", async () => {
    const fresh = cloneGame();
    fresh.round.roundNumber = 1;
    const current = cloneGame();
    current.round.roundNumber = 9;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "POST"
          ? json({ status: "ready", game: fresh })
          : json({ status: "ready", game: current }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<GameScreen />);
    await screen.findAllByTestId("candidate-image");
    fireEvent.click(screen.getByRole("button", { name: "New game" }));
    fireEvent.click(screen.getByRole("button", { name: "Start new game" }));

    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Game status" }),
      ).toHaveTextContent("Round 1"),
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/game/start", {
      method: "POST",
    });
  });

  it("loads a saved game and replaces the visible round", async () => {
    installSuccessfulImagePreload();
    const restored = completedGame();
    restored.round.roundNumber = 12;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).endsWith("/api/game/snapshot") && init?.method === "PUT"
          ? json({ status: "ready", game: restored })
          : json({ status: "ready", game: initializedGame }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<GameScreen />);
    await screen.findAllByTestId("candidate-image");
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    const save = new File(["{}"], "saved-game.json", {
      type: "application/json",
    });
    fireEvent.change(screen.getByLabelText("Choose saved game file"), {
      target: { files: [save] },
    });

    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Game status" }),
      ).toHaveTextContent("Round 12"),
    );
    expect(
      screen.queryByRole("dialog", { name: "Load saved game" }),
    ).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/game/snapshot", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  });
});
