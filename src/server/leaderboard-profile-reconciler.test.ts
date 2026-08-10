import { describe, expect, it, vi } from "vitest";
import {
  isReusablePoolLeaderboardEntry,
  summarizePoolLeaderboard,
  type CandidateRating,
  type ChallengerState,
  type LeaderboardVisualProfile,
} from "@/domain/challenger-state";
import {
  preferenceProfileFromSeed,
  type Candidate,
  type GameState,
} from "@/domain/game";
import type {
  LeaderboardProfileJob,
  LeaderboardProfileResult,
} from "./agent-mailbox";
import { MemoryChallengerRepository } from "./challenger-repository";
import { LeaderboardProfileReconciler } from "./leaderboard-profile-reconciler";
import type { LeaderboardProfileCoordinator } from "./leaderboard-profile-service";

const NOW = "2026-07-24T16:00:00.000Z";
const FINGERPRINT = "b".repeat(64);

function candidate(id: string): Candidate {
  return {
    id,
    imageUrl: `/api/assets/${id}.png`,
    prompt: `${id} prompt`,
    concept: `${id} concept`,
    style: ["editorial", id],
    createdAt: NOW,
    winCount: 0,
  };
}

function rating(item: Candidate, rank: number): CandidateRating {
  return {
    candidate: item,
    rating: 1200 - rank * 25,
    wins: 5 - rank,
    losses: rank,
    source: "generated",
    importItemId: null,
    poolMember: true,
    lastServedAt: null,
  };
}

function game(adaptive = true): GameState {
  const seed = "Architectural editorial portraits with dramatic geometry.";
  return {
    round: {
      leftCandidate: candidate("left"),
      rightCandidate: candidate("right"),
      status: "idle",
      replacingSide: null,
      roundNumber: 4,
      retainedCandidateId: null,
      winStreak: 0,
    },
    history: [],
    preferenceSeed: seed,
    preferenceProfile: {
      ...preferenceProfileFromSeed(seed),
      adaptationMode: adaptive ? "adaptive" : "static",
    },
  };
}

function challengerState(
  overrides: Partial<ChallengerState> = {},
): ChallengerState {
  const { importQueue = [], ...rest } = overrides;
  return {
    version: 1,
    sessionId: "session-1",
    ready: [],
    refillJobs: [],
    pendingComparison: null,
    ratings: [
      rating(candidate("leader-1"), 1),
      rating(candidate("leader-2"), 2),
    ],
    generationTurnaroundEmaMs: 100_000,
    consecutiveFallbackDraws: 0,
    nextFallbackAt: null,
    ...rest,
    importQueue,
  };
}

function coordinatorFixture() {
  const work = new Map<string, LeaderboardProfileJob>();
  const results = new Map<string, LeaderboardProfileResult>();
  const desired = vi.fn<LeaderboardProfileCoordinator["desired"]>((state) => ({
    fingerprint: FINGERPRINT,
    entries: summarizePoolLeaderboard(state)
      .filter(isReusablePoolLeaderboardEntry)
      .slice(0, 4),
  }));
  const prepare = vi.fn<LeaderboardProfileCoordinator["prepare"]>(
    async (id, createdAt, request) => ({
      id,
      kind: "leaderboard-profile",
      createdAt,
      fingerprint: request.fingerprint,
      sources: request.entries.map((entry) => ({
        candidateId: entry.candidate.id,
        rank: entry.rank,
        rating: entry.rating,
        wins: entry.wins,
        losses: entry.losses,
        favorite: entry.favorite,
        source: entry.source,
        concept: entry.candidate.concept,
        style: entry.candidate.style,
        sourceImage: {
          filename: `${String(entry.rank).repeat(64)}.png`,
          path: `profile-sources/${String(entry.rank).repeat(64)}.png`,
          contentType: "image/png",
          width: 100,
          height: 100,
          byteLength: 1024,
        },
      })),
    }),
  );
  const enqueue = vi.fn<LeaderboardProfileCoordinator["enqueue"]>(
    async (job) => {
      work.set(job.id, job);
    },
  );
  const readWork = vi.fn<LeaderboardProfileCoordinator["readWork"]>(
    async (jobId) => work.get(jobId) ?? null,
  );
  const readResult = vi.fn<LeaderboardProfileCoordinator["readResult"]>(
    async (jobId) => results.get(jobId) ?? null,
  );
  const archive = vi.fn<LeaderboardProfileCoordinator["archive"]>(
    async (jobId) => {
      work.delete(jobId);
      results.delete(jobId);
    },
  );
  return {
    coordinator: {
      desired,
      prepare,
      enqueue,
      readWork,
      readResult,
      archive,
    } satisfies LeaderboardProfileCoordinator,
    work,
    results,
    desired,
    prepare,
    enqueue,
    archive,
  };
}

function reconciler(
  repository: MemoryChallengerRepository,
  coordinator?: LeaderboardProfileCoordinator,
) {
  return new LeaderboardProfileReconciler({
    repository,
    coordinator,
    createId: () => "analysis-1",
    now: () => NOW,
  });
}

