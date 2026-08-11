// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageImportModal } from "./image-import-modal";
import type { useImageImport } from "./use-image-import";

type Controller = ReturnType<typeof useImageImport>;

const baseStatus: NonNullable<Controller["status"]> = {
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
};

function controller(overrides: Partial<Controller> = {}): Controller {
  return {
    abandon: vi.fn(async () => undefined),
    approveCurrent: vi.fn(async () => undefined),
    begin: vi.fn(async () => undefined),
    busy: false,
    canAbandon: true,
    canPause: false,
    currentIndex: 0,
    currentInput: null,
    dismiss: vi.fn(),
    error: null,
    hasSelectedFiles: false,
    localInputs: [],
    manualItem: vi.fn(async () => undefined),
    next: vi.fn(),
    pause: vi.fn(async () => undefined),
    previous: vi.fn(),
    refresh: vi.fn(async () => baseStatus),
    removeCurrent: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
    retryInitialFill: vi.fn(async () => undefined),
    retryItem: vi.fn(async () => undefined),
    seal: vi.fn(async () => undefined),
    selectFiles: vi.fn(async () => undefined),
    status: baseStatus,
    unresolved: false,
    ...overrides,
  };
}

afterEach(cleanup);

describe("ImageImportModal", () => {
  it("omits close and pause before sealing and requires confirmed abandon", () => {
    const value = controller();
    render(<ImageImportModal controller={value} />);

    expect(
      screen.queryByRole("button", { name: /close|pause/i }),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(value.dismiss).not.toHaveBeenCalled();
    expect(value.pause).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Abandon import" }));
    expect(value.abandon).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm abandon" }));
    expect(value.abandon).toHaveBeenCalledOnce();
  });

  it("allows a sealed import to close while server-owned work continues", () => {
    const value = controller({
      canPause: true,
      status: {
        ...baseStatus,
        status: "preparing",
        sealedAt: "2026-08-10T12:01:00.000Z",
        initialFill: {
          ...baseStatus.initialFill,
          pending: 5,
        },
      },
    });
    render(<ImageImportModal controller={value} />);

    fireEvent.click(screen.getByRole("button", { name: "Close / Pause" }));
    expect(value.pause).toHaveBeenCalledOnce();
  });

  it("renders display-safe failures with retry, manual annotation, and remove", () => {
    const failedItem = {
      id: "item-1",
      status: "failed" as const,
      asset: { url: "/api/assets/imported.png", width: 1024, height: 1024 },
      annotation: null,
      candidateId: null,
      failureMessage: "Automatic annotation failed safely.",
      approvedAt: "2026-08-10T12:00:00.000Z",
    };
    const value = controller({
      canPause: true,
      status: {
        ...baseStatus,
        status: "preparing",
        sealedAt: "2026-08-10T12:01:00.000Z",
        counts: { ...baseStatus.counts, total: 1, failed: 1 },
        items: [failedItem],
      },
    });
    render(<ImageImportModal controller={value} />);

    expect(
      screen.getByText("Automatic annotation failed safely."),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(value.retryItem).toHaveBeenCalledWith("item-1");
    fireEvent.click(screen.getByRole("button", { name: "Annotate manually" }));
    fireEvent.change(screen.getByLabelText("Concept"), {
      target: { value: "Violet atrium" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "A geometric atrium in violet window light" },
    });
    fireEvent.change(screen.getByLabelText("Style tags"), {
      target: { value: "editorial, geometric, editorial" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save annotation" }));
    expect(value.manualItem).toHaveBeenCalledWith("item-1", {
      concept: "Violet atrium",
      prompt: "A geometric atrium in violet window light",
      style: ["editorial", "geometric"],
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(value.removeItem).toHaveBeenCalledWith("item-1");
  });

  it("shows only the safe initial-fill message and one stable retry action", () => {
    const value = controller({
      canPause: true,
      status: {
        ...baseStatus,
        status: "preparing",
        sealedAt: "2026-08-10T12:01:00.000Z",
        initialFill: {
          pending: 0,
          ready: 2,
          failed: 1,
          failedAttemptId: "attempt-1",
          failureMessage: "Starter candidate generation failed safely.",
        },
      },
    });
    render(<ImageImportModal controller={value} />);

    expect(
      screen.getByText("Starter candidate generation failed safely."),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry initial fill" }));
    expect(value.retryInitialFill).toHaveBeenCalledOnce();
  });
});
