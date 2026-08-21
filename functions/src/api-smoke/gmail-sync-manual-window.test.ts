/**
 * Route-seam tests for the manual mail sync forced window (spec #173, #177).
 *
 * Two defects live at this seam and both are provider-independent:
 *
 *   1. The endpoint derived its work from gap detection alone, so a mailbox
 *      whose synced range already ran to now — the normal state right after a
 *      nightly sync — answered "already up to date" and a human's button press
 *      did nothing. `force` adds a trailing window on top of the gaps.
 *
 *   2. The five-minute throttle read `lastSyncAt`, which the *worker* writes on
 *      any completed sync, so a nightly run consumed the user's throttle for a
 *      job they never initiated. It now reads `lastManualSyncAt`, written by
 *      the route at enqueue time.
 *
 * Same harness as route-owner-scoping.test.ts: the REAL Next handler over an
 * in-memory Firestore, so this needs the ROOT dependency tree and runs in the
 * "App API routes (auth smoke)" CI job, not locally.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { FakeFirestore } from "./fake-firestore";
import { MANUAL_SYNC_WINDOW_DAYS } from "../mail/constants";

// The sync route binds `getAdminDb()` once at module import, so every test must
// see the SAME instance. Held in a hoisted box the vi.mock factory can reach.
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

// The bearer token IS the uid; a missing/non-Bearer header still 401s.
vi.mock("@/lib/auth/get-server-user", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth/get-server-user")>();
  return {
    ...actual,
    getServerUserIdWithFallback: async (request: Request): Promise<string> => {
      const header = request.headers.get("Authorization");
      if (!header?.startsWith("Bearer ")) throw new actual.UnauthorizedError();
      return header.substring(7);
    },
  };
});

const USER = "user-A";
const INTEGRATION = "int-1";
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = MANUAL_SYNC_WINDOW_DAYS * DAY_MS;

const store = new FakeFirestore();
h.box.db = store;

beforeEach(() => {
  store.reset();
});

/**
 * A Firestore-Timestamp-shaped value. The route reads these through
 * `toDateSafe` (duck-typed on `toDate`) and FakeFirestore orders on `toMillis`,
 * so this stands in for the real class without dragging a second physical copy
 * of firebase-admin into the test.
 */
function ts(date: Date) {
  return { toDate: () => date, toMillis: () => date.getTime() };
}

async function callSync(body: unknown) {
  const { POST } = await import("@/app/api/gmail/sync/route");
  return POST(
    new NextRequest("http://test.local/api/gmail/sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${USER}`,
      },
      body: JSON.stringify(body),
    })
  );
}

interface Fixture {
  /** Single transaction date; the route derives its range from this ± 7 days. */
  transactionAt: Date;
  /** Already-synced span, as the worker would have left it. */
  syncedFrom: Date;
  syncedTo: Date;
  lastSyncAt?: Date;
  lastManualSyncAt?: Date;
}

function seed(fixture: Fixture) {
  store.seed("emailIntegrations", INTEGRATION, {
    userId: USER,
    provider: "imap",
    email: "stefan@example.com",
    needsReauth: false,
    initialSyncComplete: true,
    syncedDateRange: { from: ts(fixture.syncedFrom), to: ts(fixture.syncedTo) },
    ...(fixture.lastSyncAt ? { lastSyncAt: ts(fixture.lastSyncAt) } : {}),
    ...(fixture.lastManualSyncAt
      ? { lastManualSyncAt: ts(fixture.lastManualSyncAt) }
      : {}),
  });
  store.seed("transactions", "txn-1", {
    userId: USER,
    date: ts(fixture.transactionAt),
    amount: 100,
  });
}

/** A fixture whose synced range fully covers the transaction range ± 7 days. */
function fullySynced(overrides: Partial<Fixture> = {}): Fixture {
  const transactionAt = new Date("2026-01-01T00:00:00Z");
  return {
    transactionAt,
    syncedFrom: new Date(transactionAt.getTime() - 8 * DAY_MS),
    syncedTo: new Date(transactionAt.getTime() + 8 * DAY_MS),
    ...overrides,
  };
}

async function queuedRanges(): Promise<{ from: Date; to: Date }[]> {
  const snap = await store
    .collection("gmailSyncQueue")
    .where("integrationId", "==", INTEGRATION)
    .get();
  return snap.docs
    .map((doc) => {
      const data = doc.data() as {
        dateFrom: { toDate: () => Date };
        dateTo: { toDate: () => Date };
      };
      return { from: data.dateFrom.toDate(), to: data.dateTo.toDate() };
    })
    .sort((a, b) => a.from.getTime() - b.from.getTime());
}

/** True when `range` spans at least [from, to]. */
function covers(range: { from: Date; to: Date }, from: Date, to: Date): boolean {
  return range.from.getTime() <= from.getTime() && range.to.getTime() >= to.getTime();
}

/**
 * Assert `range` is the trailing window: exactly MANUAL_SYNC_WINDOW_DAYS long
 * and ending at the moment of the press (between `before` and `after`).
 */
function expectTrailingWindow(
  range: { from: Date; to: Date },
  before: number,
  after: number
) {
  expect(range.to.getTime()).toBeGreaterThanOrEqual(before);
  expect(range.to.getTime()).toBeLessThanOrEqual(after);
  expect(range.to.getTime() - range.from.getTime()).toBe(WINDOW_MS);
}

