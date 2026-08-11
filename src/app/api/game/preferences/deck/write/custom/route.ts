import { NextResponse } from "next/server";
import { MissingGameError, PromptDeckError } from "@/server/game-service";
import { requestCustomPromptCardWriter } from "@/server/runtime";
import { SourceProfileInputError } from "@/server/source-profile-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  if (!form) {
    return NextResponse.json(
      { error: "Submit text guidance, seed images, or both." },
      { status: 400 },
    );
  }
  const guidanceEntry = form.get("guidance");
  const guidance =
    typeof guidanceEntry === "string" ? guidanceEntry.trim() : "";
  const imageEntries = form.getAll("images");
  if (
    guidance.length > 2_000 ||
    imageEntries.length > 5 ||
    (guidance.length === 0 && imageEntries.length === 0) ||
    imageEntries.some((entry) => typeof entry === "string")
  ) {
    return NextResponse.json(
      { error: "Add text guidance, one to five seed images, or both." },
      { status: 400 },
    );
  }

  try {
    const images = await Promise.all(
      imageEntries.map(async (entry) => {
        const image = entry as File;
        return {
          filename: image.name,
          contentType: image.type,
          contents: new Uint8Array(await image.arrayBuffer()),
        };
      }),
    );
    return NextResponse.json(
      await requestCustomPromptCardWriter({ guidance, images }),
    );
  } catch (error) {
    if (error instanceof MissingGameError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof SourceProfileInputError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    if (error instanceof PromptDeckError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
