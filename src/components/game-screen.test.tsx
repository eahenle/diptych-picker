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
import type { GameState } from "@/domain/game";
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
        if (init?.method === "POST") return json(generatingGame(), 202);
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
