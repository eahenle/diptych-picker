// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ModalShell } from "./modal-shell";

afterEach(cleanup);

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open modal
      </button>
      {open ? (
        <ModalShell
          className="dialog"
          ariaLabel="Test modal"
          onClose={() => setOpen(false)}
        >
          <button type="button">First action</button>
          <button type="button">Last action</button>
        </ModalShell>
      ) : null}
    </>
  );
}

describe("ModalShell", () => {
  it("traps focus, closes with Escape, and restores its opener", () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open modal" });
    opener.focus();
    fireEvent.click(opener);
    const first = screen.getByRole("button", { name: "First action" });
    const last = screen.getByRole("button", { name: "Last action" });
    expect(first).toHaveFocus();

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.keyDown(last, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("closes only when the backdrop itself is pressed", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open modal" }));
    const dialog = screen.getByRole("dialog", { name: "Test modal" });
    fireEvent.mouseDown(dialog);
    expect(dialog).toBeVisible();
    fireEvent.mouseDown(dialog.parentElement!);
    expect(dialog).not.toBeInTheDocument();
  });
});
