import { NextResponse } from "next/server";
import { SelectionConflictError } from "@/server/game-service";
import {
  GameSnapshotUnavailableError,
  InvalidGameSnapshotError,
  MAX_GAME_SNAPSHOT_BYTES,
} from "@/server/game-snapshot";
import {
  exportGameSnapshot,
  getBufferHealth,
  getDisplayedEloRatings,
  importGameSnapshot,
  publishGameExport,
} from "@/server/runtime";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown): NextResponse | null {
  if (error instanceof InvalidGameSnapshotError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (
    error instanceof GameSnapshotUnavailableError ||
    error instanceof SelectionConflictError
  ) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  return null;
}

export async function GET() {
  try {
    const snapshot = await exportGameSnapshot();
    const body = `${JSON.stringify(snapshot, null, 2)}\n`;
    const artifact = await publishGameExport(Buffer.from(body, "utf8"));
    return new NextResponse(body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${artifact.filename}"`,
        "X-Diptych-Export-Path": artifact.path,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    throw error;
  }
}

export async function PUT(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_GAME_SNAPSHOT_BYTES
  ) {
    return NextResponse.json(
      { error: "The selected save file is too large" },
      { status: 413 },
    );
  }

  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_GAME_SNAPSHOT_BYTES) {
    return NextResponse.json(
      { error: "The selected save file is too large" },
      { status: 413 },
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { error: "The selected file is not valid JSON" },
      { status: 400 },
    );
  }

  try {
    const game = await importGameSnapshot(value);
    return NextResponse.json({
      status: "ready",
      game,
      bufferHealth: await getBufferHealth(),
      eloRatings: await getDisplayedEloRatings(game),
    });
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    throw error;
  }
}
