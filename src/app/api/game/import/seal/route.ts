import { z } from "zod";
import { sealImportSession } from "@/server/runtime";
import { importErrorResponse, importIdSchema, noStoreJson } from "../http";

export const dynamic = "force-dynamic";

const requestSchema = z.object({ sessionId: importIdSchema }).strict();

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return noStoreJson(
      { error: "A valid image-import session is required." },
      400,
    );
  }
  try {
    return noStoreJson(await sealImportSession(parsed.data.sessionId), 202);
  } catch (error) {
    return importErrorResponse(error);
  }
}
