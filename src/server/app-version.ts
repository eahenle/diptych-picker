import { APP_VERSION_HEADER } from "@/domain/app-version";

export const appBuildVersion =
  process.env.APP_BUILD_VERSION?.trim() ||
  process.env.NEXT_PUBLIC_APP_BUILD_VERSION?.trim() ||
  "development";

export function appVersionResponseHeaders(): Record<string, string> {
  return {
    [APP_VERSION_HEADER]: appBuildVersion,
    "Cache-Control": "no-store",
  };
}
