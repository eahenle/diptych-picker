import { describe, expect, it } from "vitest";
import {
  StateLockCoordinator,
  requireStateLocks,
  type StateRepositoryName,
} from "./state-lock-coordinator";

function harness() {
  const events: string[] = [];
  const repository = (name: StateRepositoryName) => ({
    async withLock<T>(operation: () => Promise<T>): Promise<T> {
      events.push(`enter:${name}`);
      try {
        return await operation();
      } finally {
        events.push(`exit:${name}`);
      }
    },
  });
  const coordinator = new StateLockCoordinator({
    activationIntent: repository("activation-intent"),
    importSession: repository("import-session"),
    game: repository("game"),
    challenger: repository("challenger"),
    initialBootstrap: repository("initial-bootstrap"),
  });
  return { coordinator, events };
}

describe("StateLockCoordinator", () => {
  it("acquires any requested subset in the one canonical order", async () => {
    const { coordinator, events } = harness();

    const result = await coordinator.withStateLocks(
      ["challenger", "activation-intent", "game", "import-session"],
      async (context) => {
        requireStateLocks(context, ["activation-intent", "import-session"]);
        events.push("operation");
        return 42;
      },
    );

    expect(result).toBe(42);
    expect(events).toEqual([
      "enter:activation-intent",
      "enter:import-session",
      "enter:game",
      "enter:challenger",
      "operation",
      "exit:challenger",
      "exit:game",
      "exit:import-session",
      "exit:activation-intent",
    ]);
  });

  it("does not acquire repositories outside the requested subset", async () => {
    const { coordinator, events } = harness();

    await coordinator.withStateLocks(["game"], async () => undefined);

    expect(events).toEqual(["enter:game", "exit:game"]);
  });

  it("rejects a helper call when its required lock is absent", async () => {
    const { coordinator } = harness();

    await expect(
      coordinator.withStateLocks(["game"], async (context) => {
        requireStateLocks(context, ["game", "challenger"]);
      }),
    ).rejects.toThrow("State lock challenger is required");
  });
});
