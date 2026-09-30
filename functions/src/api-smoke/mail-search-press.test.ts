/**
 * Route-seam tests for the mailbox's "Search for missing receipts" press
 * (#103). FiBuKI no longer syncs mailboxes: the press queues the
 * per-Transaction receipt search, and never a Sync.
 *
 * Same harness as route-owner-scoping.test.ts: the REAL Next handler over an
 * in-memory Firestore. The search helper is mocked because the in-memory store
 * has no count(); its own behaviour is covered on the real shim
 * (selfhost/mail-import-search.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { setupRouteHarness } from "./route-harness";

const search = vi.hoisted(() => ({
  calls: [] as unknown[][],
  result: { queued: true, transactionsToProcess: 12 },
}));

vi.mock("../precision-search/queueIncompleteSearch", () => ({
  queueIncompleteTransactionSearch: async (...args: unknown[]) => {
    search.calls.push(args);
    return search.result;
  },
}));

const USER = "user-A";
const INTEGRATION = "int-1";

const { store, authed } = setupRouteHarness();

function ts(date: Date) {
  return { toDate: () => date, toMillis: () => date.getTime() };
}

async function press(body: unknown = { integrationId: INTEGRATION }, user = USER) {
  const { POST } = await import("@/app/api/gmail/sync/route");
  return POST(authed(user, "http://test.local/api/gmail/sync", "POST", body));
}

function seed(overrides: Record<string, unknown> = {}) {
  store.seed("emailIntegrations", INTEGRATION, {
    userId: USER,
    provider: "gmail",
    email: "felix@example.com",
    needsReauth: false,
    initialSyncComplete: true,
    ...overrides,
  });
}

beforeEach(() => {
  search.calls.length = 0;
  search.result = { queued: true, transactionsToProcess: 12 };
});

describe("POST /api/gmail/sync: search for missing receipts", () => {
  it("queues the per-Transaction search and never a Sync", async () => {
    seed();

    const res = await press();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, searchQueued: true, transactionsToProcess: 12 });
    expect(search.calls).toHaveLength(1);
    expect(search.calls[0][1]).toBe(USER);
    expect(search.calls[0][2]).toBe("manual_search");
    const syncs = await store.collection("gmailSyncQueue").get();
    expect(syncs.size).toBe(0);
  });

  it("says so when there is nothing to start", async () => {
    seed();
    search.result = { queued: false, transactionsToProcess: 0 };

    const res = await press();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ searchQueued: false });
  });

  it("refuses a second press within five minutes", async () => {
    seed({ lastManualSyncAt: ts(new Date(Date.now() - 60 * 1000)) });

    const res = await press();

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(search.calls).toHaveLength(0);
  });

  it("stamps the press, so the next one within five minutes is refused", async () => {
    seed();

    expect((await press()).status).toBe(200);
    expect((await press()).status).toBe(429);
    expect(search.calls).toHaveLength(1);
  });

  it("refuses a mailbox that needs re-authentication", async () => {
    seed({ needsReauth: true });
    const res = await press();
    expect(res.status).toBe(403);
    expect(search.calls).toHaveLength(0);
  });

  it("does not reveal another user's mailbox", async () => {
    seed();
    const res = await press({ integrationId: INTEGRATION }, "user-B");
    expect(res.status).toBe(404);
    expect(search.calls).toHaveLength(0);
  });
});
