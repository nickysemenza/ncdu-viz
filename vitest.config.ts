import { defineConfig } from "vitest/config";

// Pure-logic tests (parser, treemap layout) run in a Node environment.
// We deliberately do NOT load the Cloudflare/React Vite plugins here.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
