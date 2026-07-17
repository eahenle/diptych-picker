import { NextResponse } from "next/server";
import { SelectionConflictError } from "@/server/game-service";
import { resetGame } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    return NextResponse.json(await resetGame());
  } catch (error) {
    if (error instanceof SelectionConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
