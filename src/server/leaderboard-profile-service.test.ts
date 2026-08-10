import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CandidateRating,
  ChallengerState,
} from "@/domain/challenger-state";
import { FileGenerationMailbox } from "./agent-mailbox";
import { LeaderboardProfileService } from "./leaderboard-profile-service";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

function rating(id: string, value: number): CandidateRating {
  return {
    candidate: {
      id,
      imageUrl: `/api/assets/${id}.png`,
      prompt: `private ${id} prompt`,
      concept: `${id} concept`,
      style: [`${id} style`],
      createdAt: "2026-07-20T20:00:00.000Z",
      winCount: 0,
    },
    rating: value,
    wins: Math.max(0, Math.round((value - 900) / 20)),
    losses: Math.max(0, Math.round((1100 - value) / 20)),
    source: "generated",
    importItemId: null,
    poolMember: true,
    lastServedAt: null,
  };
}

function state(ratings: CandidateRating[]): ChallengerState {
  return {
    version: 1,
    sessionId: "session-1",
    ready: [],
    importQueue: [],
    refillJobs: [],
    pendingComparison: null,
    ratings,
    generationTurnaroundEmaMs: 1000,
    consecutiveFallbackDraws: 0,
    nextFallbackAt: null,
  };
}

describe("leaderboard profile service", () => {
  it("reuses source normalization for the top four pool images", async () => {
    const root = await mkdtemp(join(tmpdir(), "diptych-leaderboard-profile-"));
    roots.push(root);
    const mailbox = new FileGenerationMailbox(join(root, "agent-mailbox"));
    const png = await sharp({
      create: {
        width: 72,
        height: 72,
        channels: 3,
        background: "#713c89",
      },
    })
      .png()
      .toBuffer();
    const service = new LeaderboardProfileService({
      mailbox,
      sourceDirectory: join(root, "profile-sources"),
      readCandidateImage: async () => ({
        contents: png,
        contentType: "image/png",
      }),
    });
    const request = service.desired(
      state([
        rating("first", 1120),
        rating("second", 1100),
        rating("third", 1080),
        rating("fourth", 1060),
        rating("fifth", 1040),
      ]),
    );

    expect(request?.entries.map(({ candidate }) => candidate.id)).toEqual([
      "first",
      "second",
      "third",
      "fourth",
    ]);
    const job = await service.prepare(
      "leaderboard-job-1",
      "2026-07-20T20:01:00.000Z",
      request!,
    );
    expect(job).toMatchObject({
      kind: "leaderboard-profile",
      fingerprint: request?.fingerprint,
      sources: [
        { candidateId: "first", rank: 1 },
        { candidateId: "second", rank: 2 },
        { candidateId: "third", rank: 3 },
        { candidateId: "fourth", rank: 4 },
      ],
    });
    expect(
      new Set(job.sources.map(({ sourceImage }) => sourceImage.path)).size,
    ).toBe(1);
    const normalized = await readFile(
      join(root, job.sources[0].sourceImage.path),
    );
    expect((await sharp(normalized).metadata()).format).toBe("png");

    await service.enqueue(job);
    await expect(service.readWork(job.id)).resolves.toEqual(job);
  });

  it("fingerprints ordered leader identity rather than routine Elo movement", () => {
    const service = new LeaderboardProfileService({
      mailbox: {} as FileGenerationMailbox,
      sourceDirectory: "/unused",
      readCandidateImage: async () => {
        throw new Error("not used");
      },
    });
    const first = service.desired(
      state([rating("a", 1100), rating("b", 1080), rating("c", 1060)]),
    );
    const sameOrder = service.desired(
      state([rating("a", 1120), rating("b", 1090), rating("c", 1070)]),
    );
    const reordered = service.desired(
      state([rating("b", 1130), rating("a", 1120), rating("c", 1070)]),
    );

    expect(sameOrder?.fingerprint).toBe(first?.fingerprint);
    expect(reordered?.fingerprint).not.toBe(first?.fingerprint);
  });
});
