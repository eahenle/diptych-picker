import type {
  ChallengerState,
  LeaderboardVisualProfile,
} from "@/domain/challenger-state";
import {
  applyWinnerPreferenceRevision,
  composePreferenceSeed,
  preferenceAdaptationStrength,
  preferenceProfileFromSeed,
  recordRejectedPreferenceEvidence,
  type Candidate,
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
  leaderboardVisualProfile: LeaderboardVisualProfile | null = null,
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
    const revisionCandidate = winner
      ? candidateWithUnfetteredLeaderboardRevision(
          winner.candidate,
          profile,
          leaderboardVisualProfile,
        )
      : null;
    nextProfile = revisionCandidate
      ? applyWinnerPreferenceRevision(
          profile,
          revisionCandidate,
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

function candidateWithUnfetteredLeaderboardRevision(
  winner: Candidate,
  profile: PreferenceProfile,
  leaderboardVisualProfile: LeaderboardVisualProfile | null,
): Candidate {
  if (
    winner.preferenceRevision ||
    preferenceAdaptationStrength(profile) !== "unfettered" ||
    !leaderboardVisualProfile
  ) {
    return winner;
  }
  const leaderboardRevision = leaderboardVisualProfile.profile;
  return {
    ...winner,
    preferenceRevision: {
      ...leaderboardRevision,
      contentLevel: profile.contentLevel,
      avoid: mergeAvoidGuidance(profile.avoid, leaderboardRevision.avoid),
    },
  };
}

function mergeAvoidGuidance(explicit: string, inferred: string): string {
  const values = [explicit.trim(), inferred.trim()].filter(Boolean);
  return [...new Set(values)].join(", ").slice(0, 800);
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
