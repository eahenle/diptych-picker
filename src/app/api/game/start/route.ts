import { NextResponse } from "next/server";
import { SelectionConflictError } from "@/server/game-service";
import {
  getBufferHealth,
  getDisplayedEloRatings,
  getGameStartupStatus,
  resetGame,
} from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getGameStartupStatus());
}

export async function POST() {
  try {
    const state = await resetGame();
    return NextResponse.json(
      state.status === "ready"
        ? {
            ...state,
            bufferHealth: await getBufferHealth(),
            eloRatings: await getDisplayedEloRatings(state.game),
          }
        : state,
    );
  } catch (error) {
    if (error instanceof SelectionConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
