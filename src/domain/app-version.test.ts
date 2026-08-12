import { describe, expect, it } from "vitest";
import { appVersionsDiffer } from "./app-version";

describe("appVersionsDiffer", () => {
  it("detects a different non-empty server build", () => {
    expect(appVersionsDiffer("build-a", "build-b")).toBe(true);
  });

  it("ignores matching or missing build headers", () => {
    expect(appVersionsDiffer("build-a", "build-a")).toBe(false);
    expect(appVersionsDiffer("build-a", null)).toBe(false);
    expect(appVersionsDiffer("build-a", "  ")).toBe(false);
  });
});
