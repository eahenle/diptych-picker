import { NextResponse } from "next/server";
import { GENERATION_JOB_ID_PATTERN } from "@/domain/game";
import {
  acknowledgeSourceProfile,
  getSourceProfileStatus,
  requestSourceProfile,
} from "@/server/runtime";
import {
  SourceProfileInputError,
  SourceProfileNotFoundError,
} from "@/server/source-profile-service";

export const dynamic = "force-dynamic";

function jobIdFrom(request: Request): string | null {
  const jobId = new URL(request.url).searchParams.get("jobId");
  return jobId && GENERATION_JOB_ID_PATTERN.test(jobId) ? jobId : null;
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Upload one PNG, JPEG, or WebP source image." },
      { status: 400 },
    );
  }
  const image = form.get("image");
  if (!(image instanceof File)) {
    return NextResponse.json(
      { error: "Upload one PNG, JPEG, or WebP source image." },
      { status: 400 },
    );
  }
  try {
    const result = await requestSourceProfile(
      new Uint8Array(await image.arrayBuffer()),
      image.type,
    );
    return NextResponse.json(result, {
      status: 202,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof SourceProfileInputError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    throw error;
  }
}

export async function GET(request: Request) {
  const jobId = jobIdFrom(request);
  if (!jobId) {
    return NextResponse.json(
      { error: "A valid source-image analysis job is required." },
      { status: 400 },
    );
  }
  try {
    const result = await getSourceProfileStatus(jobId);
    return NextResponse.json(result, {
      status: result.status === "analyzing" ? 202 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof SourceProfileNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}

export async function DELETE(request: Request) {
  const jobId = jobIdFrom(request);
  if (!jobId) {
    return NextResponse.json(
      { error: "A valid source-image analysis job is required." },
      { status: 400 },
    );
  }
  try {
    await acknowledgeSourceProfile(jobId);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof SourceProfileNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
