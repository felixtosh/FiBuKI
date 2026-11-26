/**
 * Fiscal Years (#794) on the Next API routes that write Transactions: a bank
 * disconnect and the orphan cleanup keep closed rows, and the TrueLayer
 * syncs skip rows before Tracked From and count them per fiscal year.
 *
 * Routes are called in-process as the User (security/routes.ts) against the
 * self-host in-memory database (#813). They read and write through the
 * server's Admin SDK, and delete Bank Accounts and Transactions through the
 * callables, as the User whose Bearer token they forward: here those
 * callables run in-process, the real ones. The client SDK is the self-host
 * one, which a server route cannot authenticate to, so a route still using it
 * fails here.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { __resetFirestoreShim, __whenShimIdle, getFirestore, Timestamp } from "./firestore-shim";
import { __resetTriggerShim, drainTriggers } from "./trigger-shim";
import { asUser, enableInternalAuth } from "./security/routes";
import { handleTool } from "../tools/handlers";
import { createDataPlane } from "./data-plane";
import { startTestServer, type TestServer } from "./test-helpers";
import { connectFileToTransactionCallable } from "../files/connectFileToTransaction";
import { computeDedupeHash } from "../imports/dedupe";

// The web container's build aliases the client SDK to the self-host data-plane
// client (next.config.ts), with NEXT_PUBLIC_FIBUKI_API_URL baked in. Loaded
// here as it is there, against a real data plane: a server route has no
// signed-in User to take a Bearer token from, so the data plane answers 401
// to anything it sends (#813).
vi.mock("firebase/app", () => import("@/lib/selfhost/app-shim"));
vi.mock("firebase/firestore", () => import("@/lib/selfhost/firestore-client"));
vi.mock("@/lib/import/deduplication", () => ({
  generateDedupeHash: async (...parts: unknown[]) => parts.map(String).join("|"),
  normalizeIban: (iban: string) => iban.replace(/\s/g, "").toUpperCase(),
}));

// A route forwards the User's Bearer token to the callable; here the token is
// the uid, and the real callable runs as it. An error comes back in the shape
// the real helper throws on an HTTP error.
vi.mock("@/lib/api/firebase-callable", () => ({
  callFirebaseFunction: async (name: string, data: unknown, token?: string) => {
    const callables: Record<string, () => Promise<unknown>> = {
      deleteSource: async () => (await import("../sources/deleteSource")).deleteSourceCallable,
      deleteTransactionsBySource: async () =>
        (await import("../transactions/deleteTransactionsBySource")).deleteTransactionsBySourceCallable,
      cleanupOrphanedTransactions: async () =>
        (await import("../banking/cleanupOrphanedTransactions")).cleanupOrphanedTransactionsCallable,
    };
    if (!callables[name]) throw new Error(`Firebase function ${name} failed: 404 - no such callable in this test`);
    if (!token) throw new Error(`Firebase function ${name} failed: 401 - {"error":{"message":"Unauthenticated"}}`);
    const callable = (await callables[name]()) as { run: (r: unknown) => Promise<unknown> };
    try {
      return await callable.run({ data, auth: { uid: token.replace(/^Bearer /, ""), token: {} } });
    } catch (err) {
      throw new Error(`Firebase function ${name} failed: 400 - ${JSON.stringify({ error: { message: (err as Error).message } })}`);
    }
  },
}));

type Line = { transaction_id: string; timestamp: string; amount: number; currency: string; transaction_type: string; description: string };
const DEFAULT_LINES: Line[] = [
  { transaction_id: "tl-old", timestamp: "2023-12-30T10:00:00Z", amount: 5, currency: "EUR", transaction_type: "DEBIT", description: "Old" },
  { transaction_id: "tl-new", timestamp: "2024-01-03T10:00:00Z", amount: 7, currency: "EUR", transaction_type: "DEBIT", description: "New" },
];
const truelayer = vi.hoisted(() => ({ lines: null as null | Array<Record<string, unknown>> }));

vi.mock("@/lib/truelayer", () => ({
  getAccountIban: () => "AT483200000012345864",
  getTrueLayerClient: () => ({
    getTransactions: async () => truelayer.lines ?? DEFAULT_LINES,
    getAccount: async () => ({ account_id: "acc-1", currency: "EUR", account_number: { iban: "AT483200000012345864" } }),
    getAccounts: async () => [{ account_id: "acc-1" }, { account_id: "acc-2" }],
    exchangeCode: async () => ({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 }),
    refreshToken: async () => {
      throw new Error("no refresh in tests");
    },
  }),
}));

const db = getFirestore();
const USER = "fyr-user";
const IBAN = "AT483200000012345864";
const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));
const future = () => Timestamp.fromDate(new Date(Date.now() + 3_600_000));

/** A request as the User, carrying the Bearer token the route forwards to the callables. */
function asOwner(url: string, init: { method?: string; body?: unknown } = {}) {
  return asUser(USER, url, { ...init, headers: { Authorization: `Bearer ${USER}` } });
}

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

