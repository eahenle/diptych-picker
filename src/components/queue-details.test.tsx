// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueueDetails } from "./queue-details";

afterEach(cleanup);

describe("QueueDetails", () => {
  it("distinguishes active work from jobs waiting for a worker", () => {
    const onClose = vi.fn();
    render(
      <QueueDetails
        health={{
          ready: 0,
          inFlight: 5,
          active: 3,
          pending: 2,
          draining: 1,
          target: 5,
          pool: 30,
          poolMaximum: 50,
        }}
        onClose={onClose}
      />,
    );

    expect(screen.getByText("Generating now").nextSibling).toHaveTextContent(
      "3",
    );
    expect(
      screen.getByText("Waiting for a worker").nextSibling,
    ).toHaveTextContent("2");
    expect(screen.getByRole("status")).toHaveTextContent(
      "1 old-profile job is finishing",
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
