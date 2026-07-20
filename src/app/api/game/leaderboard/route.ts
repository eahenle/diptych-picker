import { NextResponse } from "next/server";
import { getPoolLeaderboard } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getPoolLeaderboard(), {
    headers: { "Cache-Control": "no-store" },
  });
}
