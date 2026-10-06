import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["*.e2e.ts"],
    fileParallelism: false,
    testTimeout: 60 * 60_000,
    hookTimeout: 60_000,
  },
});
