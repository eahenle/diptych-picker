// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameState } from "@/domain/game";

const { inspectImportFile, preloadChangedAssets } = vi.hoisted(() => ({
  inspectImportFile: vi.fn(),
  preloadChangedAssets: vi.fn(),
}));

vi.mock("./import-image-file", async (loadOriginal) => ({
  ...(await loadOriginal<typeof import("./import-image-file")>()),
  inspectImportFile,
}));
vi.mock("./image-preload", () => ({ preloadChangedAssets }));

import { useImageImport, type ImportSessionStatus } from "./use-image-import";

const game: GameState = {
  round: {
    leftCandidate: {
      id: "left",
      imageUrl: "/api/assets/left.png",
      prompt: "left prompt",
      concept: "left",
      style: ["left"],
      createdAt: "2026-08-10T12:00:00.000Z",
      winCount: 0,
    },
    rightCandidate: {
      id: "right",
      imageUrl: "/api/assets/right.png",
      prompt: "right prompt",
      concept: "right",
      style: ["right"],
      createdAt: "2026-08-10T12:00:00.000Z",
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

function status(
  overrides: Partial<ImportSessionStatus> = {},
): ImportSessionStatus {
  return {
    sessionId: "import-session-1",
    status: "editing",
    createdAt: "2026-08-10T12:00:00.000Z",
    sealedAt: null,
    activatedAt: null,
    activationTarget: 5,
    activationReady: 0,
    counts: {
      total: 0,
      annotating: 0,
      ready: 0,
      failed: 0,
      removed: 0,
      served: 0,
    },
    items: [],
    initialFill: {
      pending: 0,
      ready: 0,
      failed: 0,
      failedAttemptId: null,
      failureMessage: null,
    },
    ...overrides,
  };
}

function json(value: unknown, responseStatus = 200): Response {
  return new Response(JSON.stringify(value), {
    status: responseStatus,
    headers: { "Content-Type": "application/json" },
  });
}

function bitmap(width = 1200, height = 800): ImageBitmap {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap;
}

function renderImport(
  overrides: Partial<Parameters<typeof useImageImport>[0]> = {},
) {
  const options: Parameters<typeof useImageImport>[0] = {
    modalOpen: true,
    gameRef: { current: game },
    selectionLockedRef: { current: false },
    commitStartState: vi.fn(),
    cancelActiveSelection: vi.fn(),
    onDismiss: vi.fn(),
    onActivated: vi.fn(),
    ...overrides,
  };
  return { ...renderHook(() => useImageImport(options)), options };
}

describe("useImageImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    preloadChangedAssets.mockResolvedValue(undefined);
    inspectImportFile.mockImplementation(async (file: File) => ({
      file,
      bitmap: bitmap(),
      contentType: "image/png",
      width: 1200,
      height: 800,
      animated: false,
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps originals client-only, reports per-file errors, and seals after every local input resolves", async () => {
    const editing = status();
    const annotating = status({
      counts: { ...editing.counts, total: 1, annotating: 1 },
    });
    const preparing = status({
      status: "preparing",
      sealedAt: "2026-08-10T12:01:00.000Z",
      counts: { ...editing.counts, total: 1, annotating: 1 },
    });
    inspectImportFile.mockImplementation(async (file: File) => {
      if (file.name === "broken.gif") {
        const { ImportImageFileError } = await import("./import-image-file");
        throw new ImportImageFileError(
          "Choose a still PNG, JPEG, or WebP image.",
        );
      }
      return {
        file,
        bitmap: bitmap(),
        contentType: "image/png",
        width: 1200,
        height: 800,
        animated: false,
      };
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/game/import" && init?.method === "POST") {
          return json(editing);
        }
        if (url === "/api/game/import/items") return json(annotating, 202);
        if (url === "/api/game/import/seal") return json(preparing, 202);
        throw new Error(`unexpected request ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderImport();
    const original = new File(["original"], "source.png", {
      type: "image/png",
    });
    const invalid = new File(["gif"], "broken.gif", { type: "image/gif" });

    await act(() => result.current.begin());
    await act(() => result.current.selectFiles([original, invalid]));

    expect(result.current.localInputs).toHaveLength(2);
    expect(result.current.localInputs[1]?.error).toMatch(/still png/i);
    const normalized = new Blob(["normalized"], { type: "image/png" });
    await act(() => result.current.approveCurrent(normalized));

    const upload = fetchMock.mock.calls.find(
      ([input]) => String(input) === "/api/game/import/items",
    );
    const body = upload?.[1]?.body as FormData;
    expect(body.get("image")).toBeInstanceOf(Blob);
    expect(body.get("image")).not.toBe(original);
    expect(body.get("sessionId")).toBe("import-session-1");
    expect(result.current.localInputs).toHaveLength(1);

    await act(() => result.current.removeCurrent());

    expect(result.current.localInputs).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/game/import/seal",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.current.status?.status).toBe("preparing");
  });

  it("keeps a duplicate normalized image open with the server conflict", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/game/import" && init?.method === "POST") {
          return json(status());
        }
        return json(
          {
            error:
              "That normalized image already exists as import item item-1.",
          },
          409,
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderImport();

    await act(() => result.current.begin());
    await act(() =>
      result.current.selectFiles([
        new File(["same"], "same.png", { type: "image/png" }),
      ]),
    );
    await act(() =>
      result.current.approveCurrent(
        new Blob(["normalized"], { type: "image/png" }),
      ),
    );

    expect(result.current.localInputs).toHaveLength(1);
    expect(result.current.currentInput?.error).toMatch(/already exists/i);
  });

  it("warns before unloading only while browser-only inputs are unresolved", async () => {
    const editing = status();
    const preparing = status({
      status: "preparing",
      sealedAt: "2026-08-10T12:01:00.000Z",
      initialFill: {
        pending: 0,
        ready: 0,
        failed: 1,
        failedAttemptId: "attempt-1",
        failureMessage: "Starter fill failed safely.",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === "/api/game/import/seal" && init?.method === "POST"
          ? json(preparing)
          : json(editing),
      ),
    );
    const { result } = renderImport();

    await act(() => result.current.begin());
    await act(() =>
      result.current.selectFiles([
        new File(["still-local"], "local.png", { type: "image/png" }),
      ]),
    );

    const protectedUnload = new Event("beforeunload", { cancelable: true });
    expect(window.dispatchEvent(protectedUnload)).toBe(false);
    expect(protectedUnload.defaultPrevented).toBe(true);

    await act(() => result.current.removeCurrent());

    const safeUnload = new Event("beforeunload", { cancelable: true });
    expect(window.dispatchEvent(safeUnload)).toBe(true);
    expect(safeUnload.defaultPrevented).toBe(false);
  });

  it("reuses the initial-fill request ID until retry succeeds", async () => {
    const failed = status({
      status: "preparing",
      sealedAt: "2026-08-10T12:01:00.000Z",
      initialFill: {
        pending: 0,
        ready: 2,
        failed: 1,
        failedAttemptId: "attempt-1",
        failureMessage: "Starter fill failed safely.",
      },
    });
    const pending = status({
      ...failed,
      initialFill: {
        pending: 3,
        ready: 2,
        failed: 0,
        failedAttemptId: null,
        failureMessage: null,
      },
    });
    const retryBodies: string[] = [];
    let retryCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") return json(failed);
        retryBodies.push(String(init?.body));
        retryCount += 1;
        if (retryCount === 1) throw new Error("temporary disconnect");
        return json(pending);
      }),
    );
    const { result } = renderImport();

    await act(() => result.current.begin());
    await act(() => result.current.retryInitialFill());
    await act(() => result.current.retryInitialFill());

    const first = JSON.parse(retryBodies[0]!) as { requestId: string };
    const second = JSON.parse(retryBodies[1]!) as { requestId: string };
    expect(first.requestId).toBe(second.requestId);
    expect(result.current.status?.initialFill.pending).toBe(3);
  });

  it("refreshes a stale initial-fill attempt without retrying its replacement", async () => {
    const failedAttempt = (attemptId: string) =>
      status({
        status: "preparing",
        sealedAt: "2026-08-10T12:01:00.000Z",
        initialFill: {
          pending: 0,
          ready: 2,
          failed: 1,
          failedAttemptId: attemptId,
          failureMessage: "Starter fill failed safely.",
        },
      });
    const retryBodies: Array<{
      failedAttemptId: string;
      requestId: string;
    }> = [];
    let patchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/game/import" && init?.method === "POST") {
          return json(failedAttempt("attempt-1"));
        }
        if (url.startsWith("/api/game/import?")) {
          return json(failedAttempt("attempt-2"));
        }
        if (init?.method === "PATCH") {
          patchCount += 1;
          retryBodies.push(JSON.parse(String(init.body)));
          if (patchCount === 1) {
            return json({ error: "That attempt is no longer current." }, 409);
          }
          return json(
            status({
              status: "preparing",
              sealedAt: "2026-08-10T12:01:00.000Z",
              initialFill: {
                pending: 3,
                ready: 2,
                failed: 0,
                failedAttemptId: null,
                failureMessage: null,
              },
            }),
          );
        }
        throw new Error(`unexpected request ${url}`);
      }),
    );
    const { result } = renderImport();

    await act(() => result.current.begin());
    await act(() => result.current.retryInitialFill());

    expect(patchCount).toBe(1);
    expect(result.current.status?.initialFill.failedAttemptId).toBe(
      "attempt-2",
    );
    expect(result.current.error).toMatch(/no longer current/i);

    await act(() => result.current.retryInitialFill());

    expect(patchCount).toBe(2);
    expect(retryBodies[1]?.failedAttemptId).toBe("attempt-2");
    expect(retryBodies[1]?.requestId).not.toBe(retryBodies[0]?.requestId);
  });

  it("preloads the activated comparison before committing and closing", async () => {
    let resolvePreload: (() => void) | undefined;
    preloadChangedAssets.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvePreload = resolve;
        }),
    );
    const activatedGame = structuredClone(game);
    activatedGame.round.leftCandidate.id = "imported-left";
    const active = status({
      status: "active",
      sealedAt: "2026-08-10T12:01:00.000Z",
      activatedAt: "2026-08-10T12:02:00.000Z",
      activationReady: 5,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === "/api/game/import" && init?.method === "POST"
          ? json(active)
          : json({ status: "ready", game: activatedGame }),
      ),
    );
    const commitStartState = vi.fn();
    const onActivated = vi.fn();
    const { result } = renderImport({ commitStartState, onActivated });

    let beginning: Promise<void> | undefined;
    act(() => {
      beginning = result.current.begin();
    });
    await waitFor(() => expect(preloadChangedAssets).toHaveBeenCalledOnce());
    expect(commitStartState).not.toHaveBeenCalled();

    resolvePreload?.();
    await act(() => beginning);

    expect(commitStartState).toHaveBeenCalledWith({
      status: "ready",
      game: activatedGame,
    });
    expect(onActivated).toHaveBeenCalledOnce();
  });
});
