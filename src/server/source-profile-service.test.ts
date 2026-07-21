import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { FileGenerationMailbox } from "./agent-mailbox";
import {
  SourceProfileInputError,
  SourceProfileNotFoundError,
  SourceProfileService,
  normalizeProfileSource,
} from "./source-profile-service";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function context() {
  const root = await mkdtemp(join(tmpdir(), "diptych-source-profile-"));
  roots.push(root);
  const mailboxRoot = join(root, "agent-mailbox");
  const mailbox = new FileGenerationMailbox(mailboxRoot);
  const service = new SourceProfileService({
    mailbox,
    sourceDirectory: join(root, "profile-sources"),
    createId: () => "source-job-1",
    now: () => "2026-07-20T20:00:00.000Z",
  });
  return { root, mailboxRoot, mailbox, service };
}

describe("source profile service", () => {
  it("normalizes an upload, enqueues analysis, and returns an editable profile", async () => {
    const { root, mailboxRoot, mailbox, service } = await context();
    const jpeg = await sharp({
      create: {
        width: 80,
        height: 60,
        channels: 3,
        background: "#713c89",
      },
    })
      .jpeg()
      .toBuffer();

    await expect(service.request(jpeg, "image/jpeg")).resolves.toEqual({
      status: "analyzing",
      jobId: "source-job-1",
    });
    const job = await mailbox.readSourceProfileWork("source-job-1");
    expect(job).toMatchObject({
      id: "source-job-1",
      kind: "source-profile",
      createdAt: "2026-07-20T20:00:00.000Z",
      sourceImage: {
        filename: expect.stringMatching(/^[a-f0-9]{64}\.png$/),
        contentType: "image/png",
        width: 80,
        height: 60,
      },
    });
    expect(
      (
        await sharp(
          await readFile(join(root, job!.sourceImage.path)),
        ).metadata()
      ).format,
    ).toBe("png");
    await expect(service.status("source-job-1")).resolves.toEqual({
      status: "analyzing",
      jobId: "source-job-1",
    });

    await mkdir(join(mailboxRoot, "completed"), { recursive: true });
    await writeFile(
      join(mailboxRoot, "completed", "source-job-1.json"),
      `${JSON.stringify({
        jobId: "source-job-1",
        kind: "source-profile",
        status: "completed",
        completedAt: "2026-07-20T20:01:00.000Z",
        profile: {
          themes: "violet architectural portrait variations",
          inspiration: "low-angle framing",
          mediaTypes: "editorial photography",
          visualStyle: "dramatic and geometric",
          colorPalette: "violet and charcoal",
          contentLevel: "family-friendly",
          avoid: "exact identity and readable text",
        },
        reasoningSummary:
          "Transfers composition and palette without copying identity.",
      })}\n`,
      "utf8",
    );
    await expect(service.status("source-job-1")).resolves.toMatchObject({
      status: "completed",
      profile: { themes: "violet architectural portrait variations" },
    });

    await service.acknowledge("source-job-1");
    await expect(service.status("source-job-1")).rejects.toBeInstanceOf(
      SourceProfileNotFoundError,
    );
  });

  it("rejects unsupported or undecodable uploads before enqueueing work", async () => {
    const { service } = await context();

    await expect(
      service.request(new Uint8Array([1, 2, 3]), "text/plain"),
    ).rejects.toBeInstanceOf(SourceProfileInputError);
    await expect(
      service.request(new Uint8Array([1, 2, 3]), "image/png"),
    ).rejects.toThrow(/could not be decoded/i);
  });

  it("deduplicates concurrently normalized copies without a partial-read race", async () => {
    const { root } = await context();
    const png = await sharp({
      create: {
        width: 1024,
        height: 1024,
        channels: 3,
        background: "#713c89",
      },
    })
      .png()
      .toBuffer();
    const sourceDirectory = join(root, "concurrent-profile-sources");

    const sources = await Promise.all(
      Array.from({ length: 6 }, () =>
        normalizeProfileSource(png, "image/png", sourceDirectory),
      ),
    );

    expect(new Set(sources.map(({ filename }) => filename))).toHaveLength(1);
    await expect(
      readFile(join(sourceDirectory, sources[0].filename)),
    ).resolves.not.toHaveLength(0);
  });
});
