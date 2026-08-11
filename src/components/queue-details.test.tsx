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

  it("shows imported supply and suppresses ordinary refill status until it drains", () => {
    render(
      <QueueDetails
        health={{
          ready: 0,
          inFlight: 0,
          active: 0,
          pending: 0,
          draining: 0,
          target: 5,
          pool: 30,
          poolMaximum: 50,
        }}
        importProgress={{
          status: "active",
          annotating: 1,
          ready: 3,
          failed: 1,
          unserved: 3,
          activationDisplayServed: 2,
          dequeueServed: 0,
          initialFillPending: 0,
          initialFillFailed: 0,
          initialFillAttemptId: null,
          initialFillFailureMessage: null,
          activationTarget: 5,
        }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "3 imported challengers waiting",
    );
    expect(
      screen.getByText("Imported images annotating").nextSibling,
    ).toHaveTextContent("1");
    expect(screen.queryByText("Generating now")).not.toBeInTheDocument();
    expect(screen.queryByText("Waiting for a worker")).not.toBeInTheDocument();
  });
});
