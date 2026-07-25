import type { ChallengerState } from "@/domain/challenger-state";
import {
  applyWinnerPreferenceRevision,
  composePreferenceSeed,
  preferenceProfileFromSeed,
  recordRejectedPreferenceEvidence,
  type GameState,
  type PreferenceProfile,
  type PreferenceProfileSnapshot,
} from "@/domain/game";

export interface AdaptivePreferenceResult {
  game: GameState;
  challengers: ChallengerState;
}

export function applyAdaptivePreferences(
  game: GameState,
  challengers: ChallengerState,
): AdaptivePreferenceResult {
  const selection = game.history.at(-1);
  const profile = game.preferenceProfile;
  if (
    !selection ||
    selection.outcome === "tie" ||
    !profile ||
    profile.adaptationMode !== "adaptive"
  ) {
    return { game, challengers };
  }

  let nextProfile = profile;
  if (selection.outcome === "both-lose") {
    for (const rejectedId of [selection.leftId, selection.rightId]) {
      const rejected = challengers.ratings.find(
        ({ candidate }) => candidate.id === rejectedId,
      );
      if (rejected?.source === "generated") {
        nextProfile = recordRejectedPreferenceEvidence(
          nextProfile,
          rejected.candidate.id,
        );
      }
    }
  } else {
    const winner = challengers.ratings.find(
      ({ candidate }) => candidate.id === selection.winnerId,
    );
    const rejected = challengers.ratings.find(
      ({ candidate }) => candidate.id === selection.loserId,
    );
    nextProfile = winner
      ? applyWinnerPreferenceRevision(
          profile,
          winner.candidate,
          game.history.length,
        )
      : profile;
    if (rejected?.source === "generated") {
      nextProfile = recordRejectedPreferenceEvidence(
        nextProfile,
        rejected.candidate.id,
      );
    }
  }

  if (nextProfile === profile) return { game, challengers };
  const composedProfile = composePreferenceSeed(profile);
  const composedNextProfile = composePreferenceSeed(nextProfile);
  const preferenceSeed =
    composedNextProfile === composedProfile
      ? game.preferenceSeed
      : composedNextProfile;
  const preferenceRevisions =
    preferenceSeed === game.preferenceSeed
      ? game.preferenceRevisions
      : appendPreferenceRevision(
          game,
          nextProfile,
          "adaptive",
          selection.selectedAt,
          game.variationSource,
        );
  return {
    game: {
      ...game,
      preferenceProfile: nextProfile,
      preferenceSeed,
      ...(preferenceRevisions ? { preferenceRevisions } : {}),
    },
    challengers:
      preferenceSeed === game.preferenceSeed
        ? challengers
        : { ...challengers, ready: [] },
  };
}

export function appendPreferenceRevision(
  game: GameState,
  profile: PreferenceProfile,
  source: PreferenceProfileSnapshot["source"],
  createdAt: string,
  variationSource = game.variationSource,
): PreferenceProfileSnapshot[] {
  const previous = game.preferenceRevisions ?? [];
  const baseline: PreferenceProfileSnapshot[] =
    previous.length > 0
      ? previous
      : [
          {
            createdAt,
            source: "initial",
            profile:
              game.preferenceProfile ??
              preferenceProfileFromSeed(game.preferenceSeed),
            ...(game.variationSource
              ? { variationSource: game.variationSource }
              : {}),
          },
        ];
  return [
    ...baseline,
    {
      createdAt,
      source,
      profile,
      ...(variationSource ? { variationSource } : {}),
    },
  ].slice(-25);
}
