import { NextResponse } from "next/server";
import { getComparisonHistory } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getComparisonHistory(), {
    headers: { "Cache-Control": "no-store" },
  });
}
