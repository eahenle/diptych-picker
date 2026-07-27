import { NextRequest, NextResponse } from "next/server";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

function requestHost(request: NextRequest): {
  hostname: string;
  origin: string;
} {
  const host = request.headers.get("host") ?? request.nextUrl.host;
  const parsed = new URL(`${request.nextUrl.protocol}//${host}`);
  return { hostname: parsed.hostname, origin: parsed.origin };
}

export function proxy(request: NextRequest) {
  const host = requestHost(request);
  if (!LOOPBACK_HOSTNAMES.has(host.hostname)) {
    return NextResponse.json(
      { error: "Diptych Picker accepts local requests only." },
      { status: 403 },
    );
  }

  if (SAFE_METHODS.has(request.method)) {
    return NextResponse.next();
  }

  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    fetchSite === "cross-site" ||
    (origin !== null && origin !== host.origin)
  ) {
    return NextResponse.json(
      { error: "Cross-origin changes are not allowed." },
      { status: 403 },
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
