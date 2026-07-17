import { NextResponse } from "next/server";
import { assetStore } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ filename: string }> },
) {
  const { filename } = await context.params;
  try {
    const bytes = await assetStore.read(filename);
    const contentType = filename.endsWith(".svg")
      ? "image/svg+xml"
      : filename.endsWith(".webp")
        ? "image/webp"
        : "image/png";
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
