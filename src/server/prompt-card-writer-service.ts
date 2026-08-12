import { createHash } from "node:crypto";
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
  prepareCustom(
    id: string,
    createdAt: string,
    input: PromptCardWriterCustomInput,
  ): Promise<PromptCardWriterJob>;
  enqueue(job: PromptCardWriterJob): Promise<void>;
  readWork(jobId: string): Promise<PromptCardWriterJob | null>;
  readResult(jobId: string): Promise<PromptCardWriterResult | null>;
  archive(jobId: string): Promise<void>;
}

export interface PromptCardWriterImageInput {
  filename: string;
  contents: Uint8Array;
  contentType: string;
}

export interface PromptCardWriterCustomInput {
  guidance: string;
  images: readonly PromptCardWriterImageInput[];
}

export class PromptCardWriterInputError extends Error {}

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

  async prepareCustom(
    id: string,
    createdAt: string,
    input: PromptCardWriterCustomInput,
  ): Promise<PromptCardWriterJob> {
    const guidance = input.guidance.trim();
    const sources = await Promise.all(
      input.images.map(async (image, index) => ({
        concept:
          `Seed image ${index + 1}: ${displayFilename(image.filename)}`.slice(
            0,
            240,
          ),
        style: [],
        sourceImage: await normalizeProfileSource(
          image.contents,
          image.contentType,
          this.options.sourceDirectory,
        ),
      })),
    );
    ensureDistinctSources(sources);
    const sourceTextDigest = guidance
      ? createHash("sha256").update(guidance).digest("hex")
      : undefined;
    return createPromptCardWriterRequest(
      sources,
      id,
      createdAt,
      guidance || undefined,
      sourceTextDigest,
    );
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

function displayFilename(filename: string): string {
  const trimmed = filename.trim().replace(/[\u0000-\u001f\u007f]/g, "");
  return trimmed.length > 0 ? trimmed.slice(0, 180) : "uploaded source";
}

function ensureDistinctSources(
  sources: readonly { sourceImage: { filename: string } }[],
): void {
  if (
    new Set(sources.map(({ sourceImage }) => sourceImage.filename)).size !==
    sources.length
  ) {
    throw new PromptCardWriterInputError(
      "Prompt-card seed images must be distinct.",
    );
  }
}
