export const APP_VERSION_HEADER = "X-Diptych-App-Version";

export function appVersionsDiffer(
  clientVersion: string,
  serverVersion: string | null,
): boolean {
  const normalizedServerVersion = serverVersion?.trim();
  return Boolean(
    normalizedServerVersion && normalizedServerVersion !== clientVersion,
  );
}
