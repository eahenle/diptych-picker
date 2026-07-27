import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    ".next-build/**",
    ".next-demo/**",
    ".next-e2e/**",
    ".next-run/**",
    ".local-data/**",
    ".playwright-cli/**",
    "coverage/**",
    "output/**",
    "playwright-report/**",
    "test-results/**",
  ]),
]);
