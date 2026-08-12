import { NextResponse } from "next/server";
import { appVersionResponseHeaders } from "@/server/app-version";
import { refreshBufferHealth } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await refreshBufferHealth(), {
    headers: appVersionResponseHeaders(),
  });
}
