import { describe, expect, it } from "vitest";
import { gameFromSeedAssets, initialCandidateContext } from "./initial-state";

const NOW = "2026-07-16T12:00:00.000Z";

describe("initial state", () => {
  it("keeps seed metadata available while forced generation bypasses public assets", async () => {
    expect(initialCandidateContext(NOW).map(({ concept }) => concept)).toEqual([
      "Coastal radio observatory",
      "Crystal-grown synthesizer",
    ]);
    await expect(gameFromSeedAssets(NOW, true)).resolves.toBeNull();
  });
});
