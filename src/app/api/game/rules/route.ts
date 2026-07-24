import { NextResponse } from "next/server";
import { z } from "zod";
import { GAME_RULE_BOUNDS } from "@/domain/game";
import { GameRulesError, MissingGameError } from "@/server/game-service";
import { getGameRules, updateGameRules } from "@/server/runtime";

export const dynamic = "force-dynamic";

const gameRulesSchema = z
  .object({
    bufferTarget: z
      .number()
      .int()
      .min(GAME_RULE_BOUNDS.bufferTarget.min)
      .max(GAME_RULE_BOUNDS.bufferTarget.max),
    poolMaximum: z
      .number()
      .int()
      .min(GAME_RULE_BOUNDS.poolMaximum.min)
      .max(GAME_RULE_BOUNDS.poolMaximum.max),
    championRetirementStreak: z
      .number()
      .int()
      .min(GAME_RULE_BOUNDS.championRetirementStreak.min)
      .max(GAME_RULE_BOUNDS.championRetirementStreak.max),
    fallbackMaximumConsecutive: z
      .number()
      .int()
      .min(GAME_RULE_BOUNDS.fallbackMaximumConsecutive.min)
      .max(GAME_RULE_BOUNDS.fallbackMaximumConsecutive.max),
  })
  .strict();

export async function GET() {
  return NextResponse.json({ rules: await getGameRules() });
}

export async function PATCH(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Game rules must be valid JSON." },
      { status: 400 },
    );
  }
  const parsed = gameRulesSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Every game rule must be a whole number within its range." },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(await updateGameRules(parsed.data));
  } catch (error) {
    if (error instanceof GameRulesError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof MissingGameError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
