import { NextResponse } from "next/server";
import { z } from "zod";
import {
  MissingGameError,
  SelectionConflictError,
} from "@/server/game-service";
import { gameService, getDisplayedEloRatings } from "@/server/runtime";

export const dynamic = "force-dynamic";

const SelectionSchema = z.object({
  winnerSide: z.enum(["left", "right"]),
  roundNumber: z.number().int().positive(),
});

export async function POST(request: Request) {
  const parsed = SelectionSchema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid selection." }, { status: 400 });

  try {
    const game = await gameService.select(
      parsed.data.winnerSide,
      parsed.data.roundNumber,
    );
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