async function rows(sourceId: string) {
  return (await db.collection("transactions").where("sourceId", "==", sourceId).get()).docs.map((d) => d.data());
}

/** A receipt connected to a Transaction through the File Connection writer. */
async function connectReceipt(fileId: string, transactionId: string, iso: string) {
  await db.collection("files").doc(fileId).set({
    userId: USER,
    fileName: `${fileId}.pdf`,
    fileType: "application/pdf",
    extractionComplete: true,
    partnerMatchComplete: true,
    transactionMatchComplete: true,
    extractedAmount: 100,
    extractedCurrency: "EUR",
    extractedDate: day(iso),
    extractedPartner: "Vendor",
    invoiceDirection: "incoming",
    transactionIds: [],
    transactionSuggestions: [],
    uploadedAt: day(iso),
  });
  await connectFileToTransactionCallable.run({ data: { fileId, transactionId }, auth: { uid: USER, token: {} } } as never);
  await drainTriggers();
  expect((await db.collection("files").doc(fileId).get()).data()!.transactionIds).toEqual([transactionId]);
}

async function fileTransactionIds(fileId: string) {
  await drainTriggers();
  return (await db.collection("files").doc(fileId).get()).data()!.transactionIds;
}

let dataPlane: TestServer;

beforeAll(async () => {
  enableInternalAuth();
  dataPlane = await startTestServer((app) => {
    app.use("/__data", createDataPlane(async (token) => (token === "user-token" ? { uid: USER, token: {} } : null)));
  });
  process.env.NEXT_PUBLIC_FIBUKI_API_URL = dataPlane.base;
});

afterAll(() => dataPlane.close());

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
  truelayer.lines = null;
});

describe("a bank disconnect keeps the Closed stretch", () => {
  it("is refused while the Bank Account holds a closed Transaction, and deletes nothing", async () => {
    await db.collection("sources").doc("api-1").set({ userId: USER, name: "Bank", type: "api", apiConfig: { provider: "truelayer" } });
    await handleTool(USER, "set_fiscal_years", { trackedFrom: "2023-01", closedThrough: "2024-12" });
    await seedTransaction("tx-closed", "2024-05-01", "api-1");
    await seedTransaction("tx-open", "2025-05-01", "api-1");

    const { POST } = await import("@/app/api/sources/[id]/disconnect/route");
    const res = await POST(asOwner("/api/sources/api-1/disconnect", { method: "POST" }), {
      params: Promise.resolve({ id: "api-1" }),
    });

    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/Closed Through is 2024-12/);
    expect(await exists("tx-closed")).toBe(true);
    expect(await exists("tx-open")).toBe(true);
    expect((await db.collection("sources").doc("api-1").get()).data()!.type).toBe("api");
  });
});

