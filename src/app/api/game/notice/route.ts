import { NextResponse } from "next/server";
import { dismissGenerationNotice } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function DELETE() {
  return NextResponse.json(await dismissGenerationNotice());
}
