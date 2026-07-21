import { NextResponse } from "next/server";
import { z } from "zod";
import {
  MissingGameError,
  PreferencePresetLimitError,
} from "@/server/game-service";
import { deletePreferencePreset, savePreferencePreset } from "@/server/runtime";

export const dynamic = "force-dynamic";

const preferenceProfileSchema = z
  .object({
    themes: z
      .string()
      .max(2_000)
      .refine((value) => value.trim().length >= 20),
    inspiration: z.string().max(1_000),
    mediaTypes: z.string().max(500),
    visualStyle: z.string().max(500),
    colorPalette: z.string().max(500),
    contentLevel: z.enum(["family-friendly", "adult-allowed"]),
    avoid: z.string().max(800),
    adaptationMode: z.enum(["static", "adaptive"]),
    adaptationStrength: z.enum(["guided", "unfettered"]).optional(),
    adaptationLastDecision: z.number().int().nonnegative().optional(),
    adaptationSourceWinnerIds: z
      .array(z.string().trim().min(1).max(200))
      .max(12),
    adaptationSourceRejectedIds: z
      .array(z.string().trim().min(1).max(200))
      .max(12),
  })
  .strict();

const savePresetSchema = z
  .object({
    name: z.string().trim().min(1).max(50),
    profile: preferenceProfileSchema,
  })
  .strict();

const deletePresetSchema = z
  .object({ presetId: z.string().trim().min(1) })
  .strict();

function errorResponse(error: unknown) {
  if (error instanceof MissingGameError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof PreferencePresetLimitError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  throw error;
}

export async function POST(request: Request) {
  const parsed = savePresetSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Preset name and preference profile are invalid." },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(
      await savePreferencePreset(parsed.data.name, parsed.data.profile),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  const parsed = deletePresetSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Preset id is required." },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(
      await deletePreferencePreset(parsed.data.presetId),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
