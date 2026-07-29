/**
 * W1 — auth smoke over a slice of the app/api/* routes (the auth-touching
 * ones sit directly on top of the token-verify seam Better Auth replaces).
 * First tests ever against these handlers; 44 of the 61 routes authenticate
 * via lib/auth/get-server-user.ts (blast radius measured in the 2026-07-21
 * auth-verify investigation) — this slice covers 6 representative ones.
 *
 * What the measurement found (2026-07-21): `getServerUserIdWithFallback`
 * THROWS on a missing/invalid token, so the routes' `if (!userId) return 401`
 * branches were DEAD CODE — the throw landed in each route's generic catch
 * and came back as a 500 (sources/disconnect and plaid/link-token
 * additionally echoed the internal error message into the response body).
 * W1 chunk 5 established the 401 contract: the helper throws a typed
 * UnauthorizedError and every consumer route's catch opens with the
 * unauthorizedResponse() guard, answering 401 {"error":"Unauthorized"}
 * with no internal text. The former xfail marks below are now plain tests.
 *
 * Runs under vitest.api-smoke.config.ts ONLY (needs root node_modules).
 */

import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";

const unauthenticated = (url: string, method = "POST", body = "{}") =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(method === "GET" ? {} : { body }),
  });

/** Routes in the slice: [name, loader, invoke]. Params-taking handlers get
 *  their params promise the way Next 15 passes them. */
const SLICE: Array<{
  name: string;
  invoke: () => Promise<Response>;
}> = [
  {
    name: "POST /api/matching/score-files",
    invoke: async () => {
      const { POST } = await import("@/app/api/matching/score-files/route");
      return POST(unauthenticated("http://test.local/api/matching/score-files"));
    },
  },
  {
    name: "POST /api/sources/[id]/disconnect",
    invoke: async () => {
      const { POST } = await import("@/app/api/sources/[id]/disconnect/route");
      return POST(unauthenticated("http://test.local/api/sources/src-1/disconnect"), {
        params: Promise.resolve({ id: "src-1" }),
      });
    },
  },
  {
    name: "POST /api/plaid/link-token",
    invoke: async () => {
      const { POST } = await import("@/app/api/plaid/link-token/route");
      return POST(unauthenticated("http://test.local/api/plaid/link-token"));
    },
  },
  {
    name: "POST /api/reports/export",
    invoke: async () => {
      const { POST } = await import("@/app/api/reports/export/route");
      return POST(unauthenticated("http://test.local/api/reports/export"));
    },
  },
  {
    name: "GET /api/gmail/sync",
    invoke: async () => {
      const { GET } = await import("@/app/api/gmail/sync/route");
      return GET(unauthenticated("http://test.local/api/gmail/sync?integrationId=int-1", "GET"));
    },
  },
  {
    name: "POST /api/admin/cleanup-orphaned-transactions",
    invoke: async () => {
      const { POST } = await import("@/app/api/admin/cleanup-orphaned-transactions/route");
      return POST(unauthenticated("http://test.local/api/admin/cleanup-orphaned-transactions"));
    },
  },
];

describe("get-server-user helpers (the seam W1 swaps)", () => {
  it("getServerUserIdWithFallback rejects a request with no Authorization header", async () => {
    const { getServerUserIdWithFallback } = await import("@/lib/auth/get-server-user");
    await expect(getServerUserIdWithFallback(new Request("http://test.local/x"))).rejects.toThrow(/Unauthorized/);
  });

  it("getServerUserIdWithFallback rejects a non-Bearer Authorization header", async () => {
    const { getServerUserIdWithFallback } = await import("@/lib/auth/get-server-user");
    const req = new Request("http://test.local/x", { headers: { Authorization: "Basic abc" } });
    await expect(getServerUserIdWithFallback(req)).rejects.toThrow(/Unauthorized/);
  });

  it("isServerUserAdmin is false for an unauthenticated request", async () => {
    const { isServerUserAdmin } = await import("@/lib/auth/get-server-user");
    await expect(isServerUserAdmin(new Request("http://test.local/x"))).resolves.toBe(false);
  });

  // NOTE (2026-07-21): whether these routes ever verify selfhost sessions is
  // an OPEN QUESTION, deliberately not encoded here — the auth-verify
  // decision handoff records "the Next API routes are not part of the
  // selfhost data plane", while several routes the selfhost UI does use
  // (chat, gmail sync) live behind this helper. See the W1 implementation
  // handoff's decision list before adding a selfhost seam test.
});

describe("unauthenticated requests to auth-touching routes", () => {
  for (const route of SLICE) {
    it(`${route.name} returns a JSON error response (no crash, nothing served)`, async () => {
      const res = await route.invoke();
      expect(res).toBeInstanceOf(Response);
      // The pin here is only: an error status and no data served.
      expect(res.status).toBeGreaterThanOrEqual(400);
      const body = (await res.json()) as { error?: unknown };
      expect(body.error).toBeTruthy();
    });

    it(`${route.name} answers 401 to a missing token (W1 contract)`, async () => {
      const res = await route.invoke();
      expect(res.status).toBe(401);
      // No internal error text may leak into the body once this is real.
      const body = (await res.json()) as { error?: unknown };
      expect(body.error).toBe("Unauthorized");
    });
  }
});
