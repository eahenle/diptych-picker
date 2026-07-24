import {
  GAME_RULE_BOUNDS,
  type GameRules,
  type GameState,
} from "@/domain/game";

interface GameRuleDefaults {
  bufferTarget: number;
  poolMaximum: number;
  fallbackMaximumConsecutive: number;
}

function boundedDefault(
  value: number,
  bounds: { readonly min: number; readonly max: number },
): number {
  return Math.min(bounds.max, Math.max(bounds.min, Math.floor(value)));
}

export function configuredGameRules(defaults: GameRuleDefaults): GameRules {
  return {
    bufferTarget: boundedDefault(
      defaults.bufferTarget,
      GAME_RULE_BOUNDS.bufferTarget,
    ),
    poolMaximum: boundedDefault(
      defaults.poolMaximum,
      GAME_RULE_BOUNDS.poolMaximum,
    ),
    championRetirementStreak: 10,
    fallbackMaximumConsecutive: boundedDefault(
      defaults.fallbackMaximumConsecutive,
      GAME_RULE_BOUNDS.fallbackMaximumConsecutive,
    ),
  };
}

export function effectiveGameRules(
  game: GameState | null | undefined,
  defaults: GameRuleDefaults,
): GameRules {
  return game?.gameRules ?? configuredGameRules(defaults);
}

export function validGameRules(rules: GameRules): boolean {
  return (
    Object.entries(GAME_RULE_BOUNDS) as Array<
      [keyof GameRules, { readonly min: number; readonly max: number }]
    >
  ).every(
    ([key, bounds]) =>
      Number.isInteger(rules[key]) &&
      rules[key] >= bounds.min &&
      rules[key] <= bounds.max,
  );
}
