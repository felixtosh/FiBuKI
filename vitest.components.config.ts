/**
 * Root React component-test profile (jsdom + @testing-library/react).
 *
 * Run with `npm run test:components`.
 *
 * Why this config lives at the REPO ROOT and not in functions/
 * -----------------------------------------------------------
 * functions/vitest.api-smoke.config.ts solves a superficially similar problem —
 * it runs vitest from functions/ against real app code imported from the repo
 * root, and CI installs both dependency trees for it. That shape is fine for
 * route handlers, which are plain functions.
 *
 * It is NOT safe for component tests. React must be a single instance at
 * runtime: resolving `react` from the root tree (because the component under
 * test imports it) while resolving `react-dom` and the renderer from
 * functions/node_modules gives you two copies of React and the classic
 * "Invalid hook call" / hooks-dispatcher-is-null failure. So the runner, the
 * renderer and React all live in the ROOT tree here, and this suite needs only
 * `npm ci` at the root.
 *
 * Test files live in tests-components/ rather than next to their components.
 * Two reasons:
 *   1. `npm run test:node` drives the pure-ESM suite under tests/ with node's
 *      own test runner. Keeping a separate top-level directory makes the
 *      boundary between the two suites visible and impossible to cross by
 *      accident with a careless glob.
 *   2. components/ is churned heavily by in-flight work; keeping test files
 *      out of it keeps this harness off other branches' conflict surface.
 */

import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// `__dirname` rather than `import.meta.dirname`: the root package.json has no
// "type": "module", so Vite loads this config as CommonJS.
// functions/vitest.api-smoke.config.ts resolves the repo root the same way.
// (Vite prints a forward-compat notice about ESM syntax in a CJS-loaded config
// for any .ts Vite config in this repo; it is advisory, not this file's doing.)
const repoRoot = path.resolve(__dirname);

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirrors `compilerOptions.paths` in the root tsconfig.json ("@/*" -> "./*").
    // Without this the tests do not even import: the whole app addresses itself
    // as `@/components/...`, `@/lib/...`. If a new alias is ever added to
    // tsconfig.json it has to be added here too.
    alias: [{ find: /^@\//, replacement: `${repoRoot}/` }],
  },
  test: {
    environment: "jsdom",
    // Deliberately narrow: it must not reach tests/*.test.mjs (node's runner
    // owns those) or anything under functions/ (its own vitest configs own
    // those).
    include: ["tests-components/**/*.test.tsx"],
    // No `globals: true`. Every test imports describe/it/expect from "vitest"
    // explicitly, so the root tsconfig.json needs no `types` entry for vitest
    // and `npx tsc --noEmit` typechecks these files with no extra setup.
    globals: false,
    setupFiles: ["./tests-components/setup.ts"],
  },
});
