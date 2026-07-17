import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
    ],
    coverage: { reporter: ["text", "html"] },
  },
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
});
