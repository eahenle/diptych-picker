import { createHash } from "node:crypto";
import type {
  ChallengerState,
  PoolLeaderboardEntry,
} from "@/domain/challenger-state";
import { summarizePoolLeaderboard } from "@/domain/challenger-state";
import type {
  LeaderboardProfileJob,
  LeaderboardProfileMailbox,
  LeaderboardProfileResult,
} from "./agent-mailbox";
import { normalizeProfileSource } from "./source-profile-service";

const LEADERBOARD_VISUAL_SOURCE_LIMIT = 4;

export interface LeaderboardProfileRequest {
  fingerprint: string;
  entries: PoolLeaderboardEntry[];
}

export interface LeaderboardProfileCoordinator {
  desired(state: ChallengerState): LeaderboardProfileRequest | null;
  prepare(
    id: string,
    createdAt: string,
    request: LeaderboardProfileRequest,
  ): Promise<LeaderboardProfileJob>;
  enqueue(job: LeaderboardProfileJob): Promise<void>;
  readWork(jobId: string): Promise<LeaderboardProfileJob | null>;
  readResult(jobId: string): Promise<LeaderboardProfileResult | null>;
  archive(jobId: string): Promise<void>;
}

interface LeaderboardProfileServiceOptions {
  mailbox: LeaderboardProfileMailbox;
  sourceDirectory: string;
  readCandidateImage: (
    entry: PoolLeaderboardEntry,
  ) => Promise<{ contents: Uint8Array; contentType: string }>;
}

export class LeaderboardProfileService implements LeaderboardProfileCoordinator {
  constructor(private readonly options: LeaderboardProfileServiceOptions) {}

  desired(state: ChallengerState): LeaderboardProfileRequest | null {
    const entries = summarizePoolLeaderboard(state)
      .filter(({ wins, losses, favorite }) => wins + losses > 0 || favorite)
      .slice(0, LEADERBOARD_VISUAL_SOURCE_LIMIT);
    if (entries.length < 2) return null;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify(
          entries.map(({ rank, candidate }) => [rank, candidate.id]),
        ),
      )
      .digest("hex");
    return { fingerprint, entries };
  }

  async prepare(
    id: string,
    createdAt: string,
    request: LeaderboardProfileRequest,
  ): Promise<LeaderboardProfileJob> {
    const sources = await Promise.all(
      request.entries.map(async (entry) => {
        const image = await this.options.readCandidateImage(entry);
        const sourceImage = await normalizeProfileSource(
          image.contents,
          image.contentType,
          this.options.sourceDirectory,
        );
        return {
          candidateId: entry.candidate.id,
          rank: entry.rank,
          rating: entry.rating,
          wins: entry.wins,
          losses: entry.losses,
          favorite: entry.favorite,
          source: entry.source,
          concept: entry.candidate.concept.trim().slice(0, 240),
          style: entry.candidate.style
            .slice(0, 4)
            .map((tag) => tag.trim().slice(0, 80))
            .filter(Boolean),
          sourceImage,
        };
      }),
    );
    return {
      id,
      kind: "leaderboard-profile",
      createdAt,
      fingerprint: request.fingerprint,
      sources,
    };
  }

  enqueue(job: LeaderboardProfileJob): Promise<void> {
    return this.options.mailbox.enqueueLeaderboardProfile(job);
  }

  readWork(jobId: string): Promise<LeaderboardProfileJob | null> {
    return this.options.mailbox.readLeaderboardProfileWork(jobId);
  }

  readResult(jobId: string): Promise<LeaderboardProfileResult | null> {
    return this.options.mailbox.readLeaderboardProfileResult(jobId);
  }

  archive(jobId: string): Promise<void> {
    return this.options.mailbox.archiveLeaderboardProfile(jobId);
  }
}
