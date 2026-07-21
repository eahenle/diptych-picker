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
import { GameTransferModal } from "./game-transfer-modal";

afterEach(cleanup);

function renderTransfer(
  overrides: Partial<React.ComponentProps<typeof GameTransferModal>> = {},
) {
  const props: React.ComponentProps<typeof GameTransferModal> = {
    mode: "load",
    action: null,
    error: null,
    onClose: vi.fn(),
    onExport: vi.fn(),
    onImport: vi.fn(async () => undefined),
    onStartFresh: vi.fn(),
    ...overrides,
  };
  render(<GameTransferModal {...props} />);
  return props;
}

describe("GameTransferModal", () => {
  it("delegates load-game exports, file selection, and closing", async () => {
    const props = renderTransfer();
    expect(
      screen.getByRole("dialog", { name: "Load saved game" }),
    ).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: "Export current game first" }),
    );
    expect(props.onExport).toHaveBeenCalledTimes(1);

    const save = new File(["{}"], "game.json", {
      type: "application/json",
    });
    fireEvent.change(screen.getByLabelText("Choose saved game file"), {
      target: { files: [save] },
    });
    await waitFor(() => expect(props.onImport).toHaveBeenCalledWith(save));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("offers the new-game actions and reports errors", () => {
    const props = renderTransfer({
      mode: "new",
      error: "Save could not be restored",
    });
    expect(screen.getByRole("dialog", { name: "New game" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Save could not be restored",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Export current game" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start new game" }));
    expect(props.onExport).toHaveBeenCalledTimes(1);
    expect(props.onStartFresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["exporting", "Exporting…"],
    ["importing", "Loading…"],
    ["resetting", "Starting…"],
  ] as const)("locks the new-game dialog while %s", (action, label) => {
    const props = renderTransfer({ mode: "new", action });
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: label })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(props.onClose).not.toHaveBeenCalled();
  });
});
