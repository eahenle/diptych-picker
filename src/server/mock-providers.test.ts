import { describe, expect, it } from "vitest";
import { preferenceProfileFromSeed } from "@/domain/game";
import {
  MockChallengerPromptProvider,
  MockImageProvider,
} from "./mock-providers";

describe("mock providers", () => {
  it("avoids concepts present in the recent concept window", async () => {
    const provider = new MockChallengerPromptProvider();
    const proposal = await provider.propose({
      retainedWinner: {
        id: "a",
        imageUrl: "/a",
        prompt: "p",
        concept: "Rain observatory",
        style: [],
        createdAt: "now",
        winCount: 1,
      },
      rejectedCandidate: {
        id: "b",
        imageUrl: "/b",
        prompt: "p",
        concept: "Bioluminescent tidepool",
        style: [],
        createdAt: "now",
        winCount: 0,
      },
      selectionHistory: [],
      recentConcepts: ["Kinetic paper aviary", "Subterranean ceramic archive"],
      preferenceSeed: "novelty",
      preferenceProfile: preferenceProfileFromSeed("novelty"),
    });

    expect([
      "Kinetic paper aviary",
      "Subterranean ceramic archive",
    ]).not.toContain(proposal.concept);
    expect(proposal.visualPrompt).toContain("one standalone square image");
  });

  it("creates a deterministic standalone square PNG asset", async () => {
    const provider = new MockImageProvider();
    const image = await new MockImageProvider().generate(
      "an unusual engineering still life",
    );
    const repeated = await provider.generate(
      "an unusual engineering still life",
    );

    expect(image.width).toBe(1024);
    expect(image.height).toBe(1024);
    expect(image.extension).toBe("png");
    expect(image.contentType).toBe("image/png");
    expect(image.bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(repeated.bytes).toEqual(image.bytes);
  }, 15_000);

  it("bases adaptive revisions on durable leaderboard performance", async () => {
    const provider = new MockChallengerPromptProvider();
    const profile = {
      ...preferenceProfileFromSeed("novel engineered environments"),
      adaptationMode: "adaptive" as const,
      visualStyle: "detailed",
    };
    const proposal = await provider.propose({
      retainedWinner: {
        id: "recent",
        imageUrl: "/recent",
        prompt: "private",
        concept: "One-off recent winner",
        style: ["flat graphic"],
        createdAt: "now",
        winCount: 1,
      },
      rejectedCandidate: {
        id: "rejected",
        imageUrl: "/rejected",
        prompt: "private",
        concept: "Recent loser",
        style: [],
        createdAt: "now",
        winCount: 0,
      },
      selectionHistory: [
        {
          winnerId: "recent",
          loserId: "rejected",
          winnerPrompt: "private",
          loserPrompt: "private",
          winnerConcept: "One-off recent winner",
          loserConcept: "Recent loser",
          selectedAt: "now",
        },
      ],
      recentConcepts: [],
      leaderboardEvidence: {
        poolSize: 9,
        entries: [
          {
            rank: 1,
            candidateId: "durable-leader",
            concept: "Durable ceramic observatory",
            style: ["ceramic", "architectural"],
            rating: 1142,
            wins: 11,
            losses: 3,
            source: "generated",
            favorite: false,
          },
        ],
      },
      preferenceSeed: "novel engineered environments",
      preferenceProfile: profile,
    });

    expect(proposal.preferenceRevision).toMatchObject({
      inspiration: expect.stringContaining("Durable ceramic observatory"),
      visualStyle: "detailed, ceramic, architectural",
    });
    expect(proposal.preferenceRevision?.inspiration).not.toContain(
      "One-off recent winner",
    );
  });
});
