import { afterEach, describe, expect, it, vi } from "vitest";

const originalProvider = process.env.GENERATION_PROVIDER;

describe("runtime generation provider", () => {
  afterEach(() => {
    vi.resetModules();
    if (originalProvider === undefined) {
      delete process.env.GENERATION_PROVIDER;
    } else {
      process.env.GENERATION_PROVIDER = originalProvider;
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
});
