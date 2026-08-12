import { NextResponse } from "next/server";
import { z } from "zod";
import {
  MissingGameError,
  SelectionConflictError,
} from "@/server/game-service";
import { getDisplayedEloRatings, selectGameRound } from "@/server/runtime";

export const dynamic = "force-dynamic";

const selectionSchema = z.union([
  z
    .object({
      winnerSide: z.enum(["left", "right"]),
      roundNumber: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      outcome: z.enum(["tie", "both-lose"]),
      roundNumber: z.number().int().positive(),
    })
    .strict(),
]);

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Selection must be valid JSON." },
      { status: 400 },
    );
  }
  const parsed = selectionSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid selection." }, { status: 400 });

  try {
    const game = await selectGameRound(parsed.data);
    return NextResponse.json(
      { ...game, eloRatings: await getDisplayedEloRatings(game) },
      {
        status: game.round.status === "idle" ? 200 : 202,
      },
    );
  } catch (error) {
    if (error instanceof SelectionConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof MissingGameError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
