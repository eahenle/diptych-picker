import { isDeepStrictEqual } from "node:util";
import type { GenerationJob, GenerationMailbox } from "./agent-mailbox";

export class GenerationJobPublisher {
  constructor(private readonly mailbox: GenerationMailbox) {}

  async ensureAll(jobs: readonly GenerationJob[]): Promise<void> {
    for (const job of jobs) await this.ensure(job);
  }

  async ensure(job: GenerationJob): Promise<void> {
    try {
      await this.mailbox.enqueue(job);
    } catch (error) {
      const work = await this.mailbox.readWork(job.id);
      if (work && isDeepStrictEqual(work, job)) return;
      throw error;
    }
  }
}
