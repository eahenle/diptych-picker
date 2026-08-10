import { describe, expect, it } from "vitest";
import type { Candidate } from "@/domain/game";
import { createCandidateRating } from "./game-comparison";

const candidate: Candidate = {
  id: "candidate-1",
  imageUrl: "/api/assets/candidate-1.png",
  prompt: "candidate prompt",
  concept: "candidate concept",
  style: ["cinematic"],
  createdAt: "2026-08-09T20:00:00.000Z",
  winCount: 0,
};

describe("createCandidateRating", () => {
  it("rejects imported provenance without an import item ID", () => {
    expect(() =>
      createCandidateRating(candidate, "imported" as never, false, 1000),
    ).toThrow(/imported.*item|item.*imported/i);
  });
});
