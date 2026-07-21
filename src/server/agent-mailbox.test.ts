import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileGenerationMailbox,
  generationJobSchema,
  type GenerationJob,
  type GenerationResult,
  type LeaderboardProfileJob,
} from "./agent-mailbox";

const job = (id = "job-1"): GenerationJob => ({
  id,
  kind: "challenger",
  createdAt: "2026-07-16T01:00:00.000Z",
  roundNumber: 3,
  winnerSide: "left",
  retainedWinner: {
    id: "left",
    imageUrl: "/api/assets/left.png",
    prompt: "forest observatory prompt",
    concept: "forest observatory",
    style: ["cinematic"],
    createdAt: "2026-07-16T00:00:00.000Z",
    winCount: 1,
  },
  rejectedCandidate: {
    id: "right",
    imageUrl: "/api/assets/right.png",
    prompt: "crystal synthesizer prompt",
    concept: "crystal synthesizer",
    style: ["macro"],
    createdAt: "2026-07-16T00:00:00.000Z",
    winCount: 0,
  },
  selectionHistory: [],
  recentConcepts: ["alien tidepool", "copper forge"],
  preferenceSeed: "industrial, gothic, natural, and surprising",
});

describe("generationJobSchema", () => {
  it("parses strict challenger and initial variants", () => {
    const challenger = job();
    const initial = {
      ...job("initial-left"),
      kind: "initial" as const,
      batchId: "batch-1",
      initialSide: "left" as const,
    };

    expect(generationJobSchema.parse(challenger)).toEqual(challenger);
    expect(generationJobSchema.parse(initial)).toEqual(initial);
    expect(() =>
      generationJobSchema.parse({ ...initial, initialSide: undefined }),
    ).toThrow();
    expect(() =>
      generationJobSchema.parse({ ...challenger, batchId: "not-allowed" }),
    ).toThrow();
  });

  it("normalizes a legacy missing kind to challenger", () => {
    const legacy: Record<string, unknown> = { ...job() };
    delete legacy.kind;

    expect(generationJobSchema.parse(legacy)).toEqual(job());
  });

  it("accepts bounded display-safe leaderboard evidence", () => {
    const withEvidence: GenerationJob = {
      ...job(),
      leaderboardEvidence: {
        poolSize: 2,
        entries: [
          {
            rank: 1,
            candidateId: "leader",
            concept: "Established pool leader",
            style: ["cinematic"],
            rating: 1088,
            wins: 7,
            losses: 2,
            source: "generated",
            favorite: true,
          },
        ],
      },
    };

    expect(generationJobSchema.parse(withEvidence)).toEqual(withEvidence);
    expect(() =>
      generationJobSchema.parse({
        ...withEvidence,
        leaderboardEvidence: {
          ...withEvidence.leaderboardEvidence,
          entries: [
            { ...withEvidence.leaderboardEvidence!.entries[0], rank: 3 },
          ],
        },
      }),
    ).toThrow(/ranks/i);
  });

  it("parses strict refill jobs with matching pinned winner metadata", () => {
    const baseJob = job("refill-1");
    const refill = {
      ...baseJob,
      kind: "refill" as const,
      sessionId: "session-1",
      pinnedWinnerId: baseJob.retainedWinner.id,
    };

    expect(generationJobSchema.parse(refill)).toEqual(refill);
    expect(() =>
      generationJobSchema.parse({
        ...refill,
        sessionMetadata: { source: "browser" },
      }),
    ).toThrow();
    expect(() =>
      generationJobSchema.parse({
        ...refill,
        pinnedWinnerId: baseJob.rejectedCandidate.id,
      }),
    ).toThrow(/pinnedWinnerId/i);
  });
});

type CompletedResult = Extract<GenerationResult, { status: "completed" }>;
type FailedResult = Extract<GenerationResult, { status: "failed" }>;

const success = (jobId = "job-1"): CompletedResult => ({
  jobId,
  status: "completed",
  completedAt: "2026-07-16T01:01:00.000Z",
  proposal: {
    concept: "paper automaton ballet",
    visualPrompt: "one square photograph of mechanical paper dancers",
    styleTags: ["paper craft", "warm daylight"],
    reasoningSummary: "Introduces warmth and craft.",
  },
  asset: {
    candidateId: "challenger-job-1",
    filename: "challenger-job-1.png",
    imageUrl: "/api/assets/challenger-job-1.png",
    contentType: "image/png",
    width: 1024,
    height: 1024,
    byteLength: 2048,
  },
});

const failure = (jobId = "job-1"): FailedResult => ({
  jobId,
  status: "failed",
  completedAt: "2026-07-16T01:01:00.000Z",
  message: "Image generation was interrupted",
  retryable: true,
});

