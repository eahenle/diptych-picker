import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ImportSessionConflictError,
  ImportSessionNotFoundError,
} from "@/server/import-session-service";

const {
  abandonImportSession,
  approveImportItem,
  createOrResumeImportSession,
  getImportSessionStatus,
  manuallyAnnotateImportItem,
  pauseImportSession,
  removeImportItem,
  retryImportAnnotation,
  retryImportInitialFill,
  sealImportSession,
} = vi.hoisted(() => ({
  abandonImportSession: vi.fn(),
  approveImportItem: vi.fn(),
  createOrResumeImportSession: vi.fn(),
  getImportSessionStatus: vi.fn(),
  manuallyAnnotateImportItem: vi.fn(),
  pauseImportSession: vi.fn(),
  removeImportItem: vi.fn(),
  retryImportAnnotation: vi.fn(),
  retryImportInitialFill: vi.fn(),
  sealImportSession: vi.fn(),
}));

vi.mock("@/server/runtime", () => ({
  abandonImportSession,
  approveImportItem,
  createOrResumeImportSession,
  getImportSessionStatus,
  manuallyAnnotateImportItem,
  pauseImportSession,
  removeImportItem,
  retryImportAnnotation,
  retryImportInitialFill,
  sealImportSession,
}));

const status = {
  sessionId: "import-session-1",
  status: "editing",
  counts: {
    total: 0,
    annotating: 0,
    ready: 0,
    failed: 0,
    removed: 0,
    served: 0,
  },
};

beforeEach(() => {
  for (const fn of [
    abandonImportSession,
    approveImportItem,
    createOrResumeImportSession,
    getImportSessionStatus,
    manuallyAnnotateImportItem,
    pauseImportSession,
    removeImportItem,
    retryImportAnnotation,
    retryImportInitialFill,
    sealImportSession,
  ]) {
    fn.mockReset();
  }
  createOrResumeImportSession.mockResolvedValue(status);
  getImportSessionStatus.mockResolvedValue(status);
  approveImportItem.mockResolvedValue(status);
  manuallyAnnotateImportItem.mockResolvedValue(status);
  pauseImportSession.mockResolvedValue(status);
  removeImportItem.mockResolvedValue(status);
  retryImportAnnotation.mockResolvedValue(status);
  retryImportInitialFill.mockResolvedValue(status);
  sealImportSession.mockResolvedValue(status);
  abandonImportSession.mockResolvedValue(undefined);
});

describe("image import session routes", () => {
  it("creates or resumes one display-safe session", async () => {
    const { POST } = await import("./route");

    const response = await POST();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(status);
  });

  it("reads the expected session and maps missing state to 404", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost/api/game/import?sessionId=import-session-1",
      ),
    );

    expect(response.status).toBe(200);
    expect(getImportSessionStatus).toHaveBeenCalledWith("import-session-1");

    getImportSessionStatus.mockRejectedValueOnce(
      new ImportSessionNotFoundError("Import missing"),
    );
    const missing = await GET(
      new Request(
        "http://localhost/api/game/import?sessionId=import-session-2",
      ),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Import missing" });
  });

  it("approves exactly one normalized PNG through multipart input", async () => {
    const form = new FormData();
    form.set("sessionId", "import-session-1");
    form.set(
      "image",
      new File([Uint8Array.of(1, 2, 3)], "normalized.png", {
        type: "image/png",
      }),
    );
    const { POST } = await import("./items/route");

    const response = await POST(
      new Request("http://localhost/api/game/import/items", {
        method: "POST",
        body: form,
      }),
    );

    expect(response.status).toBe(202);
    expect(approveImportItem).toHaveBeenCalledWith(
      "import-session-1",
      Uint8Array.of(1, 2, 3),
    );
  });

  it("rejects non-PNG approvals before calling the service", async () => {
    const form = new FormData();
    form.set("sessionId", "import-session-1");
    form.set("image", new File(["jpeg"], "source.jpg", { type: "image/jpeg" }));
    const { POST } = await import("./items/route");

    const response = await POST(
      new Request("http://localhost/api/game/import/items", {
        method: "POST",
        body: form,
      }),
    );

    expect(response.status).toBe(400);
    expect(approveImportItem).not.toHaveBeenCalled();
  });

  it("supports retry, manual annotation, and removal with stale-safe IDs", async () => {
    const { PATCH } = await import("./items/[itemId]/route");
    const context = { params: Promise.resolve({ itemId: "item-1" }) };

    const retry = await PATCH(
      new Request("http://localhost", {
        method: "PATCH",
        body: JSON.stringify({
          action: "retry",
          sessionId: "import-session-1",
        }),
      }),
      context,
    );
    expect(retry.status).toBe(202);
    expect(retryImportAnnotation).toHaveBeenCalledWith(
      "import-session-1",
      "item-1",
    );

    const manual = await PATCH(
      new Request("http://localhost", {
        method: "PATCH",
        body: JSON.stringify({
          action: "manual",
          sessionId: "import-session-1",
          concept: "Manual concept",
          prompt: "Visible factual description",
          style: ["editorial", "low-key light"],
        }),
      }),
      context,
    );
    expect(manual.status).toBe(200);
    expect(manuallyAnnotateImportItem).toHaveBeenCalledWith(
      "import-session-1",
      "item-1",
      {
        concept: "Manual concept",
        prompt: "Visible factual description",
        style: ["editorial", "low-key light"],
      },
    );

    await PATCH(
      new Request("http://localhost", {
        method: "PATCH",
        body: JSON.stringify({
          action: "remove",
          sessionId: "import-session-1",
        }),
      }),
      context,
    );
    expect(removeImportItem).toHaveBeenCalledWith("import-session-1", "item-1");
  });

  it("seals, pauses, retries initial fill, and abandons by expected session ID", async () => {
    const { POST: seal } = await import("./seal/route");
    const sealed = await seal(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({ sessionId: "import-session-1" }),
      }),
    );
    expect(sealed.status).toBe(202);
    expect(sealImportSession).toHaveBeenCalledWith("import-session-1");

    const { PATCH, DELETE } = await import("./route");
    await PATCH(
      new Request("http://localhost", {
        method: "PATCH",
        body: JSON.stringify({
          action: "pause",
          sessionId: "import-session-1",
        }),
      }),
    );
    expect(pauseImportSession).toHaveBeenCalledWith("import-session-1");

    await PATCH(
      new Request("http://localhost", {
        method: "PATCH",
        body: JSON.stringify({
          action: "retry-initial-fill",
          sessionId: "import-session-1",
          failedAttemptId: "failed-attempt-1",
          requestId: "retry-request-1",
        }),
      }),
    );
    expect(retryImportInitialFill).toHaveBeenCalledWith(
      "import-session-1",
      "failed-attempt-1",
      "retry-request-1",
    );

    const abandoned = await DELETE(
      new Request("http://localhost", {
        method: "DELETE",
        body: JSON.stringify({ sessionId: "import-session-1" }),
      }),
    );
    expect(abandoned.status).toBe(204);
    expect(abandonImportSession).toHaveBeenCalledWith("import-session-1");
  });

  it("maps stale transitions to 409 without leaking internal state", async () => {
    pauseImportSession.mockRejectedValueOnce(
      new ImportSessionConflictError("Finish editing first"),
    );
    const { PATCH } = await import("./route");

    const response = await PATCH(
      new Request("http://localhost", {
        method: "PATCH",
        body: JSON.stringify({
          action: "pause",
          sessionId: "import-session-1",
        }),
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Finish editing first" });
  });
});