describe("a bank disconnect checks every row it deletes (#813)", () => {
  beforeEach(async () => {
    await db.collection("sources").doc("api-1").set({ userId: USER, name: "Bank", type: "api", apiConfig: { provider: "truelayer" } });
    await handleTool(USER, "set_fiscal_years", { trackedFrom: "2023-01", closedThrough: "2024-12" });
  });

  async function disconnect() {
    const { POST } = await import("@/app/api/sources/[id]/disconnect/route");
    return POST(asOwner("/api/sources/api-1/disconnect", { method: "POST" }), { params: Promise.resolve({ id: "api-1" }) });
  }

  it("is refused for a closed row without the User's id, and deletes nothing", async () => {
    await db.collection("transactions").doc("tx-closed-nouser").set({ sourceId: "api-1", date: day("2024-05-01"), amount: -100, name: "Vendor", fileIds: [] });
    await seedTransaction("tx-open", "2025-05-01", "api-1");

    const res = await disconnect();

    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/Closed Through is 2024-12/);
    expect(await exists("tx-closed-nouser")).toBe(true);
    expect(await exists("tx-open")).toBe(true);
    expect((await db.collection("sources").doc("api-1").get()).data()!.type).toBe("api");
  });

  it("deletes every row when all are Open, one without the User's id included", async () => {
    await seedTransaction("tx-open-1", "2025-05-01", "api-1");
    await db.collection("transactions").doc("tx-open-nouser").set({ sourceId: "api-1", date: day("2025-06-01"), amount: -100, name: "Vendor", fileIds: [] });
    await seedTransaction("tx-other-source", "2025-05-01", "api-2");

    const res = await disconnect();

    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, deletedTransactions: 2 });
    expect(await exists("tx-open-1")).toBe(false);
    expect(await exists("tx-open-nouser")).toBe(false);
    expect(await exists("tx-other-source")).toBe(true);
    const source = (await db.collection("sources").doc("api-1").get()).data()!;
    expect(source.type).toBe("csv");
    expect(source.apiConfig).toBeUndefined();
  });

  it("takes a deleted Transaction off its File", async () => {
    await seedTransaction("tx-receipted", "2025-05-01", "api-1");
    await connectReceipt("f-1", "tx-receipted", "2025-05-01");

    const res = await disconnect();

    expect(res.status, await res.clone().text()).toBe(200);
    expect(await exists("tx-receipted")).toBe(false);
    expect(await fileTransactionIds("f-1")).toEqual([]);
  });
});

describe("the orphan cleanup route keeps closed orphans", () => {
  it("deletes the open orphan, keeps the closed one and says so", async () => {
    await handleTool(USER, "set_fiscal_years", { trackedFrom: "2023-01", closedThrough: "2024-12" });
    await seedTransaction("orphan-closed", "2024-05-01", "gone");
    await seedTransaction("orphan-open", "2025-05-01", "gone");

    const { POST } = await import("@/app/api/sources/delete-orphans/route");
    const res = await POST(asOwner("/api/sources/delete-orphans", { method: "POST" }));
    const body = (await res.json()) as { deletedTransactions: number; keptClosedTransactions: number };

    expect(body).toMatchObject({ deletedTransactions: 1, keptClosedTransactions: 1 });
    expect(await exists("orphan-closed")).toBe(true);
    expect(await exists("orphan-open")).toBe(false);
  });

  it("takes a deleted orphan off its File", async () => {
    await seedTransaction("orphan-receipted", "2025-05-01", "gone");
    await connectReceipt("f-orphan", "orphan-receipted", "2025-05-01");

    const { POST } = await import("@/app/api/sources/delete-orphans/route");
    const res = await POST(asOwner("/api/sources/delete-orphans", { method: "POST" }));
    expect(res.status, await res.clone().text()).toBe(200);

    expect(await exists("orphan-receipted")).toBe(false);
    expect(await fileTransactionIds("f-orphan")).toEqual([]);
  });

  it("deletes a Bank Account missing its required fields and a TrueLayer connection no Bank Account uses", async () => {
    await db.collection("sources").doc("broken").set({ userId: USER, name: "Broken" });
    await db.collection("sources").doc("whole").set({
      userId: USER,
      name: "Bank",
      accountKind: "bank_account",
      type: "api",
      apiConfig: { provider: "truelayer", connectionId: "tl-used" },
    });
    await db.doc("truelayerConnections/tl-used").set({ userId: USER, providerId: "tl-bank" });
    await db.doc("truelayerConnections/tl-unused").set({ userId: USER, providerId: "tl-bank" });
    await db.doc("truelayerConnections/tl-someone-else").set({ userId: "other-user", providerId: "tl-bank" });
    await seedTransaction("on-whole", "2025-05-01", "whole");
    await seedTransaction("on-broken", "2025-05-01", "broken");
    await connectReceipt("f-broken", "on-broken", "2025-05-01");

    const { POST } = await import("@/app/api/sources/delete-orphans/route");
    const res = await POST(asOwner("/api/sources/delete-orphans", { method: "POST" }));
    expect(res.status, await res.clone().text()).toBe(200);

    expect(await res.json()).toMatchObject({ deletedSources: 1, deletedConnections: 1, deletedTransactions: 1, keptClosedTransactions: 0, keptSources: [] });
    expect((await db.collection("sources").doc("broken").get()).exists).toBe(false);
    expect((await db.collection("sources").doc("whole").get()).exists).toBe(true);
    expect((await db.doc("truelayerConnections/tl-unused").get()).exists).toBe(false);
    expect((await db.doc("truelayerConnections/tl-used").get()).exists).toBe(true);
    expect((await db.doc("truelayerConnections/tl-someone-else").get()).exists).toBe(true);
    expect(await exists("on-whole")).toBe(true);
    expect(await exists("on-broken")).toBe(false);
    expect(await fileTransactionIds("f-broken")).toEqual([]);
  });

  it("keeps a Bank Account missing its required fields while it holds a closed Transaction, and all its rows", async () => {
    await handleTool(USER, "set_fiscal_years", { trackedFrom: "2023-01", closedThrough: "2024-12" });
    await db.collection("sources").doc("broken-closed").set({ userId: USER, name: "Broken" });
    await seedTransaction("broken-closed-row", "2024-05-01", "broken-closed");
    await seedTransaction("broken-open-row", "2025-05-01", "broken-closed");

    const { POST } = await import("@/app/api/sources/delete-orphans/route");
    const res = await POST(asOwner("/api/sources/delete-orphans", { method: "POST" }));
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { deletedSources: number; deletedTransactions: number; keptSources: Array<{ id: string; reason: string }> };

    expect(body).toMatchObject({ deletedSources: 0, deletedTransactions: 0 });
    expect(body.keptSources).toEqual([{ id: "broken-closed", name: "Broken", reason: expect.stringMatching(/Closed Through is 2024-12/) }]);
    expect((await db.collection("sources").doc("broken-closed").get()).exists).toBe(true);
    expect(await exists("broken-closed-row")).toBe(true);
    expect(await exists("broken-open-row")).toBe(true);
  });
});

