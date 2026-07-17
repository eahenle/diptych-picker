import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENVIRONMENT_KEYS = [
  "CHALLENGER_BUFFER_SIZE",
  "CANDIDATE_POOL_SIZE",
  "CHALLENGER_INITIAL_TURNAROUND_MS",
  "CHALLENGER_FALLBACK_DELAY_MS",
  "CHALLENGER_FALLBACK_MAX_CONSECUTIVE",
];

async function loadConfig() {
  vi.resetModules();
  return (await import("./challenger-config")).challengerConfig;
}

describe("challengerConfig", () => {
  beforeEach(() => {
    for (const key of ENVIRONMENT_KEYS) vi.stubEnv(key, undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("exports the approved defaults", async () => {
    await expect(loadConfig()).resolves.toEqual({
      bufferTarget: 5,
      poolMaximum: 50,
      initialRating: 1000,
      eloKFactor: 32,
      turnaroundEmaAlpha: 0.25,
      initialTurnaroundMs: 300_000,
      fallbackDelayMs: 3_000,
      fallbackMaximumConsecutive: 10,
    });
  });

  it("accepts positive numeric environment overrides", async () => {
    vi.stubEnv("CHALLENGER_BUFFER_SIZE", "7");
    vi.stubEnv("CANDIDATE_POOL_SIZE", "75.5");

    await expect(loadConfig()).resolves.toMatchObject({
      bufferTarget: 7,
      poolMaximum: 75.5,
    });
  });

  it("accepts bounded fallback pacing overrides", async () => {
    vi.stubEnv("CHALLENGER_INITIAL_TURNAROUND_MS", "400");
    vi.stubEnv("CHALLENGER_FALLBACK_DELAY_MS", "200");
    vi.stubEnv("CHALLENGER_FALLBACK_MAX_CONSECUTIVE", "3");

    await expect(loadConfig()).resolves.toMatchObject({
      initialTurnaroundMs: 400,
      fallbackDelayMs: 200,
      fallbackMaximumConsecutive: 3,
    });
  });

  it.each(["0", "-1", "not-a-number", "Infinity", ""])(
    "rejects an invalid positive-number override of %j",
    async (value) => {
      vi.stubEnv("CHALLENGER_BUFFER_SIZE", value);

      await expect(loadConfig()).rejects.toThrow(/CHALLENGER_BUFFER_SIZE/);
    },
  );
});
