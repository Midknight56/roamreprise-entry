import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  publicDir: false,
  plugins: [cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: {
        bindings: {
          PAYPAL_CLIENT_ID: "test-id",
          PAYPAL_CLIENT_SECRET: "test-secret",
          PAYPAL_WEBHOOK_ID: "WH-TEST",
          LIVE_AI: "0",
          DEV_ROUTES: "0",
        },
      },
    })],
  test: { include: ["tests/**/*.test.ts"] },
});
