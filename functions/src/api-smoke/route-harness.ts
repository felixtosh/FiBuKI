/**
 * The shared wiring behind every app/api route smoke test: one in-memory data
 * plane, a stubbed identity seam, and the request builder that carries it.
 *
 * A route test opens with
 *
 *     const { store, authed } = setupRouteHarness();
 *
 * and nothing else. What that one line buys, and why it cannot be simpler:
 *
 *   - The routes capture `const db = getAdminDb()` at MODULE load, so the whole
 *     file must share ONE FakeFirestore that we reset() (not recreate) between
 *     tests. It lives in a hoisted box because `vi.mock` factories are hoisted
 *     above module-level consts and could not otherwise reach it.
 *   - firebase-admin/firestore is deliberately NOT mocked. The route (repo root)
 *     and the test (functions/) resolve it to different physical trees, so a
 *     vi.mock here would register against a module the route never loads. The
 *     fake db stores the real Timestamp/FieldValue values opaquely, which is
 *     fine because the assertions read the HTTP contract and the userId
 *     scoping, not sentinel internals.
 *   - The auth seam is stubbed to supply identity only — the bearer token IS
 *     the uid — while keeping the real UnauthorizedError/unauthorizedResponse
 *     the routes catch on, so the 401 path still holds. The real token-verify
 *     is covered by auth-routes.test.ts, which mocks nothing.
 *
 * The mocks register when this module executes, i.e. at the test file's import.
 * That is early enough because route tests load their handler with a dynamic
 * `await import("@/app/api/…")` inside the test body; a route pulled in by a
 * STATIC import in the test file would beat the registration and get the real
 * admin SDK.
 *
 * Importing next/server puts this module on the ROOT dependency tree, so it
 * runs under vitest.api-smoke.config.ts only and is excluded from the functions
 * tsc build (see functions/tsconfig.json). Its data double, ./fake-firestore,
 * stays dependency-free and is not.
 */

import { beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { FakeFirestore } from "./fake-firestore";

// The one shared data plane, in a box the vi.mock factory below can reach.
const h = vi.hoisted(() => {
  const box: { db: unknown } = { db: undefined };
  return { box, getDb: () => box.db };
});

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => h.getDb(),
  getAdminApp: () => ({}),
  getAdminStorage: () => ({}),
  getAdminBucket: () => ({}),
}));

vi.mock("@/lib/auth/get-server-user", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth/get-server-user")>();
  return {
    ...actual,
    getServerUserIdWithFallback: async (request: Request): Promise<string> => {
      const header = request.headers.get("Authorization");
      if (!header?.startsWith("Bearer ")) throw new actual.UnauthorizedError();
      return header.substring(7);
    },
    isServerUserAdmin: async (request: Request): Promise<boolean> => {
      return request.headers.get("Authorization") === "Bearer admin";
    },
  };
});

/** A request carrying `uid` as its bearer token (see the auth mock above). */
export function authed(
  uid: string,
  url: string,
  method = "POST",
  body?: unknown
): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", Authorization: `Bearer ${uid}` },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  });
}

export interface RouteHarness {
  /** The instance every route under test sees through the mocked getAdminDb(). */
  store: FakeFirestore;
  authed: typeof authed;
}

/**
 * Install the shared data plane for this test file and reset it between tests.
 * Call once at the top level of the file, outside any describe().
 */
export function setupRouteHarness(): RouteHarness {
  const store = new FakeFirestore();
  h.box.db = store;

  beforeEach(() => {
    store.reset();
  });

  return { store, authed };
}
