import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/test/**/*.test.ts"],
    // Self-host spike tests require the module-alias profile (vitest.selfhost.config.ts);
    // app/api route smoke tests require root node_modules (vitest.api-smoke.config.ts)
    exclude: ["src/selfhost/**", "src/api-smoke/**"],
    clearMocks: true,
    globals: true,
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
