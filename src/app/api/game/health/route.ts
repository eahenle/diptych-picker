import { NextResponse } from "next/server";
import { refreshBufferHealth } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await refreshBufferHealth());
}
