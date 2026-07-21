// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageInspector, type ImageInspectorState } from "./image-inspector";

afterEach(cleanup);

const candidates = [
  {
    id: "first",
    imageUrl: "/api/assets/first.png",
    concept: "First concept",
  },
  {
    id: "second",
    imageUrl: "/api/assets/second.png",
    concept: "Second concept",
  },
];

function Harness() {
  const [state, setState] = useState<ImageInspectorState | null>({
    candidates,
    index: 0,
    returnTarget: null,
  });
  if (!state) return <p>Inspector closed</p>;
  return (
    <ImageInspector
      state={state}
      onClose={() => setState(null)}
      onExplore={() => undefined}
      onNavigate={(direction) =>
        setState((current) =>
          current
            ? {
                ...current,
                index:
                  (current.index + direction + current.candidates.length) %
                  current.candidates.length,
              }
            : current,
        )
      }
    />
  );
}

describe("ImageInspector", () => {
  it("navigates by buttons and arrow keys, then closes with Escape", () => {
    render(<Harness />);

    expect(
      screen.getByRole("dialog", { name: "Expanded image: First concept" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Close expanded image" }),
    ).toHaveFocus();

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(
      screen.getByRole("dialog", { name: "Expanded image: Second concept" }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Next expanded image" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Expanded image: First concept" }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Previous expanded image" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Expanded image: Second concept" }),
    ).toBeVisible();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByText("Inspector closed")).toBeVisible();
  });

  it("omits navigation for a single candidate", () => {
    render(
      <ImageInspector
        state={{ candidates: [candidates[0]], index: 0, returnTarget: null }}
        onClose={() => undefined}
        onNavigate={() => undefined}
        onExplore={() => undefined}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Previous expanded image" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Next expanded image" }),
    ).not.toBeInTheDocument();
  });

  it("offers the inspected candidate as a variation source", () => {
    const onExplore = vi.fn();
    render(
      <ImageInspector
        state={{ candidates: [candidates[0]], index: 0, returnTarget: null }}
        onClose={() => undefined}
        onNavigate={() => undefined}
        onExplore={onExplore}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Explore variations" }));
    expect(onExplore).toHaveBeenCalledWith(candidates[0]);
  });

  it("shows preserved parent lineage", () => {
    render(
      <ImageInspector
        state={{
          candidates: [
            {
              ...candidates[0],
              lineage: {
                kind: "variation",
                parentCandidateId: "parent-1",
                parentConcept: "Copper parent",
                preferenceFingerprint: "a".repeat(64),
              },
            },
          ],
          index: 0,
          returnTarget: null,
        }}
        onClose={() => undefined}
        onNavigate={() => undefined}
        onExplore={() => undefined}
      />,
    );

    expect(screen.getByText("Variation of Copper parent")).toBeVisible();
  });
});
