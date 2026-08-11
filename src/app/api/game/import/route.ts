import { z } from "zod";
import {
  abandonImportSession,
  createOrResumeImportSession,
  getImportSessionStatus,
  pauseImportSession,
  retryImportInitialFill,
} from "@/server/runtime";
import { importErrorResponse, importIdSchema, noStoreJson } from "./http";

export const dynamic = "force-dynamic";

const pauseSchema = z
  .object({
    action: z.literal("pause"),
    sessionId: importIdSchema,
  })
  .strict();
const retryInitialFillSchema = z
  .object({
    action: z.literal("retry-initial-fill"),
    sessionId: importIdSchema,
    failedAttemptId: importIdSchema,
    requestId: importIdSchema,
  })
  .strict();
const patchSchema = z.discriminatedUnion("action", [
  pauseSchema,
  retryInitialFillSchema,
]);
const sessionSchema = z.object({ sessionId: importIdSchema }).strict();

export async function GET(request: Request) {
  const rawSessionId = new URL(request.url).searchParams.get("sessionId");
  const sessionId = rawSessionId
    ? importIdSchema.safeParse(rawSessionId)
    : null;
  if (sessionId && !sessionId.success) {
    return noStoreJson(
      { error: "A valid image-import session is required." },
      400,
    );
  }
  try {
    return noStoreJson(
      await getImportSessionStatus(
        sessionId?.success ? sessionId.data : undefined,
      ),
    );
  } catch (error) {
    return importErrorResponse(error);
  }
}

export async function POST() {
  try {
    return noStoreJson(await createOrResumeImportSession());
  } catch (error) {
    return importErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return noStoreJson({ error: "That image-import action is invalid." }, 400);
  }
  try {
    if (parsed.data.action === "pause") {
      return noStoreJson(await pauseImportSession(parsed.data.sessionId));
    }
    return noStoreJson(
      await retryImportInitialFill(
        parsed.data.sessionId,
        parsed.data.failedAttemptId,
        parsed.data.requestId,
      ),
    );
  } catch (error) {
    return importErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  const parsed = sessionSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return noStoreJson(
      { error: "A valid image-import session is required." },
      400,
    );
  }
  try {
    await abandonImportSession(parsed.data.sessionId);
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return importErrorResponse(error);
  }
}