// ---------------------------------------------------------------------------
// The forced window
// ---------------------------------------------------------------------------
describe("POST /api/gmail/sync — force", () => {
  it("queues the trailing window even when gap detection finds nothing", async () => {
    seed(fullySynced());
    const before = Date.now();

    const res = await callSync({ integrationId: INTEGRATION, force: true });
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });

    const ranges = await queuedRanges();
    expect(ranges).toHaveLength(1);
    expectTrailingWindow(ranges[0], before, after);
  });

  it("queues the window IN ADDITION to a disjoint gap", async () => {
    // Transactions in January, synced only to 2026-01-03 → a gap that closes
    // long before the trailing window opens.
    const transactionAt = new Date("2026-01-01T00:00:00Z");
    seed({
      transactionAt,
      syncedFrom: new Date(transactionAt.getTime() - 8 * DAY_MS),
      syncedTo: new Date(transactionAt.getTime() + 2 * DAY_MS),
    });
    const before = Date.now();

    const res = await callSync({ integrationId: INTEGRATION, force: true });
    const after = Date.now();
    expect(res.status).toBe(200);

    const ranges = await queuedRanges();
    expect(ranges).toHaveLength(2);
    // The real gap: from just after the synced range out to transaction + 7 days.
    expect(
      covers(
        ranges[0],
        new Date(transactionAt.getTime() + 2 * DAY_MS + 1),
        new Date(transactionAt.getTime() + 7 * DAY_MS)
      )
    ).toBe(true);
    // …and the trailing window, separately.
    expectTrailingWindow(ranges[1], before, after);
  });

  it("merges the window into an overlapping gap rather than queueing it twice", async () => {
    // A transaction dated now, synced only up to five days ago → the gap runs
    // from then to now + 7 days, swallowing the trailing window whole.
    const transactionAt = new Date();
    seed({
      transactionAt,
      syncedFrom: new Date(transactionAt.getTime() - 30 * DAY_MS),
      syncedTo: new Date(transactionAt.getTime() - 5 * DAY_MS),
    });
    const before = Date.now();

    const res = await callSync({ integrationId: INTEGRATION, force: true });
    expect(res.status).toBe(200);

    const ranges = await queuedRanges();
    expect(ranges).toHaveLength(1);
    expect(covers(ranges[0], new Date(before - WINDOW_MS), new Date(before))).toBe(true);
  });

  it("leaves behaviour unchanged without the flag (Gmail keeps gap-fill)", async () => {
    seed(fullySynced());

    const res = await callSync({ integrationId: INTEGRATION });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, alreadySynced: true });
    expect(await queuedRanges()).toHaveLength(0);
  });

  it("queues only the gap without the flag when one exists", async () => {
    const transactionAt = new Date("2026-01-01T00:00:00Z");
    seed({
      transactionAt,
      syncedFrom: new Date(transactionAt.getTime() - 8 * DAY_MS),
      syncedTo: new Date(transactionAt.getTime() + 2 * DAY_MS),
    });

    const res = await callSync({ integrationId: INTEGRATION });
    expect(res.status).toBe(200);

    const ranges = await queuedRanges();
    expect(ranges).toHaveLength(1);
    expect(
      covers(
        ranges[0],
        new Date(transactionAt.getTime() + 2 * DAY_MS + 1),
        new Date(transactionAt.getTime() + 7 * DAY_MS)
      )
    ).toBe(true);
    // No trailing window was added.
    expect(ranges[0].to.getTime()).toBeLessThan(Date.now() - WINDOW_MS);
  });
});

// ---------------------------------------------------------------------------
// The throttle
// ---------------------------------------------------------------------------
describe("POST /api/gmail/sync — manual-press throttle", () => {
  it("allows a press when the integration has never been pressed", async () => {
    seed(fullySynced());

    const res = await callSync({ integrationId: INTEGRATION, force: true });

    expect(res.status).toBe(200);
    expect(await queuedRanges()).toHaveLength(1);
  });

  it("allows a press when the last press is older than five minutes", async () => {
    seed(fullySynced({ lastManualSyncAt: new Date(Date.now() - 6 * 60 * 1000) }));

    const res = await callSync({ integrationId: INTEGRATION, force: true });

    expect(res.status).toBe(200);
    expect(await queuedRanges()).toHaveLength(1);
  });

  it("refuses a second press within five minutes", async () => {
    seed(fullySynced({ lastManualSyncAt: new Date(Date.now() - 60 * 1000) }));

    const res = await callSync({ integrationId: INTEGRATION, force: true });

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(await queuedRanges()).toHaveLength(0);
  });

  it("is not tripped by a recent worker-written lastSyncAt", async () => {
    // The regression: a nightly sync finished a minute ago. That is the
    // worker's timestamp, not the user's press, and must not consume it.
    seed(fullySynced({ lastSyncAt: new Date(Date.now() - 60 * 1000) }));

    const res = await callSync({ integrationId: INTEGRATION, force: true });

    expect(res.status).toBe(200);
    expect(await queuedRanges()).toHaveLength(1);
  });

  it("writes the press timestamp at enqueue time", async () => {
    seed(fullySynced());
    const before = Date.now();

    const res = await callSync({ integrationId: INTEGRATION, force: true });
    expect(res.status).toBe(200);

    const after = (
      await store.collection("emailIntegrations").doc(INTEGRATION).get()
    ).data()!;
    const stamped = (after.lastManualSyncAt as { toDate: () => Date }).toDate();
    expect(stamped.getTime()).toBeGreaterThanOrEqual(before);

    // …and the very next press is refused, proving this is the stamp the
    // throttle reads.
    const second = await callSync({ integrationId: INTEGRATION, force: true });
    expect(second.status).toBe(429);
  });
});
