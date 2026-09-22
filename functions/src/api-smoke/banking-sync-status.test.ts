/**
 * GET /api/banking/sync — the re-auth derivation (#112).
 *
 * This route recomputes, server-side, what `useSyncStatus` derives on the
 * client: `needsReauth = expiresAt < now`. A stored expiry that is present but
 * malformed — the `{seconds: null}` a JSONB round trip produces for a null
 * timestamp column — used to land on 1970 here, i.e. a permanent "Needs
 * Reconnection" the user cannot clear by reconnecting, and an undefined
 * `seconds` used to reach `toISOString()` as an Invalid Date and 500 the route.
 *
 * Covers repo-root app/api/banking/sync/route.ts, so it runs under
 * vitest.api-smoke.config.ts ONLY (needs the root dependency tree).
 */

import { describe, it, expect } from "vitest";
import { setupRouteHarness } from "./route-harness";

const { store, authed } = setupRouteHarness();

interface SyncStatusBody {
  status: {
    needsReauth: boolean;
    reauthExpiresAt: string | null;
    reauthDaysRemaining: number | null;
  };
}

async function getStatus(sourceId: string, uid = "user-1") {
  const { GET } = await import("@/app/api/banking/sync/route");
  return GET(authed(uid, `http://localhost/api/banking/sync?sourceId=${sourceId}`, "GET"));
}

/** A finAPI source whose stored token expiry is whatever the case under test needs. */
function seedSource(expiresAt: unknown, uid = "user-1") {
  store.seed("sources", "src-1", {
    userId: uid,
    type: "api",
    apiConfig: { provider: "finapi", expiresAt, lastSyncAt: null },
  });
}

describe("GET /api/banking/sync", () => {
  it("does not claim re-auth for an expiry stored as a null-seconds bag", async () => {
    seedSource({ seconds: null, nanoseconds: null });

    const res = await getStatus("src-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SyncStatusBody;
    expect(body.status.needsReauth).toBe(false);
    expect(body.status.reauthExpiresAt).toBeNull();
    expect(body.status.reauthDaysRemaining).toBeNull();
  });

  it("answers 200 rather than a RangeError when seconds is missing entirely", async () => {
    seedSource({ seconds: undefined });

    const res = await getStatus("src-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SyncStatusBody;
    expect(body.status.needsReauth).toBe(false);
  });

  it("still claims re-auth for an expiry that has genuinely passed", async () => {
    // Not vacuous: the guard must degrade a malformed value, not every value.
    const yesterday = Date.now() - 24 * 60 * 60 * 1000;
    seedSource({ seconds: Math.floor(yesterday / 1000), nanoseconds: 0 });

    const res = await getStatus("src-1");
    const body = (await res.json()) as SyncStatusBody;
    expect(body.status.needsReauth).toBe(true);
    expect(body.status.reauthExpiresAt).not.toBeNull();
  });

  it("does not claim re-auth for an expiry still in the future", async () => {
    const inTenDays = Date.now() + 10 * 24 * 60 * 60 * 1000;
    seedSource({ seconds: Math.floor(inTenDays / 1000), nanoseconds: 0 });

    const res = await getStatus("src-1");
    const body = (await res.json()) as SyncStatusBody;
    expect(body.status.needsReauth).toBe(false);
    expect(body.status.reauthDaysRemaining).toBe(9);
  });
});
