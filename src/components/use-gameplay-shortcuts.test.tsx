// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useGameplayShortcuts } from "./use-gameplay-shortcuts";

afterEach(cleanup);

interface HarnessProps {
  suspended?: boolean;
  onSelect: (side: "left" | "right") => void;
  onTie: () => void;
  onBothLose: () => void;
}

function Harness({
  suspended = false,
  onSelect,
  onTie,
  onBothLose,
}: HarnessProps) {
  useGameplayShortcuts({ suspended, onSelect, onTie, onBothLose });

  return (
    <>
      <button type="button">Action button</button>
      <button type="button" onKeyDown={(event) => event.preventDefault()}>
        Handled button
      </button>
      <input aria-label="Text input" />
      <textarea aria-label="Text area" />
      <select aria-label="Select input">
        <option>Option</option>
      </select>
      <div contentEditable role="textbox" aria-label="Rich editor" />
    </>
  );
}

function handlers() {
  return {
    onSelect: vi.fn(),
    onTie: vi.fn(),
    onBothLose: vi.fn(),
  };
}

describe("useGameplayShortcuts", () => {
  it.each([
    ["a", "left"],
    ["A", "left"],
    ["1", "left"],
    ["b", "right"],
    ["2", "right"],
  ] as const)("maps %s to selection %s", (key, side) => {
    const callbacks = handlers();
    render(<Harness {...callbacks} />);

    fireEvent.keyDown(window, { key });

    expect(callbacks.onSelect).toHaveBeenCalledWith(side);
    expect(callbacks.onTie).not.toHaveBeenCalled();
    expect(callbacks.onBothLose).not.toHaveBeenCalled();
  });

  it.each([
    ["c", "tie"],
    ["3", "tie"],
    ["d", "both-lose"],
    ["4", "both-lose"],
  ] as const)("maps %s to %s", (key, command) => {
    const callbacks = handlers();
    render(<Harness {...callbacks} />);

    fireEvent.keyDown(window, { key });

    expect(callbacks.onSelect).not.toHaveBeenCalled();
    expect(callbacks.onTie).toHaveBeenCalledTimes(command === "tie" ? 1 : 0);
    expect(callbacks.onBothLose).toHaveBeenCalledTimes(
      command === "both-lose" ? 1 : 0,
    );
  });

  it("allows commands from a focused button", () => {
    const callbacks = handlers();
    render(<Harness {...callbacks} />);

    fireEvent.keyDown(screen.getByRole("button", { name: "Action button" }), {
      key: "a",
    });

    expect(callbacks.onSelect).toHaveBeenCalledWith("left");
  });

  it("respects a command already handled by the focused control", () => {
    const callbacks = handlers();
    render(<Harness {...callbacks} />);

    fireEvent.keyDown(screen.getByRole("button", { name: "Handled button" }), {
      key: "a",
    });

    expect(callbacks.onSelect).not.toHaveBeenCalled();
  });

  it.each(["Text input", "Text area", "Select input", "Rich editor"])(
    "ignores commands from %s",
    (name) => {
      const callbacks = handlers();
      render(<Harness {...callbacks} />);

      fireEvent.keyDown(screen.getByLabelText(name), { key: "a" });

      expect(callbacks.onSelect).not.toHaveBeenCalled();
    },
  );

  it("ignores commands while suspended", () => {
    const callbacks = handlers();
    render(<Harness {...callbacks} suspended />);

    fireEvent.keyDown(window, { key: "a" });

    expect(callbacks.onSelect).not.toHaveBeenCalled();
  });

  it.each([
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { repeat: true },
    { isComposing: true },
  ])("ignores modified, repeated, and composing commands: %o", (modifier) => {
    const callbacks = handlers();
    render(<Harness {...callbacks} />);

    fireEvent.keyDown(window, { key: "a", ...modifier });

    expect(callbacks.onSelect).not.toHaveBeenCalled();
  });
});
