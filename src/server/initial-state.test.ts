import { describe, expect, it } from "vitest";
import {
  curatedManifestSchema,
  gameFromSeedAssets,
  initialCandidateContext,
  loadCuratedCandidates,
} from "./initial-state";

const NOW = "2026-07-16T12:00:00.000Z";

describe("initial state", () => {
  it("loads five distinct curated candidates", async () => {
    const candidates = await loadCuratedCandidates(NOW);
    expect(candidates).toHaveLength(5);
    expect(new Set(candidates.map(({ id }) => id)).size).toBe(5);
    expect(
      candidates.every(({ imageUrl }) => imageUrl.startsWith("/seed-assets/")),
    ).toBe(true);
  });

  it("rejects a manifest with missing candidates", () => {
    const candidate = {
      id: "seed-example",
      file: "example.png",
      prompt: "Example prompt",
      concept: "Example concept",
      style: ["example style"],
    };

    expect(() =>
      curatedManifestSchema.parse({
        candidates: Array.from({ length: 4 }, (_, index) => ({
          ...candidate,
          id: `${candidate.id}-${index}`,
          file: `example-${index}.png`,
        })),
      }),
    ).toThrow(/exactly five curated candidates/i);
  });

  it("rejects duplicate manifest candidates with an actionable error", () => {
    const candidates = Array.from({ length: 5 }, (_, index) => ({
      id: `seed-example-${index}`,
      file: `example-${index}.png`,
      prompt: "Example prompt",
      concept: "Example concept",
      style: ["example style"],
    }));
    candidates[4] = { ...candidates[0] };

    expect(() => curatedManifestSchema.parse({ candidates })).toThrow(
      /unique candidate ids/i,
    );
  });

  it("keeps seed metadata available while forced generation bypasses public assets", async () => {
    expect(initialCandidateContext(NOW).map(({ concept }) => concept)).toEqual([
      "Coastal radio observatory",
      "Crystal-grown synthesizer",
    ]);
    await expect(gameFromSeedAssets(NOW, true)).resolves.toBeNull();
  });
});
