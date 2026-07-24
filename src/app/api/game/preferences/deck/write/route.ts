import { NextResponse } from "next/server";
import { z } from "zod";
import { MissingGameError, PromptDeckError } from "@/server/game-service";
import { requestPromptCardWriter } from "@/server/runtime";

export const dynamic = "force-dynamic";

const writerSchema = z
  .object({
    candidateIds: z.array(z.string().trim().min(1).max(200)).min(3).max(5),
  })
  .strict()
  .refine(
    ({ candidateIds }) => new Set(candidateIds).size === candidateIds.length,
    {
      message: "Prompt-card writer sources must be distinct",
      path: ["candidateIds"],
    },
  );

export async function POST(request: Request) {
  const parsed = writerSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Choose three to five distinct generated favorites." },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(
      await requestPromptCardWriter(parsed.data.candidateIds),
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
