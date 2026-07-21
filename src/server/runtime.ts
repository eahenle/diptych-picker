import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BufferHealth,
  Candidate,
  GameStartState,
  GameState,
  PreferenceProfile,
} from "@/domain/game";
import {
  summarizeBufferHealth,
  summarizeComparisonHistory,
  summarizeDisplayedScores,
  summarizePoolLeaderboard,
  type PoolLeaderboardEntry,
} from "@/domain/challenger-state";
import { FileGenerationMailbox } from "./agent-mailbox";
import { LocalAssetStore } from "./asset-store";
import { publishExportArtifact } from "./artifact-store";
import { JsonChallengerRepository } from "./challenger-repository";
import { GameService } from "./game-service";
import { GameSnapshotService, type GameSnapshot } from "./game-snapshot";
import { JsonInitialBootstrapRepository } from "./initial-bootstrap";
import { InitialGameService } from "./initial-game";
import {
  DEFAULT_PREFERENCE_SEED,
  gameFromSeedAssets,
  initialCandidateContext,
  loadCuratedCandidates,
} from "./initial-state";
import {
  MockAgentWorker,
  MockGenerationMailbox,
  MockLeaderboardProfileMailbox,
  MockSourceProfileMailbox,
} from "./mock-agent";
import { JsonGameRepository } from "./repository";
import { challengerConfig } from "./challenger-config";
import { SourceProfileService } from "./source-profile-service";
import { LeaderboardProfileService } from "./leaderboard-profile-service";
import {
  CoProcGenerationTransport,
  TransportNotifyingGenerationMailbox,
} from "./co-proc-generation-transport";

const dataDirectory = join(
  /* turbopackIgnore: true */ process.cwd(),
  process.env.LOCAL_DATA_DIR ?? ".local-data",
);
export const generationProvider: "agent" | "mock" =
  process.env.GENERATION_PROVIDER === "mock" ? "mock" : "agent";
const mockMode = generationProvider === "mock";
const runtimeExportDirectory = mockMode
  ? join(dataDirectory, "exports")
  : join(/* turbopackIgnore: true */ process.cwd(), "output", "artifacts");

export const assetStore = new LocalAssetStore(
  join(dataDirectory, "assets"),
  runtimeExportDirectory,
);
export const repository = new JsonGameRepository(
  join(dataDirectory, "game-state.json"),
);
export const challengerRepository = new JsonChallengerRepository(
  join(dataDirectory, "challenger-state.json"),
);
export const initialBootstrapRepository = new JsonInitialBootstrapRepository(
  join(dataDirectory, "initial-bootstrap.json"),
);
const mailboxDirectory = join(dataDirectory, "agent-mailbox");
const fileGenerationMailbox = new FileGenerationMailbox(mailboxDirectory);
const coProcGenerationChannel = process.env.CO_PROC_GENERATION_CHANNEL?.trim();
if (mockMode && process.env.NODE_ENV === "production") {
  throw new Error("The deterministic mock worker is test-only");
}

const configuredMockDelay = Number(
  process.env.MOCK_GENERATION_DELAY_MS ?? "650",
);
if (
  mockMode &&
  (!Number.isFinite(configuredMockDelay) || configuredMockDelay < 0)
) {
  throw new Error("MOCK_GENERATION_DELAY_MS must be a non-negative number");
}

const mockAgent = mockMode
  ? new MockAgentWorker({
      mailboxDirectory,
      assetStore,
      delayMs: configuredMockDelay,
    })
  : null;
const durableGenerationMailbox = mockAgent
  ? new MockGenerationMailbox(fileGenerationMailbox, mockAgent)
  : fileGenerationMailbox;
export const generationMailbox =
  !mockAgent && coProcGenerationChannel
    ? new TransportNotifyingGenerationMailbox(
        durableGenerationMailbox,
        new CoProcGenerationTransport({
          channel: coProcGenerationChannel,
          runtimeRoot: process.env.CO_PROC_RUNTIME_ROOT,
        }),
        {
          durableJobPath: (job) =>
            join(mailboxDirectory, "pending", `${job.id}.json`),
          onTransportError: (error, job) => {
            console.warn(
              `co-proc notification failed for ${job.id}; durable mailbox polling remains active`,
              error,
            );
          },
        },
      )
    : durableGenerationMailbox;
