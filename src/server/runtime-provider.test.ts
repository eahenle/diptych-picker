import { afterEach, describe, expect, it, vi } from "vitest";

const originalProvider = process.env.GENERATION_PROVIDER;
const originalCoProcChannel = process.env.CO_PROC_GENERATION_CHANNEL;
const originalCoProcChannels = process.env.CO_PROC_GENERATION_CHANNELS;
const originalReadyTimeout = process.env.CO_PROC_GENERATION_READY_TIMEOUT_MS;
const originalAcknowledgementTimeout =
  process.env.CO_PROC_GENERATION_ACK_TIMEOUT_MS;
const originalLeaseDuration = process.env.CO_PROC_GENERATION_LEASE_MS;

function restoreEnvironment(
  name: string,
  originalValue: string | undefined,
): void {
  if (originalValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = originalValue;
  }
}

describe("runtime generation provider", () => {
  afterEach(() => {
    vi.resetModules();
    restoreEnvironment("GENERATION_PROVIDER", originalProvider);
    restoreEnvironment("CO_PROC_GENERATION_CHANNEL", originalCoProcChannel);
    restoreEnvironment("CO_PROC_GENERATION_CHANNELS", originalCoProcChannels);
    restoreEnvironment(
      "CO_PROC_GENERATION_READY_TIMEOUT_MS",
      originalReadyTimeout,
    );
    restoreEnvironment(
      "CO_PROC_GENERATION_ACK_TIMEOUT_MS",
      originalAcknowledgementTimeout,
    );
    restoreEnvironment("CO_PROC_GENERATION_LEASE_MS", originalLeaseDuration);
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

  it("accepts an acknowledged persistent generation channel pool", async () => {
    process.env.GENERATION_PROVIDER = "agent";
    process.env.CO_PROC_GENERATION_CHANNELS = "gen_a, gen_b, gen_c";
    process.env.CO_PROC_GENERATION_READY_TIMEOUT_MS = "125";
    process.env.CO_PROC_GENERATION_ACK_TIMEOUT_MS = "750";
    process.env.CO_PROC_GENERATION_LEASE_MS = "120000";
    vi.resetModules();

    const { TransportNotifyingGenerationMailbox } =
      await import("./co-proc-generation-transport");
    const { generationMailbox } = await import("./runtime");

    expect(generationMailbox).toBeInstanceOf(
      TransportNotifyingGenerationMailbox,
    );
  });

  it("rejects invalid persistent-channel timing configuration", async () => {
    process.env.GENERATION_PROVIDER = "agent";
    process.env.CO_PROC_GENERATION_CHANNELS = "gen_a";
    process.env.CO_PROC_GENERATION_READY_TIMEOUT_MS = "0";
    vi.resetModules();

    await expect(import("./runtime")).rejects.toThrow(
      /CO_PROC_GENERATION_READY_TIMEOUT_MS/,
    );
  });

  it("rejects an invalid persistent-worker lease duration", async () => {
    process.env.GENERATION_PROVIDER = "agent";
    process.env.CO_PROC_GENERATION_CHANNELS = "gen_a";
    process.env.CO_PROC_GENERATION_LEASE_MS = "9999";
    vi.resetModules();

    await expect(import("./runtime")).rejects.toThrow(
      /CO_PROC_GENERATION_LEASE_MS/,
    );
  });
});
