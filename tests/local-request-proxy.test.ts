import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "@/proxy";

describe("local request proxy", () => {
  it("allows read-only requests from any origin", () => {
    const response = proxy(
      new NextRequest("http://127.0.0.1:3000/api/game", {
        headers: { origin: "https://example.test" },
      }),
    );

    expect(response.status).toBe(200);
  });

  it("allows same-origin mutations", () => {
    const response = proxy(
      new NextRequest("http://127.0.0.1:3000/api/game/select", {
        method: "POST",
        headers: {
          host: "127.0.0.1:3000",
          origin: "http://127.0.0.1:3000",
        },
      }),
    );

    expect(response.status).toBe(200);
  });

  it("allows non-browser local automation without an Origin header", () => {
    const response = proxy(
      new NextRequest("http://127.0.0.1:3000/api/game/start", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
  });

  it("rejects cross-origin mutations", async () => {
    const response = proxy(
      new NextRequest("http://127.0.0.1:3000/api/game/select", {
        method: "POST",
        headers: { origin: "https://example.test" },
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Cross-origin changes are not allowed.",
    });
  });

  it("rejects browser-declared cross-site mutations without Origin", () => {
    const response = proxy(
      new NextRequest("http://127.0.0.1:3000/api/game/snapshot", {
        method: "PUT",
        headers: { "sec-fetch-site": "cross-site" },
      }),
    );

    expect(response.status).toBe(403);
  });

  it("rejects DNS-rebinding hosts before API routing", async () => {
    const response = proxy(
      new NextRequest("http://attacker.example/api/game", {
        headers: { host: "attacker.example" },
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Diptych Picker accepts local requests only.",
    });
  });
});
