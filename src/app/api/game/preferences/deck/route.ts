import { NextResponse } from "next/server";
import { z } from "zod";
import { MissingGameError, PromptDeckError } from "@/server/game-service";
import { createPromptCard, updatePromptDeck } from "@/server/runtime";

export const dynamic = "force-dynamic";

const createCardSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    prompt: z.string().trim().min(20).max(1_000),
    negativePrompt: z.string().max(500).default(""),
    weight: z.number().positive().max(100).default(1),
    tags: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
    parents: z.array(z.string().trim().min(1)).max(5).optional(),
  })
  .strict();

const updateDeckSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("deck"), enabled: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal("card"),
      cardId: z.string().trim().min(1),
      active: z.boolean().optional(),
      weight: z.number().positive().max(100).optional(),
    })
    .strict()
    .refine(
      (value) => value.active !== undefined || value.weight !== undefined,
      "A card update is required",
    ),
]);

function errorResponse(error: unknown) {
  if (error instanceof MissingGameError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof PromptDeckError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  throw error;
}

export async function POST(request: Request) {
  const parsed = createCardSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Prompt card fields are invalid." },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(await createPromptCard(parsed.data));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  const parsed = updateDeckSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Prompt deck update is invalid." },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(await updatePromptDeck(parsed.data));
  } catch (error) {
    return errorResponse(error);
  }
}
