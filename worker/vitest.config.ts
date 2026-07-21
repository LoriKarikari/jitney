import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          GITHUB_APP_ID: "test-app-id",
          GITHUB_APP_PRIVATE_KEY: "test-private-key",
          GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
          JITNEY_UNINSTALL_SECRET: "test-uninstall-secret",
          SCHEDULER_TICK_MS: "60000",
        },
      },
    }),
  ],
});
