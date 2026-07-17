import { NextResponse } from "next/server";
import { z } from "zod";
import { SelectionConflictError } from "@/server/game-service";
import {
  generationProvider,
  getOrCreateGame,
  updatePreferenceSeed,
} from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getOrCreateGame(), {
    headers: { "X-Diptych-Generation-Provider": generationProvider },
  });
}

export async function PATCH(request: Request) {
  const parsed = z
    .object({ preferenceSeed: z.string().trim().min(20).max(4000) })
    .safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json(
      { error: "Preference profile must be 20–4000 characters." },
      { status: 400 },
    );
  try {
    return NextResponse.json(
      await updatePreferenceSeed(parsed.data.preferenceSeed),
    );
  } catch (error) {
    if (error instanceof SelectionConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
