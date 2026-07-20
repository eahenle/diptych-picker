import { NextResponse } from "next/server";
import { z } from "zod";
import {
  composePreferenceSeed,
  preferenceProfileFromSeed,
} from "@/domain/game";
import { SelectionConflictError } from "@/server/game-service";
import {
  generationProvider,
  getBufferHealth,
  getDisplayedEloRatings,
  getOrCreateGame,
  updatePreferenceSeed,
} from "@/server/runtime";

export const dynamic = "force-dynamic";

const preferenceProfileSchema = z
  .object({
    themes: z
      .string()
      .max(2_000)
      .refine((value) => value.trim().length >= 20),
    inspiration: z.string().max(1_000).default(""),
    adaptationMode: z.enum(["static", "adaptive"]).default("static"),
    adaptationSourceWinnerIds: z
      .array(z.string().trim().min(1).max(200))
      .max(12)
      .default([]),
    mediaTypes: z.string().max(500),
    visualStyle: z.string().max(500),
    colorPalette: z.string().max(500),
    contentLevel: z.enum(["family-friendly", "adult-allowed"]),
    avoid: z.string().max(800),
  })
  .strict();

const preferencePatchSchema = z
  .union([
    z
      .object({
        preferenceProfile: preferenceProfileSchema,
        expectedPreferenceProfile: preferenceProfileSchema.optional(),
      })
      .strict(),
    z
      .object({
        preferenceSeed: z.string().trim().min(20).max(4_000),
        expectedPreferenceProfile: preferenceProfileSchema.optional(),
      })
      .strict(),
  ])
  .transform((value) => {
    const preferenceProfile =
      "preferenceProfile" in value
        ? value.preferenceProfile
        : preferenceProfileFromSeed(value.preferenceSeed);
    return {
      preferenceProfile,
      expectedPreferenceProfile: value.expectedPreferenceProfile,
      preferenceSeed:
        "preferenceProfile" in value
          ? composePreferenceSeed(preferenceProfile)
          : value.preferenceSeed,
    };
  })
  .refine(({ preferenceSeed }) => preferenceSeed.length <= 4_000);

export async function GET() {
  const state = await getOrCreateGame();
  const response =
    state.status === "ready"
      ? {
          ...state,
          bufferHealth: await getBufferHealth(),
          eloRatings: await getDisplayedEloRatings(state.game),
        }
      : state;
  return NextResponse.json(response, {
    headers: { "X-Diptych-Generation-Provider": generationProvider },
  });
}

export async function PATCH(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Preference profile must be valid JSON." },
      { status: 400 },
    );
  }
  const parsed = preferencePatchSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json(
      {
        error:
          "Themes must be at least 20 characters and preference fields must stay within their limits.",
      },
      { status: 400 },
    );
  try {
    return NextResponse.json(
      await updatePreferenceSeed(
        parsed.data.preferenceSeed,
        parsed.data.preferenceProfile,
        parsed.data.expectedPreferenceProfile,
      ),
    );
  } catch (error) {
    if (error instanceof SelectionConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
