import { NextResponse } from "next/server";
import { z } from "zod";
import { MissingGameError, PromptDeckError } from "@/server/game-service";
import { requestPromptCardBlend } from "@/server/runtime";

export const dynamic = "force-dynamic";

const blendSchema = z
  .object({
    cardIds: z.tuple([z.string().trim().min(1), z.string().trim().min(1)]),
    ratio: z.number().min(0.1).max(0.9).default(0.5),
  })
  .strict()
  .refine(({ cardIds }) => cardIds[0] !== cardIds[1], {
    message: "Prompt cards must be distinct",
    path: ["cardIds"],
  });

export async function POST(request: Request) {
  const parsed = blendSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Choose two distinct prompt cards to blend." },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(
      await requestPromptCardBlend(parsed.data.cardIds, parsed.data.ratio),
    );
  } catch (error) {
    if (error instanceof MissingGameError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof PromptDeckError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
