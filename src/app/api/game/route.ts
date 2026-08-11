import { NextResponse } from "next/server";
import { z } from "zod";
import {
  composePreferenceSeed,
  preferenceProfileFromSeed,
} from "@/domain/game";
import { SelectionConflictError } from "@/server/game-service";
import { preferenceProfileRequestSchema as preferenceProfileSchema } from "@/server/preference-profile-schema";
import {
  generationProvider,
  getBufferHealth,
  getDisplayedEloRatings,
  getImportProgress,
  getOrCreateGame,
  updatePreferenceSeed,
} from "@/server/runtime";

export const dynamic = "force-dynamic";

const preferencePatchSchema = z
  .union([
    z
      .object({
        preferenceProfile: preferenceProfileSchema,
        expectedPreferenceProfile: preferenceProfileSchema.optional(),
        variationSourceCandidateId: z
          .string()
          .trim()
          .min(1)
          .nullable()
          .optional(),
      })
      .strict(),
    z
      .object({
        preferenceSeed: z.string().trim().min(20).max(4_000),
        expectedPreferenceProfile: preferenceProfileSchema.optional(),
        variationSourceCandidateId: z
          .string()
          .trim()
          .min(1)
          .nullable()
          .optional(),
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
      variationSourceCandidateId: value.variationSourceCandidateId,
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
          importProgress: await getImportProgress(),
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
        parsed.data.variationSourceCandidateId,
      ),
    );
  } catch (error) {
    if (error instanceof SelectionConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
