import { afterEach, describe, expect, it, vi } from "vitest";

const originalProvider = process.env.GENERATION_PROVIDER;
const originalCoProcChannel = process.env.CO_PROC_GENERATION_CHANNEL;

describe("runtime generation provider", () => {
  afterEach(() => {
    vi.resetModules();
    if (originalProvider === undefined) {
      delete process.env.GENERATION_PROVIDER;
    } else {
      process.env.GENERATION_PROVIDER = originalProvider;
    }
    if (originalCoProcChannel === undefined) {
      delete process.env.CO_PROC_GENERATION_CHANNEL;
    } else {
      process.env.CO_PROC_GENERATION_CHANNEL = originalCoProcChannel;
    }
  });

  it.each([
    ["mock", "mock"],
    ["agent", "agent"],
    ["unexpected", "agent"],
  ] as const)(
    "reports %s configuration as %s",
    async (configured, expected) => {
      process.env.GENERATION_PROVIDER = configured;
      vi.resetModules();

      const { generationProvider } = await import("./runtime");

      expect(generationProvider).toBe(expected);
    },
  );

  it("wires a durable challenger repository", async () => {
    const { JsonChallengerRepository } =
      await import("./challenger-repository");
    const { challengerRepository } = await import("./runtime");

    expect(challengerRepository).toBeInstanceOf(JsonChallengerRepository);
  });

  it("adds co-proc notification behind the durable mailbox when configured", async () => {
    process.env.GENERATION_PROVIDER = "agent";
    process.env.CO_PROC_GENERATION_CHANNEL = "gen_a";
    vi.resetModules();

    const { TransportNotifyingGenerationMailbox } =
      await import("./co-proc-generation-transport");
    const { generationMailbox } = await import("./runtime");

    expect(generationMailbox).toBeInstanceOf(
      TransportNotifyingGenerationMailbox,
    );
  });
});