const leaderboardProfileJob = (
  id = "leaderboard-profile-1",
): LeaderboardProfileJob => ({
  id,
  kind: "leaderboard-profile",
  createdAt: "2026-07-20T20:00:00.000Z",
  fingerprint: "b".repeat(64),
  sources: [1, 2].map((rank) => ({
    candidateId: `leader-${rank}`,
    rank,
    rating: 1120 - rank * 20,
    wins: 4 - rank,
    losses: rank,
    favorite: rank === 1,
    source: "generated" as const,
    concept: `leader ${rank} concept`,
    style: ["cinematic"],
    sourceImage: {
      filename: `${String(rank).repeat(64)}.png`,
      path: `profile-sources/${String(rank).repeat(64)}.png`,
      contentType: "image/png" as const,
      width: 100,
      height: 100,
      byteLength: 1024,
    },
  })),
});

async function mailboxRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "diptych-mailbox-"));
}

async function writeResult(
  root: string,
  result: GenerationResult,
): Promise<void> {
  const directory = result.status === "completed" ? "completed" : "failed";
  await mkdir(join(root, directory), { recursive: true });
  await writeFile(
    join(root, directory, `${result.jobId}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
}

async function writeRawResult(
  root: string,
  directory: "completed" | "failed",
  jobId: string,
  contents: unknown,
): Promise<void> {
  await mkdir(join(root, directory), { recursive: true });
  await writeFile(
    join(root, directory, `${jobId}.json`),
    typeof contents === "string"
      ? contents
      : `${JSON.stringify(contents, null, 2)}\n`,
    "utf8",
  );
}

describe("FileGenerationMailbox", () => {
  it("strictly persists leaderboard analysis work and its completed profile", async () => {
    const root = await mailboxRoot();
    const mailbox = new FileGenerationMailbox(root);
    const analysisJob = leaderboardProfileJob();
    await mailbox.enqueueLeaderboardProfile(analysisJob);

    await expect(
      mailbox.readLeaderboardProfileWork(analysisJob.id),
    ).resolves.toEqual(analysisJob);

    const result = {
      jobId: analysisJob.id,
      kind: "leaderboard-profile",
      status: "completed",
      completedAt: "2026-07-20T20:01:00.000Z",
      fingerprint: analysisJob.fingerprint,
      profile: {
        themes: "architectural portrait studies",
        inspiration: "diagonal light and low-angle framing",
        mediaTypes: "editorial photography",
        visualStyle: "dramatic and tactile",
        colorPalette: "violet and pale gold",
        contentLevel: "family-friendly",
        avoid: "logos and readable text",
      },
      reasoningSummary: "Shared traits across the strongest pool images.",
    };
    await writeRawResult(root, "completed", analysisJob.id, result);

    await expect(
      mailbox.readLeaderboardProfileResult(analysisJob.id),
    ).resolves.toEqual(result);
  });

  it("enqueues one durable job and restores it through a new mailbox instance", async () => {
    const root = await mailboxRoot();
    await new FileGenerationMailbox(root).enqueue(job());

    const restored = await new FileGenerationMailbox(root).readPending("job-1");

    expect(restored).toEqual(job());
    expect(await readdir(join(root, "pending"))).toEqual(["job-1.json"]);
  });

  it("rejects a duplicate pending job ID", async () => {
    const root = await mailboxRoot();
    const first = new FileGenerationMailbox(root);
    await first.enqueue(job());

    await expect(
      new FileGenerationMailbox(root).enqueue(job()),
    ).rejects.toThrow(/already exists/i);
    expect(await first.readPending("job-1")).toEqual(job());
  });

  it("allows exactly one of two concurrent enqueues for the same ID", async () => {
    const root = await mailboxRoot();

    const attempts = await Promise.allSettled([
      new FileGenerationMailbox(root).enqueue(job()),
      new FileGenerationMailbox(root).enqueue(job()),
    ]);

    expect(
      attempts.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    await expect(
      new FileGenerationMailbox(root).readPending("job-1"),
    ).resolves.toEqual(job());
  });

  it("recovers a fully written ID reservation left before pending publication", async () => {
    const root = await mailboxRoot();
    const idsDirectory = join(root, "ids");
    const reserved = {
      state: "reserved",
      job: job(),
      reservedBy: {
        pid: process.pid,
        token: "interrupted-enqueue",
        reservedAt: "2026-07-16T01:00:00.000Z",
      },
    };
    await mkdir(idsDirectory, { recursive: true });
    await writeFile(
      join(idsDirectory, "job-1.json"),
      `${JSON.stringify(reserved, null, 2)}\n`,
      "utf8",
    );

    await new FileGenerationMailbox(root).enqueue(job());

    await expect(
      new FileGenerationMailbox(root).readPending("job-1"),
    ).resolves.toEqual(job());
    expect(
      JSON.parse(await readFile(join(idsDirectory, "job-1.json"), "utf8")),
    ).toEqual(reserved);
    expect(await readdir(join(root, "pending"))).toEqual(["job-1.json"]);
  });

  it("reads active work without recreating a pending job", async () => {
    const root = await mailboxRoot();
    const mailbox = new FileGenerationMailbox(root);
    await mailbox.enqueue(job());
    await mkdir(join(root, "active"), { recursive: true });
    await rename(
      join(root, "pending", "job-1.json"),
      join(root, "active", "job-1.json"),
    );

    await expect(mailbox.readPending("job-1")).resolves.toBeNull();
    await expect(mailbox.readWork("job-1")).resolves.toEqual(job());
    await expect(
      access(join(root, "pending", "job-1.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(root, "active", "job-1.json"))).resolves.toBe(
      undefined,
    );
  });

  it("reads completed and failed terminal results without invoking a provider", async () => {
    const completedRoot = await mailboxRoot();
    const failedRoot = await mailboxRoot();
    await writeResult(completedRoot, success());
    await writeResult(failedRoot, failure());

    await expect(
      new FileGenerationMailbox(completedRoot).readResult("job-1"),
    ).resolves.toEqual(success());
    await expect(
      new FileGenerationMailbox(failedRoot).readResult("job-1"),
    ).resolves.toEqual(failure());
  });

  it("rejects malformed result JSON", async () => {
    const root = await mailboxRoot();
    await writeRawResult(root, "completed", "job-1", "{not-json\n");

    await expect(
      new FileGenerationMailbox(root).readResult("job-1"),
    ).rejects.toBeInstanceOf(SyntaxError);
  });

  it("rejects completed asset metadata that is not canonical for its candidate", async () => {
    const filenameRoot = await mailboxRoot();
    const urlRoot = await mailboxRoot();
    await writeRawResult(filenameRoot, "completed", "job-1", {
      ...success(),
      asset: { ...success().asset, filename: "another-candidate.png" },
    });
    await writeRawResult(urlRoot, "completed", "job-1", {
      ...success(),
      asset: { ...success().asset, imageUrl: "/api/assets/another.png" },
    });

    await expect(
      new FileGenerationMailbox(filenameRoot).readResult("job-1"),
    ).rejects.toThrow(/filename/i);
    await expect(
      new FileGenerationMailbox(urlRoot).readResult("job-1"),
    ).rejects.toThrow(/imageUrl/i);
  });

  it("rejects result records with mismatched IDs or invalid terminal strings", async () => {
    const idRoot = await mailboxRoot();
    const stringsRoot = await mailboxRoot();
    await writeRawResult(idRoot, "completed", "job-1", success("job-2"));
    await writeRawResult(stringsRoot, "failed", "job-1", {
      ...failure(),
      completedAt: "yesterday",
      message: "   ",
    });

    await expect(
      new FileGenerationMailbox(idRoot).readResult("job-1"),
    ).rejects.toThrow(/another job ID/i);
    await expect(
      new FileGenerationMailbox(stringsRoot).readResult("job-1"),
    ).rejects.toThrow();
  });

  it("archives pending and terminal artifacts after reconciliation", async () => {
    const root = await mailboxRoot();
    const mailbox = new FileGenerationMailbox(root);
    await mailbox.enqueue(job());
    await writeResult(root, success());
    await mkdir(join(root, "active"), { recursive: true });
    await writeFile(join(root, "active", "job-1.json"), "active\n", "utf8");
    await mkdir(join(root, "outcomes"), { recursive: true });
    await writeFile(join(root, "outcomes", "job-1.json"), "reserved\n", "utf8");

    await mailbox.archive("job-1");

    await expect(mailbox.readPending("job-1")).resolves.toBeNull();
    await expect(mailbox.readResult("job-1")).resolves.toBeNull();
    await expect(
      access(join(root, "active", "job-1.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(root, "outcomes", "job-1.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an archived ID tombstone and rejects replay", async () => {
    const root = await mailboxRoot();
    const mailbox = new FileGenerationMailbox(root);
    await mailbox.enqueue(job());
    await writeResult(root, success());
    await mailbox.archive("job-1");

    await expect(mailbox.enqueue(job())).rejects.toThrow(/already used/i);
    expect(
      JSON.parse(await readFile(join(root, "ids", "job-1.json"), "utf8")),
    ).toMatchObject({ state: "archived", job: { id: "job-1" } });
  });
});