const sourceProfileMailbox = mockAgent
  ? new MockSourceProfileMailbox(fileGenerationMailbox, mockAgent)
  : fileGenerationMailbox;
const sourceProfileService = new SourceProfileService({
  mailbox: sourceProfileMailbox,
  sourceDirectory: join(dataDirectory, "profile-sources"),
});
const leaderboardProfileMailbox = mockAgent
  ? new MockLeaderboardProfileMailbox(fileGenerationMailbox, mockAgent)
  : fileGenerationMailbox;
const leaderboardProfileService = new LeaderboardProfileService({
  mailbox: leaderboardProfileMailbox,
  sourceDirectory: join(dataDirectory, "profile-sources"),
  readCandidateImage: async (entry: PoolLeaderboardEntry) => {
    if (entry.source === "generated") {
      const match = entry.candidate.imageUrl.match(
        /^\/api\/assets\/([a-zA-Z0-9-]+\.png)$/,
      );
      if (!match) {
        throw new Error(
          `Invalid generated leaderboard asset URL for ${entry.candidate.id}`,
        );
      }
      return {
        contents: await assetStore.read(match[1]),
        contentType: "image/png",
      };
    }
    const match = entry.candidate.imageUrl.match(
      /^\/seed-assets\/([a-z0-9]+(?:-[a-z0-9]+)*\.png)$/,
    );
    if (!match) {
      throw new Error(
        `Invalid curated leaderboard asset URL for ${entry.candidate.id}`,
      );
    }
    return {
      contents: await readFile(
        join(
          /* turbopackIgnore: true */ process.cwd(),
          "public",
          "seed-assets",
          match[1],
        ),
      ),
      contentType: "image/png",
    };
  },
});
export const gameService = new GameService(
  repository,
  challengerRepository,
  generationMailbox,
  assetStore,
  undefined,
  undefined,
  undefined,
  undefined,
  leaderboardProfileService,
);
const forceGeneratedInitial =
  process.env.GENERATE_INITIAL_CANDIDATES === "true";
export const initialGameService = new InitialGameService({
  gameRepository: repository,
  challengerRepository,
  bootstrapRepository: initialBootstrapRepository,
  mailbox: generationMailbox,
  assetVerifier: assetStore,
  seedState: (now) => gameFromSeedAssets(now, forceGeneratedInitial),
  curatedCandidates: forceGeneratedInitial
    ? async () => []
    : loadCuratedCandidates,
  initialContext: initialCandidateContext,
  preferenceSeed: DEFAULT_PREFERENCE_SEED,
});
let verifiedCuratedCandidates: Promise<readonly Candidate[]> | null = null;
const gameSnapshotService = new GameSnapshotService({
  gameRepository: repository,
  challengerRepository,
  bootstrapRepository: initialBootstrapRepository,
  mailbox: generationMailbox,
  verifyCandidateAsset: async (candidate, source) => {
    if (source === "generated") {
      const match = candidate.imageUrl.match(/^\/api\/assets\/([^/]+\.png)$/);
      if (!match)
        throw new Error(`Invalid generated asset URL for ${candidate.id}`);
      await assetStore.verifyExistingPng(match[1]);
      return;
    }
    if (!/^\/seed-assets\/[a-zA-Z0-9-]+\.png$/.test(candidate.imageUrl))
      throw new Error(`Invalid curated asset URL for ${candidate.id}`);
    verifiedCuratedCandidates ??= loadCuratedCandidates(candidate.createdAt);
    const expected = (await verifiedCuratedCandidates).find(
      ({ id }) => id === candidate.id,
    );
    if (
      !expected ||
      expected.imageUrl !== candidate.imageUrl ||
      expected.prompt !== candidate.prompt ||
      expected.concept !== candidate.concept ||
      !isDeepStrictEqual(expected.style, candidate.style)
    ) {
      throw new Error(
        `Curated candidate metadata does not match ${candidate.id}`,
      );
    }
  },
});

