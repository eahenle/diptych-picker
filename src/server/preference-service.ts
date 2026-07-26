import { isDeepStrictEqual } from "node:util";
import type { ChallengerState } from "@/domain/challenger-state";
import {
  preferenceProfileFromSeed,
  type GameState,
  type PreferenceProfile,
} from "@/domain/game";
import type { GenerationJob } from "./agent-mailbox";
import type { ChallengerRepository } from "./challenger-repository";
import { appendPreferenceRevision } from "./game-adaptation";
import {
  MissingGameError,
  SelectionConflictError,
} from "./game-service-errors";
import {
  refillContext,
  type RefillCapacityResult,
  type RefillContext,
} from "./game-refill";
import type { GameRepository } from "./repository";

interface PreferenceServiceOptions {
  gameRepository: GameRepository;
  challengerRepository: ChallengerRepository;
  addRefillCapacity: (
    state: ChallengerState,
    context: RefillContext,
  ) => RefillCapacityResult;
  ensureJobsEnqueued: (jobs: readonly GenerationJob[]) => Promise<void>;
  now: () => string;
}

export class PreferenceService {
  constructor(private readonly options: PreferenceServiceOptions) {}

  async update(
    preferenceSeed: string,
    preferenceProfile: PreferenceProfile = preferenceProfileFromSeed(
      preferenceSeed,
    ),
    expectedPreferenceProfile?: PreferenceProfile,
    variationSourceCandidateId?: string | null,
  ): Promise<GameState> {
    return this.withStateLocks(async () => {
      const [current, challengers] = await Promise.all([
        this.options.gameRepository.load(),
        this.options.challengerRepository.load(),
      ]);
      if (!current) {
        throw new MissingGameError("Start a game before editing preferences");
      }
      const currentProfile =
        current.preferenceProfile ??
        preferenceProfileFromSeed(current.preferenceSeed);
      if (
        expectedPreferenceProfile !== undefined &&
        !isDeepStrictEqual(currentProfile, expectedPreferenceProfile)
      ) {
        throw new SelectionConflictError(
          "Preferences changed while this editor was open. Reopen Preferences and try again.",
        );
      }
      if (current.round.status === "generating") {
        throw new SelectionConflictError(
          "A challenger is already being generated",
        );
      }

      const variationSource = this.resolveVariationSource(
        current,
        challengers,
        variationSourceCandidateId,
      );
      const profileChanged = !isDeepStrictEqual(
        currentProfile,
        preferenceProfile,
      );
      const variationSourceChanged =
        current.variationSource?.candidateId !== variationSource?.candidateId;
      const preferenceRevisions =
        profileChanged || variationSourceChanged
          ? appendPreferenceRevision(
              current,
              preferenceProfile,
              variationSource ? "variation" : "manual",
              this.options.now(),
              variationSource,
            )
          : current.preferenceRevisions;
      const updated = this.withoutGenerationNotice({
        ...current,
        preferenceSeed,
        preferenceProfile,
        ...(preferenceRevisions ? { preferenceRevisions } : {}),
        ...(variationSource ? { variationSource } : {}),
      });
      if (!variationSource) delete updated.variationSource;
      await this.options.gameRepository.save(updated);
      const generationPreferencesChanged =
        current.preferenceSeed !== preferenceSeed ||
        (current.preferenceProfile?.adaptationMode ?? "static") !==
          preferenceProfile.adaptationMode ||
        (current.preferenceProfile?.adaptationStrength ?? "guided") !==
          (preferenceProfile.adaptationStrength ?? "guided") ||
        current.variationSource?.candidateId !==
          updated.variationSource?.candidateId;
      if (!challengers || !generationPreferencesChanged) {
        return updated;
      }

      // Ready candidates and completed refill results were proposed against
      // the previous brief. Keep unfinished records until their workers reach
      // a terminal state, but exclude them from replacement capacity and
      // discard their eventual results during reconciliation.
      let refreshed: ChallengerState = { ...challengers, ready: [] };
      const context = refillContext(updated, refreshed);
      const capacity: RefillCapacityResult = context
        ? this.options.addRefillCapacity(refreshed, context)
        : { state: refreshed, jobs: [] };
      refreshed = capacity.state;
      await this.options.challengerRepository.save(refreshed);
      await this.options.ensureJobsEnqueued(capacity.jobs);
      return updated;
    });
  }

  private resolveVariationSource(
    game: GameState,
    challengers: ChallengerState | null,
    candidateId: string | null | undefined,
  ) {
    if (candidateId === undefined) return game.variationSource;
    if (candidateId === null) return undefined;
    const candidates = [
      game.round.leftCandidate,
      game.round.rightCandidate,
      ...(challengers?.ratings.map(({ candidate }) => candidate) ?? []),
    ];
    const source = candidates.find((candidate) => candidate.id === candidateId);
    if (!source) {
      throw new SelectionConflictError(
        "That variation source is no longer available in this game.",
      );
    }
    return { candidateId: source.id, concept: source.concept };
  }

  private withoutGenerationNotice(game: GameState): GameState {
    if (!game.generationNotice) return game;
    const updated = { ...game };
    delete updated.generationNotice;
    return updated;
  }

  private withStateLocks<T>(operation: () => Promise<T>): Promise<T> {
    return this.options.gameRepository.withLock(() =>
      this.options.challengerRepository.withLock(operation),
    );
  }
}
