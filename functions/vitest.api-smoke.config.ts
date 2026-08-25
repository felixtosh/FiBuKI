/**
 * W1 — app/api route smoke profile (first slice of the "61 routes, zero
 * tests" Phase-0 gap; see docs/phase-2-rip-the-shim.md).
 *
 * Runs the REAL Next route handlers (repo root app/api/**) directly, so it
 * needs the ROOT dependency tree installed (next, firebase-admin, …):
 *
 *   npm ci                      # repo root
 *   cd functions && npm ci
 *   npx vitest run --config vitest.api-smoke.config.ts
 *
 * There is still no test runner in the root package.json (open Phase-0
 * item) — this profile borrows the functions runner and maps the app's
 * `@/` path alias onto the repo root, which is why it lives here.
 */

import { defineConfig } from "vitest/config";
import path from "path";

const repoRoot = path.resolve(__dirname, "..");

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${repoRoot}/` },
      // The root and functions/ trees each carry their own physical copy of
      // imapflow. A route under test imports the root one while a test file
      // here would import the functions/ one, so a `vi.mock("imapflow")` would
      // register against a module the route never loads and the real client
      // would open a real socket. Pin both sides to the root copy.
      { find: /^imapflow$/, replacement: `${repoRoot}/node_modules/imapflow` },
    ],
  },
  test: {
    environment: "node",
    include: ["src/api-smoke/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
