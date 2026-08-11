import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BufferHealth,
  Candidate,
  GameRules,
  GameStartState,
  GameState,
  PreferenceProfile,
  Side,
} from "@/domain/game";
import type { ImportProgress } from "@/domain/import-progress";
import {
  refillJobMatchesGenerationPreferences,
  summarizeBufferHealth,
  summarizeComparisonHistory,
  summarizeDisplayedScores,
  summarizeFavoriteGallery,
  summarizePoolLeaderboard,
  type CandidateRating,
  type PoolLeaderboardEntry,
} from "@/domain/challenger-state";
import { FileGenerationMailbox } from "./agent-mailbox";
import { LocalAssetStore } from "./asset-store";
import { publishExportArtifact } from "./artifact-store";
import { JsonChallengerRepository } from "./challenger-repository";
import { GameService } from "./game-service";
import type { CreatePromptCardInput } from "@/domain/prompt-deck";
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
  MockImportAnnotationMailbox,
  MockInitialImportFillMailbox,
  MockLeaderboardProfileMailbox,
  MockPromptCardBlenderMailbox,
  MockPromptCardEditorMailbox,
  MockPromptCardWriterMailbox,
  MockSourceProfileMailbox,
} from "./mock-agent";
import { JsonGameRepository } from "./repository";
import { JsonImportSessionRepository } from "./import-session-repository";
import { JsonImportActivationIntentRepository } from "./import-activation-intent-repository";
import { ImportActivationService } from "./import-activation-service";
import { StateLockCoordinator } from "./state-lock-coordinator";
import { normalizeImportedCandidate } from "./import-asset-service";
import {
  ImportSessionService,
  type ManualImportAnnotationInput,
} from "./import-session-service";
import { challengerConfig } from "./challenger-config";
import { configuredGameRules, effectiveGameRules } from "./game-rules";
import { SourceProfileService } from "./source-profile-service";
import { LeaderboardProfileService } from "./leaderboard-profile-service";
import { PromptCardWriterService } from "./prompt-card-writer-service";
import {
  CoProcGenerationChannelPool,
  CoProcGenerationTransport,
  TransportNotifyingGenerationMailbox,
} from "./co-proc-generation-transport";

function optionalPositiveInteger(
  name: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 30_000) {
    throw new Error(`${name} must be an integer from 1 through 30000`);
  }
  return parsed;
}

function optionalLeaseDuration(
  name: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 10_000 || parsed > 600_000) {
    throw new Error(`${name} must be an integer from 10000 through 600000`);
  }
  return parsed;
}

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
export const importSessionRepository = new JsonImportSessionRepository(
  join(dataDirectory, "import-session.json"),
);
export const importActivationIntentRepository =
  new JsonImportActivationIntentRepository(
    join(dataDirectory, "import-activation-intent.json"),
  );
const coProcGenerationChannels = (
  process.env.CO_PROC_GENERATION_CHANNELS ??
  process.env.CO_PROC_GENERATION_CHANNEL ??
  ""
)
  .split(",")
  .map((channel) => channel.trim())
  .filter(Boolean);