export async function resetGame(): Promise<GameStartState> {
  await gameService.assertIdle();
  return initialGameService.reset();
}

export async function exportGameSnapshot(): Promise<GameSnapshot> {
  const state = await getOrCreateGame();
  if (state.status !== "ready") {
    throw new Error("Wait for the initial comparison before exporting");
  }
  return gameSnapshotService.export();
}

export async function publishGameExport(contents: Buffer) {
  return publishExportArtifact(contents, "json", runtimeExportDirectory);
}

export async function importGameSnapshot(value: unknown): Promise<GameState> {
  await gameService.assertIdle();
  const imported = await gameSnapshotService.import(value);
  await gameService.ensureRefillCapacity();
  return (await gameService.reconcile()) ?? imported;
}

export async function getOrCreateGame(): Promise<GameStartState> {
  const start = await initialGameService.getOrCreate();
  if (start.status !== "ready") return start;
  const reconciled = await gameService.reconcile();
  return { status: "ready", game: reconciled ?? start.game };
}

export async function getBufferHealth(): Promise<BufferHealth> {
  return summarizeBufferHealth(
    await challengerRepository.load(),
    challengerConfig.bufferTarget,
    challengerConfig.poolMaximum,
  );
}

export async function refreshBufferHealth(): Promise<BufferHealth> {
  await gameService.reconcile();
  return getBufferHealth();
}

export async function getPoolLeaderboard() {
  await gameService.reconcile();
  return {
    entries: summarizePoolLeaderboard(await challengerRepository.load()),
    poolMaximum: challengerConfig.poolMaximum,
  };
}

export async function getComparisonHistory() {
  const game = await gameService.reconcile();
  const history = game?.history ?? [];
  return {
    entries: summarizeComparisonHistory(
      history,
      await challengerRepository.load(),
    ),
    total: history.length,
  };
}

export class CandidateFavoriteNotFoundError extends Error {}

export async function setCandidateFavorite(
  candidateId: string,
  favorite: boolean,
) {
  return challengerRepository.withLock(async () => {
    const state = await challengerRepository.load();
    if (!state) {
      throw new CandidateFavoriteNotFoundError(
        "Start a game before favoriting candidates",
      );
    }
    if (!state.ratings.some(({ candidate }) => candidate.id === candidateId)) {
      throw new CandidateFavoriteNotFoundError(
        "That candidate is not available in this game",
      );
    }
    const updated = {
      ...state,
      ratings: state.ratings.map((rating) =>
        rating.candidate.id === candidateId ? { ...rating, favorite } : rating,
      ),
    };
    await challengerRepository.save(updated);
    return { candidateId, favorite };
  });
}

export async function getDisplayedEloRatings(game: GameState) {
  return summarizeDisplayedScores(
    await challengerRepository.load(),
    game,
    challengerConfig.initialRating,
    challengerConfig.eloKFactor,
    challengerConfig.poolMaximum,
  );
}

export async function updatePreferenceSeed(
  preferenceSeed: string,
  preferenceProfile?: PreferenceProfile,
  expectedPreferenceProfile?: PreferenceProfile,
): Promise<GameState> {
  const start = await getOrCreateGame();
  if (start.status !== "ready") {
    throw new Error(
      "Wait for the initial candidates before editing preferences",
    );
  }
  return gameService.updatePreferenceSeed(
    preferenceSeed,
    preferenceProfile,
    expectedPreferenceProfile,
  );
}

export async function dismissGenerationNotice(): Promise<GameState> {
  return gameService.dismissGenerationNotice();
}

export async function requestSourceProfile(
  contents: Uint8Array,
  contentType: string,
) {
  return sourceProfileService.request(contents, contentType);
}

export async function getSourceProfileStatus(jobId: string) {
  return sourceProfileService.status(jobId);
}

export async function acknowledgeSourceProfile(jobId: string) {
  await sourceProfileService.acknowledge(jobId);
}
