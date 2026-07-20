import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptsDirectory = join(
  process.cwd(),
  ".agents",
  "skills",
  "run-diptych-picker",
  "scripts",
);

const job = (id: string) => ({
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

const initialJob = (
  id: string,
  batchId: string,
  initialSide: "left" | "right",
) => ({
  ...job(id),
  kind: "initial",
  batchId,
  initialSide,
});

const proposal = {
  concept: "paper automaton ballet",
  visualPrompt: "one square photograph of mechanical paper dancers",
  styleTags: ["paper craft", "warm daylight"],
  reasoningSummary: "Introduces warmth and craft.",
};

const preferenceRevision = {
  themes: "clearly adult alternative portrait studies",
  inspiration: "severe off-axis framing",
  mediaTypes: "large-format photography",
  visualStyle: "cinematic and tactile",
  colorPalette: "ultraviolet and oxblood",
  contentLevel: "adult-allowed",
  avoid: "readable text",
};

const adaptiveJob = (id: string) => ({
  ...job(id),
  preferenceProfile: {
    ...preferenceRevision,
    adaptationMode: "adaptive" as const,
    adaptationSourceWinnerIds: [],
  },
});

async function createDataDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "diptych-agent-scripts-"));
}

async function runScript(
  name: string,
  args: string[],
  localDataDirectory: string,
) {
  return execFileAsync(
    process.execPath,
    [join(scriptsDirectory, name), ...args],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        LOCAL_DATA_DIR: localDataDirectory,
      },
    },
  );
}

