import { approveImportItem } from "@/server/runtime";
import { importErrorResponse, importIdSchema, noStoreJson } from "../http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return noStoreJson(
      { error: "Upload one normalized square PNG image." },
      400,
    );
  }
  const sessionId = importIdSchema.safeParse(form.get("sessionId"));
  const image = form.get("image");
  if (
    !sessionId.success ||
    !(image instanceof File) ||
    image.type !== "image/png"
  ) {
    return noStoreJson(
      { error: "Upload one normalized square PNG for a valid import session." },
      400,
    );
  }
  try {
    const status = await approveImportItem(
      sessionId.data,
      new Uint8Array(await image.arrayBuffer()),
    );
    return noStoreJson(status, 202);
  } catch (error) {
    return importErrorResponse(error);
  }
}
