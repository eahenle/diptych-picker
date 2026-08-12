"use client";

import { useCallback, useState } from "react";
import { APP_VERSION_HEADER, appVersionsDiffer } from "@/domain/app-version";

const CLIENT_APP_BUILD_VERSION =
  process.env.NEXT_PUBLIC_APP_BUILD_VERSION?.trim() || "development";

export function useAppVersion() {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  const observeServerResponse = useCallback((response: Response) => {
    if (
      appVersionsDiffer(
        CLIENT_APP_BUILD_VERSION,
        response.headers.get(APP_VERSION_HEADER),
      )
    ) {
      setUpdateAvailable(true);
    }
  }, []);

  const reload = useCallback(() => window.location.reload(), []);

  return { observeServerResponse, reload, updateAvailable };
}