describe("the TrueLayer callback stores the connection", () => {
  it("writes the tokens and accounts on the User's connection and sends them to account selection", async () => {
    const form = new FormData();
    form.set("code", "auth-code");
    form.set("state", Buffer.from(JSON.stringify({ providerId: "tl-bank", providerName: "Bank" })).toString("base64url"));
    const request = new NextRequest(new URL("https://web.test/api/truelayer/callback"), {
      method: "POST",
      headers: asUser(USER, "/api/truelayer/callback").headers,
      body: form,
    });

    const { POST } = await import("@/app/api/truelayer/callback/route");
    const res = await POST(request);

    const location = res.headers.get("location") ?? "";
    expect(location).toMatch(/\/sources\/connect\/accounts\?connectionId=/);
    const connectionId = new URL(location).searchParams.get("connectionId")!;
    const stored = (await db.doc(`truelayerConnections/${connectionId}`).get()).data()!;
    expect(stored).toMatchObject({ userId: USER, accessToken: "fresh-access", refreshToken: "fresh-refresh", accountIds: ["acc-1", "acc-2"], providerName: "Bank" });
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

  async function syncSource() {
    await db.collection("sources").doc("tl-src").set({
      userId: USER,
      name: "Bank",
      type: "api",
      iban: IBAN,
      apiConfig: { provider: "truelayer", connectionId: "tl-1", accountId: "acc-1", lastSyncAt: day("2024-01-01") },
    });
  }

  async function sync() {
    const { POST } = await import("@/app/api/truelayer/sync/route");
    return POST(asUser(USER, "/api/truelayer/sync", { body: { sourceId: "tl-src" } }));
  }

  it("a sync writes the tracked row and counts the other per fiscal year", async () => {
    await syncSource();
    const start = Date.now();

    const res = await sync();
    const body = (await res.json()) as { imported: number; untrackedCount: number; untrackedByFiscalYear: Record<string, number> };

    expect(body).toMatchObject({ imported: 1, skipped: 0, total: 2, untrackedCount: 1, untrackedByFiscalYear: { "2023": 1 } });
    expect(await names("tl-src")).toEqual(["New"]);
    const [row] = await rows("tl-src");
    expect(row).toMatchObject({ userId: USER, amount: -700, externalRowId: "tl-new", fileIds: [], isComplete: false });
    const lastSyncAt = (await db.collection("sources").doc("tl-src").get()).data()!.apiConfig.lastSyncAt as Timestamp;
    expect(lastSyncAt.toMillis()).toBeGreaterThanOrEqual(start);

    const again = await sync();
    expect(await again.json()).toMatchObject({ imported: 0, skipped: 1, untrackedCount: 1 });
    expect(await names("tl-src")).toEqual(["New"]);
  });

  it("stores a line on its Vienna calendar day, and judges that day against Tracked From", async () => {
    await handleTool(USER, "set_fiscal_years", { trackedFrom: "2025-01" });
    await syncSource();
    truelayer.lines = [
      { transaction_id: "tl-eve", timestamp: "2024-12-31T23:30:00Z", amount: 3, currency: "EUR", transaction_type: "DEBIT", description: "New Year's Eve" },
    ];

    const res = await sync();

    expect(await res.json()).toMatchObject({ imported: 1, untrackedCount: 0 });
    const [row] = await rows("tl-src");
    expect((row.date as Timestamp).toDate().toISOString()).toBe("2025-01-01T00:00:00.000Z");
  });

  it("a row stored before External Row Ids, by the hash of TrueLayer's instant, still holds its line back", async () => {
    await syncSource();
    // Late evening UTC: the Vienna day is the next one, the hash keeps the UTC day.
    const timestamp = "2024-03-10T23:30:00Z";
    truelayer.lines = [{ transaction_id: "tl-late", timestamp, amount: 4, currency: "EUR", transaction_type: "DEBIT", description: "Late" }];
    await db.collection("transactions").doc("stored-before-ids").set({
      userId: USER,
      sourceId: "tl-src",
      date: Timestamp.fromDate(new Date(timestamp)),
      amount: -400,
      name: "Late",
      importJobId: null,
      dedupeHash: computeDedupeHash({ date: new Date(timestamp), amount: -400, sourceIdentifier: IBAN, reference: "tl-late" }),
      fileIds: [],
    });

    const res = await sync();

    expect(await res.json()).toMatchObject({ imported: 0, skipped: 1 });
    expect((await rows("tl-src")).length).toBe(1);
  });

  it("counts the written rows against the plan's monthly quota and marks the ones over it", async () => {
    await syncSource();
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    await db.collection("subscriptions").doc(USER).set({ plan: "free", transactionCountCurrentMonth: 49, transactionCountMonth: month });
    truelayer.lines = [
      { transaction_id: "tl-a", timestamp: "2024-02-01T10:00:00Z", amount: 1, currency: "EUR", transaction_type: "DEBIT", description: "A" },
      { transaction_id: "tl-b", timestamp: "2024-02-02T10:00:00Z", amount: 2, currency: "EUR", transaction_type: "DEBIT", description: "B" },
    ];

    const res = await sync();

    expect(await res.json()).toMatchObject({ imported: 2, overLimitCount: 1 });
    const stored = await rows("tl-src");
    expect(stored.filter((r) => r.quotaExceeded === true)).toHaveLength(1);
    await vi.waitFor(async () =>
      expect((await db.collection("subscriptions").doc(USER).get()).data()!.transactionCountCurrentMonth).toBe(50)
    );
  });

  it("creating a Bank Account from an account stores it and runs its first sync with the same skip", async () => {
    const { POST } = await import("@/app/api/truelayer/accounts/route");
    const res = await POST(asUser(USER, "/api/truelayer/accounts", { body: { connectionId: "tl-1", accountId: "acc-1", name: "Giro" } }));
    expect(res.status, await res.clone().text()).toBe(200);
    const { sourceId } = (await res.json()) as { sourceId: string };

    const source = (await db.collection("sources").doc(sourceId).get()).data()!;
    expect(source).toMatchObject({ userId: USER, name: "Giro", type: "api", iban: IBAN, apiConfig: { provider: "truelayer", connectionId: "tl-1", accountId: "acc-1" } });
    await vi.waitFor(async () => expect(await names(sourceId)).toEqual(["New"]));
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