const coProcReadyTimeout = optionalPositiveInteger(
  "CO_PROC_GENERATION_READY_TIMEOUT_MS",
  process.env.CO_PROC_GENERATION_READY_TIMEOUT_MS,
);
const coProcAcknowledgementTimeout = optionalPositiveInteger(
  "CO_PROC_GENERATION_ACK_TIMEOUT_MS",
  process.env.CO_PROC_GENERATION_ACK_TIMEOUT_MS,
);
const coProcLeaseDuration = optionalLeaseDuration(
  "CO_PROC_GENERATION_LEASE_MS",
  process.env.CO_PROC_GENERATION_LEASE_MS,
);
if (
  mockMode &&
  process.env.NODE_ENV === "production" &&
  process.env.DIPTYCH_OFFLINE_DEMO !== "true"
) {
  throw new Error(
    "The deterministic mock worker requires DIPTYCH_OFFLINE_DEMO=true in production",
  );
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
  !mockAgent && coProcGenerationChannels.length > 0
    ? new TransportNotifyingGenerationMailbox(
        durableGenerationMailbox,
        new CoProcGenerationChannelPool(
          coProcGenerationChannels.map(
            (channel) =>
              new CoProcGenerationTransport({
                channel,
                runtimeRoot: process.env.CO_PROC_RUNTIME_ROOT,
                readyTimeoutMs: coProcReadyTimeout,
                acknowledgementTimeoutMs: coProcAcknowledgementTimeout,
                leaseDurationMs: coProcLeaseDuration,
              }),
          ),
        ),
        {
          durableJobPath: (job) =>
            join(mailboxDirectory, "pending", `${job.id}.json`),
          onTransportError: (error, job) => {
            console.warn(
              `co-proc notification failed for ${job.id}; durable mailbox polling remains active`,
              error,
            );
          },
          onTerminalSignalError: (error, signal) => {
            console.warn(
              signal
                ? `co-proc terminal signal failed for ${signal.jobId}; durable mailbox reconciliation remains active`
                : "co-proc terminal observation failed; durable mailbox reconciliation remains active",
              error,
            );
          },
        },
      )
    : durableGenerationMailbox;
const sourceProfileMailbox = mockAgent
  ? new MockSourceProfileMailbox(fileGenerationMailbox, mockAgent)
  : fileGenerationMailbox;
const importAnnotationMailbox = mockAgent
  ? new MockImportAnnotationMailbox(fileGenerationMailbox, mockAgent)
  : fileGenerationMailbox;
const initialImportFillMailbox = mockAgent
  ? new MockInitialImportFillMailbox(fileGenerationMailbox, mockAgent)
  : fileGenerationMailbox;
export const importSessionService = new ImportSessionService({
  repository: importSessionRepository,
  mailbox: importAnnotationMailbox,
  initialFillMailbox: initialImportFillMailbox,
  defaultPreferenceSeed: DEFAULT_PREFERENCE_SEED,
  normalizeAsset: (contents) =>
    normalizeImportedCandidate(
      contents,
      join(dataDirectory, "assets"),
      runtimeExportDirectory,
    ),
  verifyAsset: (asset) => assetStore.verifyImportedAsset(asset),
  verifyGeneratedAsset: (asset) => assetStore.verifyExistingPng(asset.filename),
});
const stateLockCoordinator = new StateLockCoordinator({
  activationIntent: importActivationIntentRepository,
  importSession: importSessionRepository,
  game: repository,
  challenger: challengerRepository,
  initialBootstrap: initialBootstrapRepository,
});
export const importActivationService = new ImportActivationService({
  coordinator: stateLockCoordinator,
  intentRepository: importActivationIntentRepository,
  importSessionRepository,
  gameRepository: repository,
  challengerRepository,
  bootstrapRepository: initialBootstrapRepository,
  preferenceSeed: DEFAULT_PREFERENCE_SEED,
  gameRules: configuredGameRules(challengerConfig),
  initialRating: challengerConfig.initialRating,
  initialGenerationTurnaroundMs: challengerConfig.initialTurnaroundMs,
  verifyCandidateAsset: async (candidate) => {
    const filename = candidate.imageUrl.match(
      /^\/api\/assets\/([^/]+\.png)$/,
    )?.[1];
    if (!filename) {
      throw new Error(
        `Invalid activated candidate asset URL ${candidate.imageUrl}`,
      );
    }
    await assetStore.verifyExistingPng(filename);
  },
  archiveSupersededJob: (jobId) => fileGenerationMailbox.archive(jobId),
});
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
const promptCardEditorMailbox = mockAgent
  ? new MockPromptCardEditorMailbox(fileGenerationMailbox, mockAgent)
  : fileGenerationMailbox;
const promptCardBlenderMailbox = mockAgent
  ? new MockPromptCardBlenderMailbox(fileGenerationMailbox, mockAgent)
  : fileGenerationMailbox;
const promptCardWriterMailbox = mockAgent
  ? new MockPromptCardWriterMailbox(fileGenerationMailbox, mockAgent)
  : fileGenerationMailbox;
const promptCardWriterService = new PromptCardWriterService({
  mailbox: promptCardWriterMailbox,
  sourceDirectory: join(dataDirectory, "profile-sources"),
  readCandidateImage: async (rating: CandidateRating) => {
    const match = rating.candidate.imageUrl.match(
      /^\/api\/assets\/([a-zA-Z0-9-]+\.png)$/,
    );
    if (!match) {
      throw new Error(
        `Invalid generated prompt-card source URL for ${rating.candidate.id}`,
      );
    }
    return {
      contents: await assetStore.read(match[1]),
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
  promptCardEditorMailbox,
  promptCardBlenderMailbox,
  promptCardWriterService,
  {
    importSessionRepository,
    stateLockCoordinator,
  },
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
  importSessionRepository,
  stateLockCoordinator,
  verifyImportedAsset: (asset) => assetStore.verifyImportedAsset(asset),
  verifyCandidateAsset: async (candidate, source) => {
    if (source !== "curated") {
      const match = candidate.imageUrl.match(/^\/api\/assets\/([^/]+\.png)$/);
      if (!match)
        throw new Error(`Invalid local asset URL for ${candidate.id}`);
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
  await reconcileImportPipeline();
  await gameService.assertIdle();
  const imported = await gameSnapshotService.import(value);
  await gameService.ensureRefillCapacity();
  return (await gameService.reconcile()) ?? imported;
}

export async function getOrCreateGame(): Promise<GameStartState> {
  const importState = await reconcileImportPipeline();
  if (importState?.status === "ready") {
    const reconciled = await gameService.reconcile();
    return { status: "ready", game: reconciled ?? importState.game };
  }
  const start = await initialGameService.getOrCreate();
  if (start.status !== "ready") return start;
  const reconciled = await gameService.reconcile();
  return { status: "ready", game: reconciled ?? start.game };
}

export async function getGameStartupStatus(): Promise<{
  canResume: boolean;
  importInProgress: boolean;
}> {
  const [game, bootstrap, activationIntent, importSession] = await Promise.all([
    repository.load(),
    initialBootstrapRepository.load(),
    importActivationIntentRepository.load(),
    importSessionRepository.load(),
  ]);
  return {
    canResume: Boolean(game || bootstrap || activationIntent),
    importInProgress: Boolean(
      importSession && importSession.status !== "completed",
    ),
  };
}

export async function selectGameRound(
  selection:
    | { winnerSide: Side; roundNumber: number }
    | { outcome: "tie" | "both-lose"; roundNumber: number },
): Promise<GameState> {
  await reconcileImportPipeline();
  return "outcome" in selection
    ? selection.outcome === "tie"
      ? gameService.tie(selection.roundNumber)
      : gameService.bothLose(selection.roundNumber)
    : gameService.select(selection.winnerSide, selection.roundNumber);
}

export async function getBufferHealth(): Promise<BufferHealth> {
  const [challengers, game] = await Promise.all([
    challengerRepository.load(),
    repository.load(),
  ]);
  const refillJobs = challengers?.refillJobs ?? [];
  const pending = (
    await Promise.all(
      refillJobs.map(({ jobId }) => fileGenerationMailbox.readPending(jobId)),
    )
  ).filter(Boolean).length;
  const draining = game
    ? refillJobs.filter(
        ({ expectedJob }) =>
          !refillJobMatchesGenerationPreferences(expectedJob, game),
      ).length
    : 0;
  const rules = effectiveGameRules(game, challengerConfig);
  return summarizeBufferHealth(
    challengers,
    rules.bufferTarget,
    rules.poolMaximum,
    {
      active: Math.max(0, refillJobs.length - pending),
      pending,
      draining,
    },
  );
}

export async function getImportProgress(): Promise<ImportProgress | null> {
  const current = await importSessionRepository.load();
  if (!current) return null;
  const status = await importSessionService.status(current.id);
  const session = await importSessionRepository.load();
  if (!session) return null;
  return {
    status: status.status,
    annotating: status.counts.annotating,
    ready: status.counts.ready,
    failed: status.counts.failed,
    unserved: status.counts.ready,
    activationDisplayServed: session.servedReceipts.filter(
      ({ kind }) => kind === "activation-display",
    ).length,
    dequeueServed: session.servedReceipts.filter(
      ({ kind }) => kind === "dequeue",
    ).length,
    initialFillPending: status.initialFill.pending,
    initialFillFailed: status.initialFill.failed,
    initialFillAttemptId:
      status.initialFill.failedAttemptId ??
      session.initialFillJobs.find(({ status: value }) => value === "pending")
        ?.attemptId ??
      null,
    initialFillFailureMessage: status.initialFill.failureMessage,
    activationTarget: 5,
  };
}

export async function refreshBufferHealth(): Promise<BufferHealth> {
  await reconcileImportPipeline();
  await gameService.reconcile();
  return getBufferHealth();
}

export async function getPoolLeaderboard() {
  await reconcileImportPipeline();
  await gameService.reconcile();
  const game = await repository.load();
  return {
    entries: summarizePoolLeaderboard(await challengerRepository.load()),
    poolMaximum: effectiveGameRules(game, challengerConfig).poolMaximum,
  };
}

export async function getFavoriteGallery() {
  await reconcileImportPipeline();
  await gameService.reconcile();
  return {
    entries: summarizeFavoriteGallery(await challengerRepository.load()),
  };
}

export async function getComparisonHistory() {
  await reconcileImportPipeline();
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
    effectiveGameRules(game, challengerConfig).poolMaximum,
  );
}

export async function getGameRules(): Promise<GameRules> {
  return effectiveGameRules(await repository.load(), challengerConfig);
}

export async function updateGameRules(rules: GameRules): Promise<GameState> {
  return gameService.updateGameRules(rules);
}

export async function updatePreferenceSeed(
  preferenceSeed: string,
  preferenceProfile?: PreferenceProfile,
  expectedPreferenceProfile?: PreferenceProfile,
  variationSourceCandidateId?: string | null,
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
    variationSourceCandidateId,
  );
}

export async function savePreferencePreset(
  name: string,
  profile: PreferenceProfile,
): Promise<GameState> {
  return gameService.savePreferencePreset(name, profile);
}

export async function deletePreferencePreset(
  presetId: string,
): Promise<GameState> {
  return gameService.deletePreferencePreset(presetId);
}

export async function createPromptCard(
  input: CreatePromptCardInput,
): Promise<GameState> {
  return gameService.createPromptCard(input);
}

export async function requestPromptCardBlend(
  cardIds: [string, string],
  ratio: number,
): Promise<GameState> {
  return gameService.requestPromptCardBlend(cardIds, ratio);
}

export async function requestPromptCardWriter(
  candidateIds: string[],
): Promise<GameState> {
  return gameService.requestPromptCardWriter(candidateIds);
}

export async function requestCustomPromptCardWriter(
  input: import("./prompt-card-writer-service").PromptCardWriterCustomInput,
): Promise<GameState> {
  return gameService.requestCustomPromptCardWriter(input);
}

export async function updatePromptDeck(
  update:
    | { kind: "deck"; enabled: boolean }
    | { kind: "card"; cardId: string; active?: boolean; weight?: number }
    | {
        kind: "suggestion";
        suggestionId: string;
        action: "accept" | "discard";
      },
): Promise<GameState> {
  return gameService.updatePromptDeck(update);
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

export function createOrResumeImportSession() {
  return importSessionService.createOrResume();
}

export async function getImportSessionStatus(sessionId?: string) {
  const status = await importSessionService.status(sessionId);
  await reconcileImportPipeline();
  return importSessionService.status(status.sessionId);
}

export function approveImportItem(sessionId: string, contents: Uint8Array) {
  return importSessionService.approve(sessionId, contents);
}

export async function sealImportSession(sessionId: string) {
  await importSessionService.seal(sessionId);
  await reconcileImportPipeline();
  return importSessionService.status(sessionId);
}

export function pauseImportSession(sessionId: string) {
  return importSessionService.pause(sessionId);
}

export function retryImportAnnotation(sessionId: string, itemId: string) {
  return importSessionService.retry(sessionId, itemId);
}

export function manuallyAnnotateImportItem(
  sessionId: string,
  itemId: string,
  input: ManualImportAnnotationInput,
) {
  return importSessionService.annotateManually(sessionId, itemId, input);
}

export function removeImportItem(sessionId: string, itemId: string) {
  return importSessionService.remove(sessionId, itemId);
}

export function retryImportInitialFill(
  sessionId: string,
  failedAttemptId: string,
  requestId: string,
) {
  return importSessionService.retryInitialFill(
    sessionId,
    failedAttemptId,
    requestId,
  );
}

export function abandonImportSession(sessionId: string) {
  return importSessionService.abandon(sessionId);
}

async function reconcileImportPipeline(): Promise<GameStartState | null> {
  const session = await importSessionRepository.load();
  if (session && session.status !== "completed") {
    await importSessionService.status(session.id);
  }
  return importActivationService.reconcile();
}
