import { NextResponse } from "next/server";
import { z } from "zod";
import {
  CandidateFavoriteNotFoundError,
  setCandidateFavorite,
} from "@/server/runtime";

export const dynamic = "force-dynamic";

const favoriteSchema = z
  .object({
    candidateId: z.string().trim().min(1).max(200),
    favorite: z.boolean(),
  })
  .strict();

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Favorite update must be valid JSON" },
      { status: 400 },
    );
  }
  const parsed = favoriteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Favorite update is invalid" },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(
      await setCandidateFavorite(parsed.data.candidateId, parsed.data.favorite),
    );
  } catch (error) {
    if (error instanceof CandidateFavoriteNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
