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
import type { PreferenceProfile } from "@/domain/game";
import { PreferenceProfileModal } from "./preference-profile-modal";

afterEach(cleanup);

const profile: PreferenceProfile = {
  themes: "architectural portrait variations",
  inspiration: "diagonal window light",
  mediaTypes: "editorial photography",
  visualStyle: "dramatic and tactile",
  colorPalette: "violet and copper",
  contentLevel: "family-friendly",
  avoid: "readable text",
  adaptationMode: "static",
  adaptationStrength: "guided",
  adaptationLastDecision: 0,
  adaptationSourceWinnerIds: [],
  adaptationSourceRejectedIds: [],
};

function renderPreferences(
  overrides: Partial<React.ComponentProps<typeof PreferenceProfileModal>> = {},
) {
  const props: React.ComponentProps<typeof PreferenceProfileModal> = {
    profile,
    historyLength: 0,
    saving: false,
    saveQueued: false,
    sourceAnalyzing: false,
    sourceError: null,
    sourceSummary: null,
    variationSource: null,
    revisions: [],
    presets: [],
    presetSaving: false,
    presetError: null,
    promptDeck: undefined,
    promptDeckSaving: false,
    promptDeckError: null,
    selectionBoundWait: false,
    onClose: vi.fn(),
    onSave: vi.fn(),
    onAnalyzeSource: vi.fn(async () => undefined),
    onRestoreRevision: vi.fn(),
    onSavePreset: vi.fn(async () => true),
    onApplyPreset: vi.fn(),
    onDeletePreset: vi.fn(async () => undefined),
    onCreatePromptCard: vi.fn(async () => true),
    onUpdatePromptDeck: vi.fn(async () => undefined),
    onBlendPromptCards: vi.fn(async () => true),
    onFieldChange: vi.fn(),
    onFreedomChange: vi.fn(),
    ...overrides,
  };
  render(<PreferenceProfileModal {...props} />);
  return props;
}

describe("PreferenceProfileModal", () => {
  it("identifies a candidate-derived variation profile", () => {
    renderPreferences({
      variationSource: {
        candidateId: "parent-1",
        concept: "Copper parent",
      },
    });

    expect(screen.getByRole("status")).toHaveTextContent(
      "Exploring variations of Copper parent",
    );
    expect(screen.getByRole("status")).toHaveTextContent("parent lineage");
  });

  it("summarizes changed fields and restores a prior revision as a draft", () => {
    const props = renderPreferences({
      revisions: [
        {
          createdAt: "2026-07-20T10:00:00.000Z",
          source: "initial",
          profile,
        },
        {
          createdAt: "2026-07-21T10:00:00.000Z",
          source: "adaptive",
          profile: {
            ...profile,
            inspiration: "hard diagonal light",
            colorPalette: "crimson and copper",
          },
        },
      ],
    });

    fireEvent.click(screen.getByText("Revision history"));
    expect(screen.getByText("Model adaptation")).toBeVisible();
    expect(screen.getByText("Inspiration · Palette")).toBeVisible();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Restore frozen" })[0],
    );
    expect(props.onRestoreRevision).toHaveBeenCalledWith(
      props.revisions[1],
      true,
    );
  });

  it("saves, applies, and deletes named presets without applying them automatically", async () => {
    const props = renderPreferences({
      presets: [
        {
          id: "preset-1",
          name: "Copper nocturne",
          createdAt: "2026-07-20T10:00:00.000Z",
          updatedAt: "2026-07-21T10:00:00.000Z",
          profile,
        },
      ],
    });

    fireEvent.click(screen.getByText("Saved presets"));
    fireEvent.change(screen.getByLabelText("Preset name"), {
      target: { value: "Editorial violet" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save current draft" }));
    await waitFor(() =>
      expect(props.onSavePreset).toHaveBeenCalledWith("Editorial violet"),
    );
    expect(screen.getByLabelText("Preset name")).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
    expect(props.onApplyPreset).toHaveBeenCalledWith(props.presets[0]);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(props.onDeletePreset).toHaveBeenCalledWith("preset-1");
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it("delegates profile fields, freedom, source analysis, and actions", async () => {
    const props = renderPreferences();
    const slider = screen.getByRole("slider", {
      name: "Model rewrite freedom",
    });

    expect(slider).toHaveValue("0");
    expect(slider).toHaveAttribute("aria-valuetext", "Frozen");
    expect(slider.style.getPropertyValue("--adaptation-fill")).toBe("0%");
    fireEvent.change(slider, { target: { value: "2" } });
    expect(props.onFreedomChange).toHaveBeenCalledWith("unfettered");

    fireEvent.change(screen.getByLabelText("Themes & subjects"), {
      target: { value: "new themes with sufficient length" },
    });
    expect(props.onFieldChange).toHaveBeenCalledWith(
      "themes",
      "new themes with sufficient length",
    );
    fireEvent.click(screen.getByRole("radio", { name: /adult themes/i }));
    expect(props.onFieldChange).toHaveBeenCalledWith(
      "contentLevel",
      "adult-allowed",
    );

    const image = new File([new Uint8Array([1, 2, 3])], "reference.png", {
      type: "image/png",
    });
    fireEvent.change(screen.getByLabelText("Choose source image"), {
      target: { files: [image] },
    });
    await waitFor(() =>
      expect(props.onAnalyzeSource).toHaveBeenCalledWith(image),
    );

    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(props.onSave).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("shows adaptive evidence, cadence, and the queued-save animation", () => {
    renderPreferences({
      profile: {
        ...profile,
        adaptationMode: "adaptive",
        adaptationStrength: "guided",
        adaptationLastDecision: 2,
        adaptationSourceWinnerIds: ["winner"],
        adaptationSourceRejectedIds: ["rejected"],
      },
      historyLength: 5,
      saving: true,
      saveQueued: true,
      selectionBoundWait: true,
    });

    expect(
      screen.getByText(/Evidence — winners: 1; rejected: 1/),
    ).toBeVisible();
    expect(
      screen.getByRole("status", { name: "Preference rewrite cadence" }),
    ).toHaveTextContent("Next rewrite checkpoint in 12 rounds");
    expect(screen.getByText("Profile queued")).toBeVisible();
    expect(
      screen.getByText("Waiting for the challenger to arrive…"),
    ).toBeVisible();
    expect(screen.getByTestId("preference-save-spinner")).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Waiting…" })).toBeDisabled();
  });

  it.each([
    [{ sourceAnalyzing: true }, "Analyzing source image"],
    [{ sourceError: "Analysis failed" }, "Analysis failed"],
    [{ sourceSummary: "Transferred palette." }, "Profile populated for review"],
    [
      { selectionBoundWait: true },
      "Save now to apply these changes when the challenger arrives.",
    ],
  ] as const)("renders the status state %s", (overrides, message) => {
    renderPreferences(overrides);
    expect(screen.getByText(new RegExp(message))).toBeVisible();
  });
});
