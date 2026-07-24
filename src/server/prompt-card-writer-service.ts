import type { CandidateRating } from "@/domain/challenger-state";
import { createPromptCardWriterRequest } from "@/domain/prompt-deck";
import type {
  PromptCardWriterJob,
  PromptCardWriterMailbox,
  PromptCardWriterResult,
} from "./agent-mailbox";
import { normalizeProfileSource } from "./source-profile-service";

export interface PromptCardWriterCoordinator {
  prepare(
    id: string,
    createdAt: string,
    candidates: readonly CandidateRating[],
  ): Promise<PromptCardWriterJob>;
  enqueue(job: PromptCardWriterJob): Promise<void>;
  readWork(jobId: string): Promise<PromptCardWriterJob | null>;
  readResult(jobId: string): Promise<PromptCardWriterResult | null>;
  archive(jobId: string): Promise<void>;
}

interface PromptCardWriterServiceOptions {
  mailbox: PromptCardWriterMailbox;
  sourceDirectory: string;
  readCandidateImage: (
    candidate: CandidateRating,
  ) => Promise<{ contents: Uint8Array; contentType: string }>;
}

export class PromptCardWriterService implements PromptCardWriterCoordinator {
  constructor(private readonly options: PromptCardWriterServiceOptions) {}

  async prepare(
    id: string,
    createdAt: string,
    candidates: readonly CandidateRating[],
  ): Promise<PromptCardWriterJob> {
    const sources = await Promise.all(
      candidates.map(async (rating) => {
        const image = await this.options.readCandidateImage(rating);
        return {
          candidateId: rating.candidate.id.slice(0, 200),
          concept: rating.candidate.concept.trim().slice(0, 240),
          style: rating.candidate.style
            .slice(0, 4)
            .map((tag) => tag.trim().slice(0, 80))
            .filter(Boolean),
          sourceImage: await normalizeProfileSource(
            image.contents,
            image.contentType,
            this.options.sourceDirectory,
          ),
        };
      }),
    );
    return createPromptCardWriterRequest(sources, id, createdAt);
  }

  enqueue(job: PromptCardWriterJob): Promise<void> {
    return this.options.mailbox.enqueuePromptCardWriter(job);
  }

  readWork(jobId: string): Promise<PromptCardWriterJob | null> {
    return this.options.mailbox.readPromptCardWriterWork(jobId);
  }

  readResult(jobId: string): Promise<PromptCardWriterResult | null> {
    return this.options.mailbox.readPromptCardWriterResult(jobId);
  }

  archive(jobId: string): Promise<void> {
    return this.options.mailbox.archivePromptCardWriter(jobId);
  }
}
