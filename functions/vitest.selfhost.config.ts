/**
 * Self-host spike test profile: runs REAL application code with the
 * Firebase module surface swapped for self-host shims at resolution time.
 * Zero application-code changes — that's the point being proven.
 *
 *   npx vitest run --config vitest.selfhost.config.ts
 */

import { defineConfig } from "vitest/config";
import path from "path";

const shim = (f: string) => path.resolve(__dirname, "src/selfhost", f);

export default defineConfig({
  resolve: {
    alias: [
      { find: "firebase-admin/firestore", replacement: shim("firestore-shim.ts") },
      { find: "firebase-functions/v2/firestore", replacement: shim("trigger-shim.ts") },
      { find: "firebase-functions/v2/https", replacement: shim("https-shim.ts") },
      { find: "firebase-admin/auth", replacement: shim("auth-shim.ts") },
      { find: "firebase-admin/storage", replacement: shim("storage-shim.ts") },
      { find: "firebase-functions/v2/scheduler", replacement: shim("scheduler-shim.ts") },
      { find: "firebase-functions/params", replacement: shim("params-shim.ts") },
      { find: "@google-cloud/vertexai", replacement: shim("vertexai-adapter.ts") },
      // The central mailer is app code imported by relative path, so the
      // swap matches the module suffix instead of a bare specifier. The
      // pattern spans the whole specifier — regex aliases are applied via
      // String.replace, and a partial match would leave "../" prefixed to
      // the absolute replacement path.
      { find: /^.*\/utils\/mailer$/, replacement: shim("mailer-shim.ts") },
      // Same whole-specifier swap for the plan source (#159): on self-host the
      // plan is the FIBUKI_PLAN env lever (default: full), not a Stripe
      // subscription. Unlike the mailer, its one consumer imports it as
      // "./planSource" (billing/config.ts is a sibling), so the pattern must
      // catch the RELATIVE specifier too, hence no "/billing/" anchor.
      // Pinned by account-provisioning.test.ts ("alias seam").
      { find: /^.*planSource$/, replacement: shim("plan-source-shim.ts") },
      // Same whole-specifier swap for the download-URL helper: the self-host
      // build emits host /__storage/download URLs instead of googleapis.com,
      // so backend-written download links resolve. See buildDownloadUrl-shim.ts.
      { find: /^.*\/utils\/buildDownloadUrl$/, replacement: shim("buildDownloadUrl-shim.ts") },
      // Asking for an Extraction writes a job for the extraction worker instead
      // of running it inline (#603). Its importers are siblings in
      // extraction/, so the pattern catches the relative "./extractionQueue".
      { find: /^.*\/extractionQueue$/, replacement: shim("extraction-queue-shim.ts") },
      // Mirrors next.config.ts: server-side document IO for the web container.
      // Must be listed BEFORE the generic "@/" rule below, which would otherwise
      // resolve this to the real firebase-admin module and defeat the swap.
      {
        find: "@/lib/firebase/admin",
        replacement: path.resolve(__dirname, "../lib/selfhost/admin-shim.ts"),
      },
      // Frontend code under test (the app/api routes and lib/ modules that the
      // self-host build re-points) uses Next's "@/" root alias. tsconfig defines it
      // for the app build; vitest resolves independently, so it needs saying here
      // too or those imports fail outright. Repo root, one level above functions/.
      { find: /^@\/(.*)$/, replacement: `${path.resolve(__dirname, "..")}/$1` },
    ],
  },
  test: {
    include: ["src/selfhost/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Console output only from failing tests. The cross-user fuzzers alone
    // log ~90k lines per run through vitest's console relay, which costs
    // minutes on CI and buries the one line that matters. A test's own
    // process.stderr.write (the fuzzers' OUTCOMES line) is not relayed and
    // still shows.
    silent: "passed-only",
  },
});
