/**
 * C1 — functional smoke over the data-plane app/api routes that carry the
 * cutover. W1's auth-routes.test.ts pinned the 401 contract (unauthenticated →
 * 401 {"error":"Unauthorized"}); this adds the layer the flip actually rides on:
 *
 *   (a) authenticated happy path — a valid token → 2xx over a seeded fixture;
 *   (b) owner-scoping       — user B's token never reads/acts on user A's row.
 *
 * Owner-scoping is the property most likely to silently regress across the
 * Firebase→shim auth swap (every one of these routes gates on
 * `data.userId !== userId`), so it is the point of the suite.
 *
 * These run the REAL Next handlers, so they need the ROOT dependency tree
 * (next, firebase-admin) — empty on the audit box. Verify via the "App API
 * routes (auth smoke)" CI job, NOT locally. The in-memory Firestore they run on
 * (./fake-firestore) is separately pinned by fake-firestore.test.ts, which DOES
 * run locally.
 *
 * The auth seam is stubbed to supply identity (the real token-verify is covered
 * by auth-routes.test.ts); the fork under test here is the route's own
 * owner-scoping branch, exercised against a real (in-memory) data plane. That
 * wiring, and the constraints behind it, live in ./route-harness.
 */

import { describe, it, expect } from "vitest";
import { setupRouteHarness } from "./route-harness";

const USER_A = "user-A";
const USER_B = "user-B";

const { store, authed } = setupRouteHarness();

// ---------------------------------------------------------------------------
// GET /api/gmail/sync?integrationId=
// ---------------------------------------------------------------------------
describe("GET /api/gmail/sync", () => {
  const seedIntegration = (owner: string) =>
    store.seed("emailIntegrations", "int-1", {
      userId: owner,
      email: "a@example.com",
      lastSyncStatus: "success",
      initialSyncComplete: true,
    });

  it("returns the owner's sync status (happy path)", async () => {
    seedIntegration(USER_A);
    const { GET } = await import("@/app/api/gmail/sync/route");
    const res = await GET(authed(USER_A, "http://test.local/api/gmail/sync?integrationId=int-1", "GET"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { integration: { email: string } };
    expect(body.integration.email).toBe("a@example.com");
  });

  it("does not reveal another user's integration (owner-scoping → 404, no email leak)", async () => {
    seedIntegration(USER_A);
    const { GET } = await import("@/app/api/gmail/sync/route");
    const res = await GET(authed(USER_B, "http://test.local/api/gmail/sync?integrationId=int-1", "GET"));

    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain("a@example.com");
    expect(JSON.parse(body)).toEqual({ error: "Integration not found" });
  });
});

// ---------------------------------------------------------------------------
// POST /api/gmail/sync
// ---------------------------------------------------------------------------
describe("POST /api/gmail/sync", () => {
  const seedIntegration = (owner: string) =>
    store.seed("emailIntegrations", "int-1", {
      userId: owner,
      email: "a@example.com",
      needsReauth: false,
      initialSyncComplete: true,
    });

  it("queues the owner's receipt search, never a sync (happy path, #103)", async () => {
    seedIntegration(USER_A);
    store.seed("transactions", "tx-a", { userId: USER_A, isComplete: false });
    const { POST } = await import("@/app/api/gmail/sync/route");
    const res = await POST(authed(USER_A, "http://test.local/api/gmail/sync", "POST", { integrationId: "int-1" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, searchQueued: true });
    // A search owned by A was created, and no Sync.
    const searches = await store.collection("precisionSearchQueue").where("userId", "==", USER_A).get();
    expect(searches.size).toBe(1);
    const syncs = await store.collection("gmailSyncQueue").where("integrationId", "==", "int-1").get();
    expect(syncs.size).toBe(0);
  });

  it("does not queue a sync against another user's integration (owner-scoping → 404)", async () => {
    seedIntegration(USER_A);
    const { POST } = await import("@/app/api/gmail/sync/route");
    const res = await POST(authed(USER_B, "http://test.local/api/gmail/sync", "POST", { integrationId: "int-1" }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Integration not found" });
    // No queue item was created for B.
    const queue = await store.collection("gmailSyncQueue").where("integrationId", "==", "int-1").get();
    expect(queue.empty).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/sources/[id]/disconnect
// ---------------------------------------------------------------------------
describe("POST /api/sources/[id]/disconnect", () => {
  const seedApiSource = (owner: string) =>
    store.seed("sources", "src-1", {
      userId: owner,
      type: "api",
      apiConfig: { provider: "gocardless", bankConnectionId: "bc-1" },
    });

  it("disconnects the owner's source and removes its transactions (happy path)", async () => {
    seedApiSource(USER_A);
    store.seed("transactions", "t1", { userId: USER_A, sourceId: "src-1" });
    const { POST } = await import("@/app/api/sources/[id]/disconnect/route");
    const res = await POST(authed(USER_A, "http://test.local/api/sources/src-1/disconnect"), {
      params: Promise.resolve({ id: "src-1" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, deletedTransactions: 1 });
    const after = (await store.collection("sources").doc("src-1").get()).data()!;
    expect(after.type).toBe("csv");
    // The bank config was cleared (whether the FieldValue.delete sentinel is
    // interpreted or stored opaquely, it is no longer the gocardless config).
    expect((after.apiConfig as { provider?: string } | undefined)?.provider).not.toBe("gocardless");
    // The source's transactions were removed as part of the disconnect.
    expect((await store.collection("transactions").where("sourceId", "==", "src-1").get()).empty).toBe(true);
  });

  it("does not disconnect another user's source (owner-scoping → 404)", async () => {
    seedApiSource(USER_A);
    store.seed("transactions", "t1", { userId: USER_A, sourceId: "src-1" });
    const { POST } = await import("@/app/api/sources/[id]/disconnect/route");
    const res = await POST(authed(USER_B, "http://test.local/api/sources/src-1/disconnect"), {
      params: Promise.resolve({ id: "src-1" }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Source not found" });
    // User A's source is untouched — still an api source with its bank config…
    const after = (await store.collection("sources").doc("src-1").get()).data()!;
    expect(after.type).toBe("api");
    expect((after.apiConfig as { provider?: string }).provider).toBe("gocardless");
    // …and its transaction was not deleted.
    expect((await store.collection("transactions").where("sourceId", "==", "src-1").get()).empty).toBe(false);
  });
});
