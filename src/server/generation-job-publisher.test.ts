import { describe, expect, it, vi } from "vitest";
import type {
  GenerationJob,
  GenerationMailbox,
  GenerationResult,
} from "./agent-mailbox";
import { GenerationJobPublisher } from "./generation-job-publisher";

const NOW = "2026-07-26T06:00:00.000Z";

function job(id = "refill-1"): GenerationJob {
  const retainedWinner = {
    id: "left",
    imageUrl: "/api/assets/left.png",
    prompt: "left prompt",
    concept: "left concept",
    style: ["editorial"],
    createdAt: NOW,
    winCount: 1,
  };
  return {
    id,
    kind: "refill",
    createdAt: NOW,
    roundNumber: 4,
    winnerSide: "left",
    retainedWinner,
    rejectedCandidate: {
      ...retainedWinner,
      id: "right",
      imageUrl: "/api/assets/right.png",
      prompt: "right prompt",
      concept: "right concept",
      winCount: 0,
    },
    selectionHistory: [],
    recentConcepts: [],
    preferenceSeed: "Architectural portraits in dramatic natural light.",
    sessionId: "session-1",
    pinnedWinnerId: retainedWinner.id,
  };
}

function fixture() {
  const work = new Map<string, GenerationJob>();
  const enqueue = vi.fn(async (value: GenerationJob) => {
    work.set(value.id, value);
  });
  const readWork = vi.fn(
    async (id: string): Promise<GenerationJob | null> => work.get(id) ?? null,
  );
  const mailbox: GenerationMailbox = {
    enqueue,
    readPending: readWork,
    readWork,
    readResult: async (): Promise<GenerationResult | null> => null,
    archive: async () => {},
  };
  return {
    publisher: new GenerationJobPublisher(mailbox),
    enqueue,
    readWork,
    setWork: (value: GenerationJob) => work.set(value.id, value),
  };
}

describe("GenerationJobPublisher", () => {
  it("publishes every job in stable order", async () => {
    const context = fixture();
    const jobs = [job("one"), job("two"), job("three")];

    await context.publisher.ensureAll(jobs);

    expect(context.enqueue.mock.calls.map(([value]) => value.id)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("accepts a lost acknowledgement only when durable work matches exactly", async () => {
    const context = fixture();
    const expected = job();
    context.enqueue.mockImplementationOnce(async (value) => {
      context.setWork(value);
      throw new Error("lost acknowledgement");
    });

    await expect(context.publisher.ensure(expected)).resolves.toBeUndefined();
    expect(context.readWork).toHaveBeenCalledWith(expected.id);
  });

  it("rethrows publication failure when durable work is absent or mismatched", async () => {
    const context = fixture();
    const expected = job();
    context.setWork({ ...expected, preferenceSeed: "A different brief." });
    context.enqueue.mockRejectedValueOnce(new Error("mailbox unavailable"));

    await expect(context.publisher.ensure(expected)).rejects.toThrow(
      "mailbox unavailable",
    );
  });
});
