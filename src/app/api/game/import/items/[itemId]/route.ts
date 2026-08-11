import { z } from "zod";
import {
  manuallyAnnotateImportItem,
  removeImportItem,
  retryImportAnnotation,
} from "@/server/runtime";
import { importErrorResponse, importIdSchema, noStoreJson } from "../../http";

export const dynamic = "force-dynamic";

const retrySchema = z
  .object({
    action: z.literal("retry"),
    sessionId: importIdSchema,
  })
  .strict();
const manualSchema = z
  .object({
    action: z.literal("manual"),
    sessionId: importIdSchema,
    concept: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(500),
    style: z.array(z.string().trim().min(1).max(80)).min(1).max(8),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.style).size !== value.style.length) {
      context.addIssue({
        code: "custom",
        path: ["style"],
        message: "Style tags must be unique",
      });
    }
  });
const removeSchema = z
  .object({
    action: z.literal("remove"),
    sessionId: importIdSchema,
  })
  .strict();
const actionSchema = z.discriminatedUnion("action", [
  retrySchema,
  manualSchema,
  removeSchema,
]);

export async function PATCH(
  request: Request,
  context: { params: Promise<{ itemId: string }> },
) {
  const { itemId: rawItemId } = await context.params;
  const itemId = importIdSchema.safeParse(rawItemId);
  const body = actionSchema.safeParse(await request.json().catch(() => null));
  if (!itemId.success || !body.success) {
    return noStoreJson(
      { error: "That imported-image action is invalid." },
      400,
    );
  }
  try {
    if (body.data.action === "retry") {
      return noStoreJson(
        await retryImportAnnotation(body.data.sessionId, itemId.data),
        202,
      );
    }
    if (body.data.action === "remove") {
      return noStoreJson(
        await removeImportItem(body.data.sessionId, itemId.data),
      );
    }
    return noStoreJson(
      await manuallyAnnotateImportItem(body.data.sessionId, itemId.data, {
        concept: body.data.concept,
        prompt: body.data.prompt,
        style: body.data.style,
      }),
    );
  } catch (error) {
    return importErrorResponse(error);
  }
}