describe("LeaderboardProfileReconciler", () => {
  it("records and enqueues one desired adaptive analysis", async () => {
    const initial = challengerState();
    const repository = new MemoryChallengerRepository(initial);
    const fixture = coordinatorFixture();

    const result = await reconciler(repository, fixture.coordinator).reconcile(
      game(),
      initial,
    );

    expect(result).toMatchObject({
      leaderboardProfileJob: {
        jobId: "analysis-1",
        fingerprint: FINGERPRINT,
        expectedJob: {
          id: "analysis-1",
          kind: "leaderboard-profile",
          fingerprint: FINGERPRINT,
        },
      },
      leaderboardProfileAttemptedFingerprint: FINGERPRINT,
    });
    expect(fixture.prepare).toHaveBeenCalledOnce();
    expect(fixture.enqueue).toHaveBeenCalledWith(
      result.leaderboardProfileJob?.expectedJob,
    );
    await expect(repository.load()).resolves.toMatchObject({
      leaderboardProfileJob: result.leaderboardProfileJob,
      leaderboardProfileAttemptedFingerprint: FINGERPRINT,
    });
  });

  it("re-enqueues missing durable work without rewriting state", async () => {
    const fixture = coordinatorFixture();
    const prepared = await fixture.coordinator.prepare(
      "analysis-1",
      NOW,
      fixture.coordinator.desired(challengerState())!,
    );
    const initial = challengerState({
      leaderboardProfileJob: {
        jobId: prepared.id,
        fingerprint: prepared.fingerprint,
        enqueuedAt: NOW,
        expectedJob: prepared,
      },
      leaderboardProfileAttemptedFingerprint: prepared.fingerprint,
    });
    const repository = new MemoryChallengerRepository(initial);
    const save = vi.spyOn(repository, "save");

    const result = await reconciler(repository, fixture.coordinator).reconcile(
      game(),
      initial,
    );

    expect(result).toEqual(initial);
    expect(fixture.enqueue).toHaveBeenCalledWith(prepared);
    expect(save).not.toHaveBeenCalled();
  });

  it("caches a matching completion and archives its durable work", async () => {
    const fixture = coordinatorFixture();
    const prepared = await fixture.coordinator.prepare(
      "analysis-1",
      NOW,
      fixture.coordinator.desired(challengerState())!,
    );
    fixture.work.set(prepared.id, prepared);
    fixture.results.set(prepared.id, {
      jobId: prepared.id,
      kind: "leaderboard-profile",
      status: "completed",
      completedAt: "2026-07-24T16:01:00.000Z",
      fingerprint: FINGERPRINT,
      profile: {
        themes: "architectural portrait studies",
        inspiration: "diagonal window light and low-angle framing",
        mediaTypes: "editorial photography",
        visualStyle: "dramatic, geometric, and tactile",
        colorPalette: "violet, charcoal, and pale gold",
        contentLevel: "family-friendly",
        avoid: "logos and readable text",
      },
      reasoningSummary: "Shared traits across the strongest pool images.",
    });
    const initial = challengerState({
      leaderboardProfileJob: {
        jobId: prepared.id,
        fingerprint: prepared.fingerprint,
        enqueuedAt: NOW,
        expectedJob: prepared,
      },
      leaderboardProfileAttemptedFingerprint: prepared.fingerprint,
    });
    const repository = new MemoryChallengerRepository(initial);
    const service = reconciler(repository, fixture.coordinator);

    const result = await service.reconcile(game(), initial);

    expect(result).toMatchObject({
      leaderboardProfileJob: null,
      leaderboardVisualProfile: {
        fingerprint: FINGERPRINT,
        sourceCandidateIds: ["leader-1", "leader-2"],
        profile: {
          inspiration: "diagonal window light and low-angle framing",
        },
      },
      leaderboardProfileAttemptedFingerprint: FINGERPRINT,
    });
    expect(fixture.archive).toHaveBeenCalledWith(prepared.id);
    expect(fixture.prepare).toHaveBeenCalledOnce();
    expect(service.current(result, game())).toEqual(
      result.leaderboardVisualProfile,
    );
  });

  it("archives mismatched work and permits a later retry", async () => {
    const fixture = coordinatorFixture();
    const prepared = await fixture.coordinator.prepare(
      "analysis-1",
      NOW,
      fixture.coordinator.desired(challengerState())!,
    );
    fixture.work.set(prepared.id, {
      ...prepared,
      fingerprint: "c".repeat(64),
    });
    const initial = challengerState({
      leaderboardProfileJob: {
        jobId: prepared.id,
        fingerprint: prepared.fingerprint,
        enqueuedAt: NOW,
        expectedJob: prepared,
      },
      leaderboardProfileAttemptedFingerprint: prepared.fingerprint,
    });
    const repository = new MemoryChallengerRepository(initial);

    const result = await reconciler(repository, fixture.coordinator).reconcile(
      game(),
      initial,
    );

    expect(result).toMatchObject({
      leaderboardProfileJob: null,
      leaderboardProfileAttemptedFingerprint: null,
    });
    expect(fixture.archive).toHaveBeenCalledWith(prepared.id);
  });

  it("keeps cached evidence private from static or changed cohorts", () => {
    const fixture = coordinatorFixture();
    const profile: LeaderboardVisualProfile = {
      fingerprint: FINGERPRINT,
      sourceCandidateIds: ["leader-1", "leader-2"],
      profile: {
        themes: "architectural portrait studies",
        inspiration: "diagonal window light",
        mediaTypes: "editorial photography",
        visualStyle: "dramatic and geometric",
        colorPalette: "violet and charcoal",
        contentLevel: "family-friendly",
        avoid: "logos",
      },
      reasoningSummary: "Shared traits.",
      analyzedAt: NOW,
    };
    const initial = challengerState({ leaderboardVisualProfile: profile });
    const service = reconciler(
      new MemoryChallengerRepository(initial),
      fixture.coordinator,
    );

    expect(service.current(initial, game())).toEqual(profile);
    expect(service.current(initial, game(false))).toBeUndefined();
    fixture.desired.mockReturnValue({
      fingerprint: "d".repeat(64),
      entries: summarizePoolLeaderboard(initial)
        .filter(isReusablePoolLeaderboardEntry)
        .slice(0, 4),
    });
    expect(service.current(initial, game())).toBeUndefined();
  });
});
