// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportSource } from "./import-image-file";
import { createInitialImportEditState } from "./import-image-transform";

const { renderNormalizedImport } = vi.hoisted(() => ({
  renderNormalizedImport: vi.fn(),
}));
vi.mock("./import-image-transform", async (loadOriginal) => ({
  ...(await loadOriginal<typeof import("./import-image-transform")>()),
  renderNormalizedImport,
}));

import { ImportImageEditor } from "./import-image-editor";

const context = {
  save: vi.fn(),
  restore: vi.fn(),
  fillRect: vi.fn(),
  translate: vi.fn(),
  rotate: vi.fn(),
  scale: vi.fn(),
  drawImage: vi.fn(),
  fillStyle: "",
};

function source(): ImportSource {
  return {
    file: new File(["image"], "landscape.png", { type: "image/png" }),
    bitmap: {
      width: 1600,
      height: 900,
      close: vi.fn(),
    } as unknown as ImageBitmap,
    contentType: "image/png",
    width: 1600,
    height: 900,
    animated: false,
  };
}

function ControlledEditor() {
  const [edit, setEdit] = useState(createInitialImportEditState);
  return (
    <ImportImageEditor
      source={source()}
      position={1}
      total={1}
      edit={edit}
      onEditChange={setEdit}
      onApprove={vi.fn()}
      onRemove={vi.fn()}
      onPrevious={vi.fn()}
      onNext={vi.fn()}
    />
  );
}

describe("ImportImageEditor", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    renderNormalizedImport.mockResolvedValue(
      new Blob(["normalized"], { type: "image/png" }),
    );
  });

  it("offers only per-image approval and removal", () => {
    render(
      <ImportImageEditor
        source={source()}
        position={1}
        total={2}
        edit={createInitialImportEditState()}
        onEditChange={vi.fn()}
        onApprove={vi.fn()}
        onRemove={vi.fn()}
        onPrevious={vi.fn()}
        onNext={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Approve image" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove image" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /all/i }),
    ).not.toBeInTheDocument();
  });

  it("locks crop-only controls and explains full visibility in fit mode", () => {
    render(<ControlledEditor />);

    fireEvent.click(screen.getByRole("radio", { name: "Fit full image" }));

    expect(screen.getByLabelText(/Zoom:/)).toBeDisabled();
    expect(screen.getByLabelText("Horizontal position")).toBeDisabled();
    expect(screen.getByLabelText("Vertical position")).toBeDisabled();
    expect(
      screen.getByText(/every rotated source pixel visible/i),
    ).toBeVisible();
    expect(screen.getByLabelText("Fit background")).toBeEnabled();
  });

  it("renders and approves exactly one normalized PNG", async () => {
    const onApprove = vi.fn();
    const value = source();
    render(
      <ImportImageEditor
        source={value}
        position={2}
        total={3}
        edit={createInitialImportEditState()}
        onEditChange={vi.fn()}
        onApprove={onApprove}
        onRemove={vi.fn()}
        onPrevious={vi.fn()}
        onNext={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve image" }));

    await vi.waitFor(() => expect(onApprove).toHaveBeenCalledOnce());
    expect(renderNormalizedImport).toHaveBeenCalledWith(
      value.bitmap,
      expect.objectContaining({ mode: "crop" }),
    );
    expect(onApprove).toHaveBeenCalledWith(expect.any(Blob));
  });

  it("disables navigation and mutations while an approval is pending", () => {
    render(
      <ImportImageEditor
        source={source()}
        position={2}
        total={3}
        busy
        edit={createInitialImportEditState()}
        onEditChange={vi.fn()}
        onApprove={vi.fn()}
        onRemove={vi.fn()}
        onPrevious={vi.fn()}
        onNext={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove image" })).toBeDisabled();
  });
});
