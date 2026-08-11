import { NextResponse } from "next/server";
import { z } from "zod";
import { GENERATION_JOB_ID_PATTERN } from "@/domain/game";
import { ImportSessionServiceError } from "@/server/import-session-service";

export const importIdSchema = z
  .string()
  .trim()
  .regex(GENERATION_JOB_ID_PATTERN);

export function noStoreJson(value: unknown, status = 200) {
  return NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function importErrorResponse(error: unknown) {
  if (error instanceof ImportSessionServiceError) {
    return noStoreJson({ error: error.message }, error.status);
  }
  throw error;
}
