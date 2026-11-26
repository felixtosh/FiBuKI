/**
 * Fiscal Years (#794) on the Next API routes that write Transactions: a bank
 * disconnect and the orphan cleanup keep closed rows, and the TrueLayer
 * syncs skip rows before Tracked From and count them per fiscal year.
 *
 * Routes are called in-process as the User (security/routes.ts); the client
 * Firestore SDK the TrueLayer and orphan routes use is pointed at the same
 * shim database, as in cross-user-routes.test.ts.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { __resetFirestoreShim, __whenShimIdle, getFirestore, Timestamp } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";
import { asUser, enableInternalAuth } from "./security/routes";
import { handleTool } from "../tools/handlers";

vi.mock("firebase/app", () => ({ initializeApp: () => ({}), getApps: () => [] }));
vi.mock("firebase/firestore", async () => {
  const shim = await import("./firestore-shim");
  const db = () => shim.getFirestore();
  const wrap = (snap: { id: string; exists: boolean; data: () => Record<string, unknown> | undefined; ref?: unknown }) => ({
    id: snap.id,
    exists: () => snap.exists,
    data: () => snap.data(),
    ref: snap.ref,
  });
  return {
    getFirestore: () => ({}),
    connectFirestoreEmulator: () => {},
    Timestamp: shim.Timestamp,
    doc: (_db: unknown, coll: string, id: string) => db().collection(coll).doc(id),
    collection: (_db: unknown, coll: string) => db().collection(coll),
    getDoc: async (ref: { get: () => Promise<never> }) => wrap(await ref.get()),
    updateDoc: (ref: { update: (d: unknown) => Promise<unknown> }, d: unknown) => ref.update(d),
    addDoc: (coll: { add: (d: unknown) => Promise<unknown> }, d: unknown) => coll.add(d),
    deleteDoc: (ref: { delete: () => Promise<unknown> }) => ref.delete(),
    where: (f: string, op: string, v: unknown) => ({ f, op, v }),
    query: (coll: { where: (...a: unknown[]) => unknown }, ...ws: Array<{ f: string; op: string; v: unknown }>) =>
      ws.reduce((q: { where: (...a: unknown[]) => unknown }, w) => q.where(w.f, w.op, w.v) as never, coll),
    getDocs: async (q: { get: () => Promise<{ docs: unknown[] }> }) => q.get(),
  };
});
vi.mock("@/lib/import/deduplication", () => ({
  generateDedupeHash: async (...parts: unknown[]) => parts.map(String).join("|"),
  normalizeIban: (iban: string) => iban.replace(/\s/g, "").toUpperCase(),
}));
vi.mock("@/lib/truelayer", () => ({
  getAccountIban: () => "AT483200000012345864",
  getTrueLayerClient: () => ({
    getTransactions: async () => [
      { transaction_id: "tl-old", timestamp: "2023-12-30T10:00:00Z", amount: 5, currency: "EUR", transaction_type: "DEBIT", description: "Old" },
      { transaction_id: "tl-new", timestamp: "2024-01-03T10:00:00Z", amount: 7, currency: "EUR", transaction_type: "DEBIT", description: "New" },
    ],
    getAccount: async () => ({ account_id: "acc-1", currency: "EUR", account_number: { iban: "AT483200000012345864" } }),
    refreshToken: async () => {
      throw new Error("no refresh in tests");
    },
  }),
}));

const db = getFirestore();
const USER = "fyr-user";
const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));
const future = () => Timestamp.fromDate(new Date(Date.now() + 3_600_000));

async function seedTransaction(id: string, iso: string, sourceId: string) {
  await db.collection("transactions").doc(id).set({ userId: USER, sourceId, date: day(iso), amount: -100, name: "Vendor", fileIds: [] });
}

async function exists(id: string) {
  return (await db.collection("transactions").doc(id).get()).exists;
}

async function names(sourceId: string) {
  const snap = await db.collection("transactions").where("sourceId", "==", sourceId).get();
  return snap.docs.map((d) => d.data().name).sort();
}

beforeAll(() => enableInternalAuth());

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
});

describe("a bank disconnect keeps the Closed stretch", () => {
  it("is refused while the Bank Account holds a closed Transaction, and deletes nothing", async () => {
    await db.collection("sources").doc("api-1").set({ userId: USER, name: "Bank", type: "api", apiConfig: { provider: "truelayer" } });
    await handleTool(USER, "set_fiscal_years", { trackedFrom: "2023-01", closedThrough: "2024-12" });
    await seedTransaction("tx-closed", "2024-05-01", "api-1");
    await seedTransaction("tx-open", "2025-05-01", "api-1");

    const { POST } = await import("@/app/api/sources/[id]/disconnect/route");
    const res = await POST(asUser(USER, "/api/sources/api-1/disconnect", { method: "POST" }), {
      params: Promise.resolve({ id: "api-1" }),
    });

    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/Closed Through is 2024-12/);
    expect(await exists("tx-closed")).toBe(true);
    expect(await exists("tx-open")).toBe(true);
    expect((await db.collection("sources").doc("api-1").get()).data()!.type).toBe("api");
  });
});

describe("the orphan cleanup route keeps closed orphans", () => {
  it("deletes the open orphan, keeps the closed one and says so", async () => {
    await handleTool(USER, "set_fiscal_years", { trackedFrom: "2023-01", closedThrough: "2024-12" });
    await seedTransaction("orphan-closed", "2024-05-01", "gone");
    await seedTransaction("orphan-open", "2025-05-01", "gone");

    const { POST } = await import("@/app/api/sources/delete-orphans/route");
    const res = await POST(asUser(USER, "/api/sources/delete-orphans", { method: "POST" }));
    const body = (await res.json()) as { deletedTransactions: number; keptClosedTransactions: number };

    expect(body).toMatchObject({ deletedTransactions: 1, keptClosedTransactions: 1 });
    expect(await exists("orphan-closed")).toBe(true);
    expect(await exists("orphan-open")).toBe(false);
  });
});

describe("the TrueLayer syncs skip Untracked rows", () => {
  beforeEach(async () => {
    await db.doc("truelayerConnections/tl-1").set({
      userId: USER,
      accessToken: "token",
      refreshToken: "refresh",
      tokenExpiresAt: future(),
      providerId: "tl-bank",
      providerName: "Bank",
      providerLogo: "logo.png",
    });
    await handleTool(USER, "set_fiscal_years", { trackedFrom: "2024-01" });
  });

  it("a sync writes the tracked row and counts the other per fiscal year", async () => {
    await db.collection("sources").doc("tl-src").set({
      userId: USER,
      name: "Bank",
      type: "api",
      iban: "AT483200000012345864",
      apiConfig: { provider: "truelayer", connectionId: "tl-1", accountId: "acc-1" },
    });

    const { POST } = await import("@/app/api/truelayer/sync/route");
    const res = await POST(asUser(USER, "/api/truelayer/sync", { body: { sourceId: "tl-src" } }));
    const body = (await res.json()) as { imported: number; untrackedCount: number; untrackedByFiscalYear: Record<string, number> };

    expect(body).toMatchObject({ imported: 1, untrackedCount: 1, untrackedByFiscalYear: { "2023": 1 } });
    expect(await names("tl-src")).toEqual(["New"]);
  });

  it("linking an account runs its first sync with the same skip", async () => {
    await db.collection("sources").doc("tl-link").set({ userId: USER, name: "Bank", type: "csv" });

    const { POST } = await import("@/app/api/truelayer/accounts/route");
    const res = await POST(
      asUser(USER, "/api/truelayer/accounts", { body: { connectionId: "tl-1", accountId: "acc-1", sourceId: "tl-link" } })
    );
    expect(res.status, await res.clone().text()).toBe(200);

    await vi.waitFor(async () => expect(await names("tl-link")).toEqual(["New"]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await names("tl-link")).toEqual(["New"]);
  });
});