async function putJob(
  root: string,
  directory: "pending" | "active",
  value: { id: string },
): Promise<void> {
  const target = join(root, "agent-mailbox", directory);
  await mkdir(target, { recursive: true });
  await writeFile(
    join(target, `${value.id}.json`),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

async function writeWorkFile(
  root: string,
  id: string,
  filename: string,
  contents: string,
): Promise<string> {
  const directory = join(root, "agent-work", id);
  await mkdir(directory, { recursive: true });
  const path = join(directory, filename);
  await writeFile(path, contents, "utf8");
  return path;
}

async function proposalFile(root: string, id: string): Promise<string> {
  return writeWorkFile(
    root,
    id,
    "proposal.json",
    `${JSON.stringify(proposal)}\n`,
  );
}

async function customProposalFile(
  root: string,
  id: string,
  value: unknown,
): Promise<string> {
  return writeWorkFile(root, id, "proposal.json", `${JSON.stringify(value)}\n`);
}

async function expectNoCompletionArtifacts(
  root: string,
  id: string,
): Promise<void> {
  await expect(readdir(join(root, "assets"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(readdir(join(root, "exports"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await Promise.all(
    [
      join(root, "agent-mailbox", "outcomes", `${id}.json`),
      join(root, "agent-mailbox", "completed", `${id}.json`),
    ].map((path) =>
      expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" }),
    ),
  );
}

async function messageFile(root: string, id: string): Promise<string> {
  return writeWorkFile(
    root,
    id,
    "failure.txt",
    "Image generation was interrupted\n",
  );
}

async function squareImage(
  root: string,
  id: string,
): Promise<{ path: string; bytes: Buffer }> {
  const directory = join(root, "agent-work", id);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "generated.png");
  const bytes = await sharp({
    create: { width: 32, height: 32, channels: 4, background: "#8a4fff" },
  })
    .png()
    .toBuffer();
  await writeFile(path, bytes);
  return { path, bytes };
}

describe("agent mailbox scripts", () => {
  it("atomically claims distinct pending jobs into active", async () => {
    const root = await createDataDirectory();
    await Promise.all(
      [job("job-1"), job("job-2")].map((value) =>
        putJob(root, "pending", value),
      ),
    );

    const claims = await Promise.all([
      runScript("next-job.mjs", ["--wait-ms", "0"], root),
      runScript("next-job.mjs", ["--wait-ms", "0"], root),
    ]);

    expect(claims.map(({ stdout }) => JSON.parse(stdout).id).sort()).toEqual([
      "job-1",
      "job-2",
    ]);
  });

  it("claims pending work without duplicating an already active job", async () => {
    const root = await createDataDirectory();
    await putJob(root, "active", job("job-active"));
    await putJob(root, "pending", job("job-pending"));

    const { stdout } = await runScript(
      "next-job.mjs",
      ["--wait-ms", "0"],
      root,
    );

    expect(JSON.parse(stdout).id).toBe("job-pending");
  });

  it("resumes active work before claiming a pending job in explicit restart mode", async () => {
    const root = await createDataDirectory();
    await putJob(root, "active", job("job-active"));
    await putJob(root, "pending", job("job-pending"));

    const { stdout } = await runScript(
      "next-job.mjs",
      ["--resume", "--wait-ms", "0"],
      root,
    );

    expect(JSON.parse(stdout).id).toBe("job-active");
    await expect(
      readFile(
        join(root, "agent-mailbox", "pending", "job-pending.json"),
        "utf8",
      ),
    ).resolves.toContain('"id": "job-pending"');
  });

  it("claims both sides of one initial batch before workers are spawned", async () => {
    const root = await createDataDirectory();
    await putJob(root, "pending", initialJob("z-left", "batch-1", "left"));
    await putJob(root, "pending", initialJob("a-right", "batch-1", "right"));

    const first = await runScript("next-job.mjs", ["--wait-ms", "0"], root);
    const firstClaim = JSON.parse(first.stdout);
    const partner = await runScript(
      "next-job.mjs",
      [
        "--wait-ms",
        "0",
        "--batch",
        "batch-1",
        "--owner-token",
        firstClaim.batchOwnerToken,
      ],
      root,
    );

    expect(firstClaim).toMatchObject({
      kind: "initial",
      batchId: "batch-1",
      initialSide: "left",
      batchOwnerToken: expect.any(String),
    });
    expect(JSON.parse(partner.stdout)).toMatchObject({
      kind: "initial",
      batchId: "batch-1",
      initialSide: "right",
      batchOwnerToken: firstClaim.batchOwnerToken,
    });
  });

  it("gives only one concurrent coordinator ownership of an initial batch", async () => {
    for (let round = 0; round < 4; round += 1) {
      const root = await createDataDirectory();
      const batchId = `batch-race-${round}`;
      await putJob(root, "pending", initialJob("z-left", batchId, "left"));
      await putJob(root, "pending", initialJob("a-right", batchId, "right"));

      const claims = await Promise.all(
        Array.from({ length: 12 }, () =>
          runScript("next-job.mjs", ["--wait-ms", "0"], root),
        ),
      );
      const claimed = claims
        .map(({ stdout }) => stdout.trim())
        .filter(Boolean)
        .map((stdout) => JSON.parse(stdout));

      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toMatchObject({
        kind: "initial",
        batchId,
        initialSide: "left",
        batchOwnerToken: expect.any(String),
      });
      expect(await readdir(join(root, "agent-mailbox", "pending"))).toEqual([
        "a-right.json",
      ]);

      const partner = await runScript(
        "next-job.mjs",
        [
          "--wait-ms",
          "0",
          "--batch",
          batchId,
          "--owner-token",
          claimed[0].batchOwnerToken,
        ],
        root,
      );
      expect(JSON.parse(partner.stdout)).toMatchObject({
        id: "a-right",
        initialSide: "right",
      });
    }
  });

  it("requires the current batch owner token to inspect or claim a partner", async () => {
    const root = await createDataDirectory();
    await putJob(root, "pending", initialJob("left", "batch-token", "left"));
    await putJob(root, "pending", initialJob("right", "batch-token", "right"));

    const first = JSON.parse(
      (await runScript("next-job.mjs", ["--wait-ms", "0"], root)).stdout,
    );

    await expect(
      runScript(
        "next-job.mjs",
        ["--wait-ms", "0", "--batch", "batch-token"],
        root,
      ),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/owner-token/i) });
    await expect(
      runScript(
        "next-job.mjs",
        [
          "--wait-ms",
          "0",
          "--batch",
          "batch-token",
          "--owner-token",
          "another-token",
        ],
        root,
      ),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/owner token/i) });

    const ordinary = await runScript("next-job.mjs", ["--wait-ms", "0"], root);
    expect(ordinary.stdout).toBe("");
    expect(first.batchOwnerToken).toEqual(expect.any(String));
  });

  it("keeps polling an owned batch and claims a partner enqueued after an empty poll", async () => {
    const root = await createDataDirectory();
    const batchId = "batch-delayed";
    await putJob(root, "pending", initialJob("left", batchId, "left"));
    const first = JSON.parse(
      (await runScript("next-job.mjs", ["--wait-ms", "0"], root)).stdout,
    );
    const ownedArgs = [
      "--batch",
      batchId,
      "--owner-token",
      first.batchOwnerToken,
    ];

    const empty = await runScript(
      "next-job.mjs",
      ["--wait-ms", "0", ...ownedArgs],
      root,
    );
    expect(empty.stdout).toBe("");

    const delayedPartner = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        putJob(root, "pending", initialJob("right", batchId, "right")).then(
          resolve,
          reject,
        );
      }, 75);
    });
    const partner = await runScript(
      "next-job.mjs",
      ["--wait-ms", "1000", ...ownedArgs],
      root,
    );
    await delayedPartner;

    expect(JSON.parse(partner.stdout)).toMatchObject({
      id: "right",
      initialSide: "right",
      batchOwnerToken: first.batchOwnerToken,
    });

    const skill = await readFile(
      join(
        process.cwd(),
        ".agents",
        "skills",
        "run-diptych-picker",
        "SKILL.md",
      ),
      "utf8",
    );
    expect(skill).toContain("Keep repeating this owned batch command");
    expect(skill).toContain(
      "Do not return to ordinary polling while an owned initial partner is pending.",
    );
  });

  it("recovers batch ownership and reports a terminal partner on restart", async () => {
    const root = await createDataDirectory();
    await putJob(root, "pending", initialJob("left", "batch-restart", "left"));
    await putJob(
      root,
      "pending",
      initialJob("right", "batch-restart", "right"),
    );
    const first = JSON.parse(
      (await runScript("next-job.mjs", ["--wait-ms", "0"], root)).stdout,
    );
    await runScript(
      "next-job.mjs",
      [
        "--wait-ms",
        "0",
        "--batch",
        "batch-restart",
        "--owner-token",
        first.batchOwnerToken,
      ],
      root,
    );

    const image = await squareImage(root, "left");
    const proposalPath = await proposalFile(root, "left");
    await runScript(
      "complete-job.mjs",
      ["--job", "left", "--proposal-file", proposalPath, "--image", image.path],
      root,
    );

    const resumed = JSON.parse(
      (await runScript("next-job.mjs", ["--resume", "--wait-ms", "0"], root))
        .stdout,
    );
    expect(resumed).toMatchObject({
      id: "right",
      batchOwnerToken: first.batchOwnerToken,
    });

    const terminalPartner = JSON.parse(
      (
        await runScript(
          "next-job.mjs",
          [
            "--wait-ms",
            "0",
            "--batch",
            "batch-restart",
            "--owner-token",
            resumed.batchOwnerToken,
          ],
          root,
        )
      ).stdout,
    );
    expect(terminalPartner).toMatchObject({
      id: "left",
      initialSide: "left",
      terminalStatus: "completed",
      batchOwnerToken: resumed.batchOwnerToken,
    });
  });

  it("fully decodes a square PNG, creates an immutable asset, and idempotently completes", async () => {
    const root = await createDataDirectory();
    await putJob(root, "active", job("job-1"));
    const image = await squareImage(root, "job-1");
    const proposalPath = await proposalFile(root, "job-1");
    const args = [
      "--job",
      "job-1",
      "--proposal-file",
      proposalPath,
      "--image",
      image.path,
    ];

    const first = await runScript("complete-job.mjs", args, root);
    const retry = await runScript("complete-job.mjs", args, root);

    const filename = `${createHash("sha256").update(image.bytes).digest("hex")}.png`;
    const assetPath = join(root, "assets", filename);
    await expect(readFile(assetPath)).resolves.toEqual(image.bytes);
    await expect(readFile(join(root, "exports", filename))).resolves.toEqual(
      image.bytes,
    );
    expect(JSON.parse(retry.stdout)).toEqual(JSON.parse(first.stdout));
    const result = JSON.parse(
      await readFile(
        join(root, "agent-mailbox", "completed", "job-1.json"),
        "utf8",
      ),
    );
    expect(result).toMatchObject({
      jobId: "job-1",
      status: "completed",
      proposal,
      asset: {
        candidateId: "challenger-job-1",
        filename,
        imageUrl: `/api/assets/${filename}`,
        contentType: "image/png",
        width: 32,
        height: 32,
        byteLength: image.bytes.byteLength,
      },
    });
  });

  it("trims every proposal string before publishing", async () => {
    const root = await createDataDirectory();
    await putJob(root, "active", job("job-trimmed"));
    const image = await squareImage(root, "job-trimmed");
    const proposalPath = await customProposalFile(root, "job-trimmed", {
      concept: "  paper automaton ballet  ",
      visualPrompt: "  one square photograph of mechanical paper dancers  ",
      styleTags: ["  paper craft", "warm daylight  "],
      reasoningSummary: "  Introduces warmth and craft.  ",
    });

    const completed = JSON.parse(
      (
        await runScript(
          "complete-job.mjs",
          [
            "--job",
            "job-trimmed",
            "--proposal-file",
            proposalPath,
            "--image",
            image.path,
          ],
          root,
        )
      ).stdout,
    );

    expect(completed.proposal).toEqual(proposal);
  });

  it("publishes a complete adaptive preference revision", async () => {
    const root = await createDataDirectory();
    await putJob(root, "active", adaptiveJob("job-adaptive"));
    const image = await squareImage(root, "job-adaptive");
    const proposalPath = await customProposalFile(root, "job-adaptive", {
      ...proposal,
      preferenceRevision,
    });

    const completed = JSON.parse(
      (
        await runScript(
          "complete-job.mjs",
          [
            "--job",
            "job-adaptive",
            "--proposal-file",
            proposalPath,
            "--image",
            image.path,
          ],
          root,
        )
      ).stdout,
    );

    expect(completed.proposal.preferenceRevision).toEqual(preferenceRevision);
  });

  it("rejects a partial adaptive preference revision", async () => {
    const root = await createDataDirectory();
    await putJob(root, "active", adaptiveJob("job-partial-profile"));
    const image = await squareImage(root, "job-partial-profile");
    const proposalPath = await customProposalFile(root, "job-partial-profile", {
      ...proposal,
      preferenceRevision: { themes: preferenceRevision.themes },
    });

    await expect(
      runScript(
        "complete-job.mjs",
        [
          "--job",
          "job-partial-profile",
          "--proposal-file",
          proposalPath,
          "--image",
          image.path,
        ],
        root,
      ),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/invalid_type/i) });
    await expectNoCompletionArtifacts(root, "job-partial-profile");
  });

  it("rejects a preference revision for a Static job", async () => {
    const root = await createDataDirectory();
    await putJob(root, "active", job("job-static-profile"));
    const image = await squareImage(root, "job-static-profile");
    const proposalPath = await customProposalFile(root, "job-static-profile", {
      ...proposal,
      preferenceRevision,
    });

    await expect(
      runScript(
        "complete-job.mjs",
        [
          "--job",
          "job-static-profile",
          "--proposal-file",
          proposalPath,
          "--image",
          image.path,
        ],
        root,
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/Static jobs must omit/i),
    });
    await expectNoCompletionArtifacts(root, "job-static-profile");
  });

  it("rejects an Adaptive job without a preference revision", async () => {
    const root = await createDataDirectory();
    await putJob(root, "active", adaptiveJob("job-adaptive-missing-profile"));
    const image = await squareImage(root, "job-adaptive-missing-profile");
    const proposalPath = await customProposalFile(
      root,
      "job-adaptive-missing-profile",
      proposal,
    );

    await expect(
      runScript(
        "complete-job.mjs",
        [
          "--job",
          "job-adaptive-missing-profile",
          "--proposal-file",
          proposalPath,
          "--image",
          image.path,
        ],
        root,
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/Adaptive jobs require/i),
    });
    await expectNoCompletionArtifacts(root, "job-adaptive-missing-profile");
  });

  it.each([
    ["concept", { ...proposal, concept: " \t\n " }],
    ["visualPrompt", { ...proposal, visualPrompt: " \t\n " }],
    ["styleTags", { ...proposal, styleTags: ["paper craft", " \t\n "] }],
    ["reasoningSummary", { ...proposal, reasoningSummary: " \t\n " }],
  ])(
    "rejects a whitespace-only %s without publishing completion artifacts",
    async (_field, invalidProposal) => {
      const root = await createDataDirectory();
      const id = `job-blank-${_field}`;
      await putJob(root, "active", job(id));
      const image = await squareImage(root, id);
      const proposalPath = await customProposalFile(root, id, invalidProposal);

      await expect(
        runScript(
          "complete-job.mjs",
          ["--job", id, "--proposal-file", proposalPath, "--image", image.path],
          root,
        ),
      ).rejects.toMatchObject({ stderr: expect.stringMatching(/too small/i) });
      await expectNoCompletionArtifacts(root, id);
    },
  );

  it("documents an agent-forced normal startup while tests remain explicitly mock", async () => {
    const skill = await readFile(
      join(
        process.cwd(),
        ".agents",
        "skills",
        "run-diptych-picker",
        "SKILL.md",
      ),
      "utf8",
    );
    const playwrightConfig = await readFile(
      join(process.cwd(), "playwright.config.ts"),
      "utf8",
    );

    expect(skill).toContain("GENERATION_PROVIDER=agent npm run dev");
    expect(skill).toContain("X-Diptych-Generation-Provider");
    expect(skill).toContain("Refuse to reuse a server reporting `mock`");
    expect(playwrightConfig).toContain('GENERATION_PROVIDER: "mock"');
  });

  it("documents preference guidance as authoritative for image workers", async () => {
    const skill = await readFile(
      join(
        process.cwd(),
        ".agents",
        "skills",
        "run-diptych-picker",
        "SKILL.md",
      ),
      "utf8",
    );
    const protocol = await readFile(
      join(
        process.cwd(),
        ".agents",
        "skills",
        "run-diptych-picker",
        "references",
        "job-protocol.md",
      ),
      "utf8",
    );

    expect(skill).toContain(
      "Treat `preferenceSeed` as the authoritative creative brief",
    );
    expect(skill).toContain(
      "Retained-winner metadata, rejected-candidate metadata, history, and recent concepts are secondary",
    );
    expect(protocol).toContain(
      "The preference seed is the authoritative creative brief",
    );
  });

  it("resumes completion after a crash left the outcome and matching asset", async () => {
    const root = await createDataDirectory();
    await putJob(root, "active", job("job-resume"));
    const image = await squareImage(root, "job-resume");
    const filename = `${createHash("sha256").update(image.bytes).digest("hex")}.png`;
    const proposalPath = await proposalFile(root, "job-resume");
    await mkdir(join(root, "agent-mailbox", "outcomes"), { recursive: true });
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(
      join(root, "agent-mailbox", "outcomes", "job-resume.json"),
      `${JSON.stringify({ jobId: "job-resume", outcome: "completed" })}\n`,
    );
    await writeFile(join(root, "assets", filename), image.bytes);

    await runScript(
      "complete-job.mjs",
      [
        "--job",
        "job-resume",
        "--proposal-file",
        proposalPath,
        "--image",
        image.path,
      ],
      root,
    );

    await expect(
      readFile(
        join(root, "agent-mailbox", "completed", "job-resume.json"),
        "utf8",
      ),
    ).resolves.toContain('"status": "completed"');
  });

  it("never overwrites a differing asset while resuming completion", async () => {
    const root = await createDataDirectory();
    await putJob(root, "active", job("job-conflict"));
    const image = await squareImage(root, "job-conflict");
    const proposalPath = await proposalFile(root, "job-conflict");
    const filename = `${createHash("sha256").update(image.bytes).digest("hex")}.png`;
    const assetPath = join(root, "assets", filename);
    const existing = Buffer.from("different immutable bytes");
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(assetPath, existing);

    await expect(
      runScript(
        "complete-job.mjs",
        [
          "--job",
          "job-conflict",
          "--proposal-file",
          proposalPath,
          "--image",
          image.path,
        ],
        root,
      ),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/differ/i) });
    await expect(readFile(assetPath)).resolves.toEqual(existing);
  });

  it("publishes only the atomically reserved outcome in a complete/fail race", async () => {
    const root = await createDataDirectory();
    await putJob(root, "active", job("job-race"));
    const image = await squareImage(root, "job-race");
    const proposalPath = await proposalFile(root, "job-race");
    const failurePath = await messageFile(root, "job-race");

    const attempts = await Promise.allSettled([
      runScript(
        "complete-job.mjs",
        [
          "--job",
          "job-race",
          "--proposal-file",
          proposalPath,
          "--image",
          image.path,
        ],
        root,
      ),
      runScript(
        "fail-job.mjs",
        ["--job", "job-race", "--message-file", failurePath],
        root,
      ),
    ]);

    expect(
      attempts.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    const outcome = JSON.parse(
      await readFile(
        join(root, "agent-mailbox", "outcomes", "job-race.json"),
        "utf8",
      ),
    );
    const terminalPaths = ["completed", "failed"].map((directory) =>
      readFile(
        join(root, "agent-mailbox", directory, "job-race.json"),
        "utf8",
      ).then(
        () => directory,
        () => null,
      ),
    );
    expect((await Promise.all(terminalPaths)).filter(Boolean)).toEqual([
      outcome.outcome,
    ]);
  });

  it("rejects a rectangular PNG without creating an asset or result", async () => {
    const root = await createDataDirectory();
    await putJob(root, "active", job("job-wide"));
    const imagePath = join(root, "wide.png");
    const proposalPath = await proposalFile(root, "job-wide");
    await sharp({
      create: { width: 48, height: 24, channels: 3, background: "#ffffff" },
    })
      .png()
      .toFile(imagePath);

    await expect(
      runScript(
        "complete-job.mjs",
        [
          "--job",
          "job-wide",
          "--proposal-file",
          proposalPath,
          "--image",
          imagePath,
        ],
        root,
      ),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/square/i) });
    await expect(
      readFile(join(root, "assets", "challenger-job-wide.png")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects PNG input larger than 50 MB before asset creation", async () => {
    const root = await createDataDirectory();
    await putJob(root, "active", job("job-huge"));
    const proposalPath = await proposalFile(root, "job-huge");
    const imagePath = join(root, "huge.png");
    await writeFile(imagePath, Buffer.alloc(50 * 1024 * 1024 + 1));

    await expect(
      runScript(
        "complete-job.mjs",
        [
          "--job",
          "job-huge",
          "--proposal-file",
          proposalPath,
          "--image",
          imagePath,
        ],
        root,
      ),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/50 MB/i) });
  });

  it("rejects a PNG wider or taller than 4096 pixels", async () => {
    const root = await createDataDirectory();
    await putJob(root, "active", job("job-pixels"));
    const proposalPath = await proposalFile(root, "job-pixels");
    const imagePath = join(root, "too-wide.png");
    await sharp({
      create: { width: 4097, height: 4097, channels: 3, background: "#ffffff" },
    })
      .png()
      .toFile(imagePath);

    await expect(
      runScript(
        "complete-job.mjs",
        [
          "--job",
          "job-pixels",
          "--proposal-file",
          proposalPath,
          "--image",
          imagePath,
        ],
        root,
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/4096|pixel limit/i),
    });
  });

  it("idempotently writes a retryable terminal failure from a message file", async () => {
    const root = await createDataDirectory();
    await putJob(root, "active", job("job-failed"));
    const failurePath = await messageFile(root, "job-failed");
    const args = ["--job", "job-failed", "--message-file", failurePath];

    const first = await runScript("fail-job.mjs", args, root);
    const retry = await runScript("fail-job.mjs", args, root);

    expect(JSON.parse(retry.stdout)).toEqual(JSON.parse(first.stdout));
    expect(JSON.parse(first.stdout)).toMatchObject({
      jobId: "job-failed",
      status: "failed",
      message: "Image generation was interrupted",
      retryable: true,
    });
  });

  it("atomically records coordinator heartbeat state without a helper PID", async () => {
    const root = await createDataDirectory();

    await runScript(
      "heartbeat.mjs",
      ["--status", "generating", "--job", "job-1"],
      root,
    );

    const heartbeat = JSON.parse(
      await readFile(join(root, "agent-mailbox", "heartbeat.json"), "utf8"),
    );
    expect(heartbeat).toMatchObject({ status: "generating", jobId: "job-1" });
    expect(heartbeat).not.toHaveProperty("pid");
    expect(new Date(heartbeat.updatedAt).toISOString()).toBe(
      heartbeat.updatedAt,
    );
  });
});
