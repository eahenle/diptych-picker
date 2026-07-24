// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GameRulesEditor } from "./game-rules-editor";

afterEach(cleanup);

const rules = {
  bufferTarget: 5,
  poolMaximum: 50,
  championRetirementStreak: 10,
  fallbackMaximumConsecutive: 10,
};

describe("GameRulesEditor", () => {
  it("edits all rules and applies one validated snapshot", async () => {
    const onSave = vi.fn(async () => true);
    render(
      <GameRulesEditor
        rules={rules}
        busy={false}
        error={null}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByText("Game rules"));
    fireEvent.change(screen.getByLabelText("Ready queue target"), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByLabelText("Reusable pool capacity"), {
      target: { value: "12" },
    });
    fireEvent.change(screen.getByLabelText("Champion streak limit"), {
      target: { value: "4" },
    });
    fireEvent.change(screen.getByLabelText("Fallback draw limit"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply rules" }));

    expect(onSave).toHaveBeenCalledWith({
      bufferTarget: 3,
      poolMaximum: 12,
      championRetirementStreak: 4,
      fallbackMaximumConsecutive: 2,
    });
  });

  it("blocks invalid and unchanged snapshots", () => {
    render(
      <GameRulesEditor
        rules={rules}
        busy={false}
        error={null}
        onSave={vi.fn(async () => true)}
      />,
    );
    fireEvent.click(screen.getByText("Game rules"));
    const apply = screen.getByRole("button", { name: "Apply rules" });
    expect(apply).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Champion streak limit"), {
      target: { value: "1" },
    });
    expect(apply).toBeDisabled();
  });
});
