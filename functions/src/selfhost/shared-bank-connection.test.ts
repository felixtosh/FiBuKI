/**
 * One bank connection can back several Bank Accounts (#815): a TrueLayer
 * connection is linked to each account the User picked from it, and a finAPI
 * bank connection holds every account at that bank. Deleting or disconnecting
 * one of them keeps the connection while another of the User's Bank Accounts
 * still uses it; the last one removes it, as before.
 *
 * The callables and routes run in-process as the User against the self-host
 * in-memory database. Routes forward the User's Bearer token to the real
 * callables, as in fiscal-years-routes.test.ts. The finAPI deletes are
 * recorded: the disconnect route's through its FinapiClient, the Bank Account
 * delete's through the HTTP call it makes.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { __resetFirestoreShim, __whenShimIdle, getFirestore, Timestamp } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";
import { asUser, enableInternalAuth } from "./security/routes";
import { deleteSourceCallable } from "../sources/deleteSource";
import { handleTool } from "../tools/handlers";

vi.mock("@/lib/import/deduplication", () => ({
  generateDedupeHash: async (...parts: unknown[]) => parts.map(String).join("|"),
  normalizeIban: (iban: string) => iban.replace(/\s/g, "").toUpperCase(),
}));

/** The finAPI bank connections deleted, by whichever path deleted them. */
const finapi = vi.hoisted(() => ({ deleted: [] as unknown[] }));

vi.mock("@/lib/finapi/client", () => ({
  FinapiClient: class {
    async deleteBankConnection(id: unknown) {
      finapi.deleted.push(id);
    }
  },
}));

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

vi.mock("@/lib/truelayer", () => ({
  getAccountIban: () => "AT483200000012345864",
  getTrueLayerClient: () => ({
    getTransactions: async () => [
      { transaction_id: "tl-line", timestamp: "2025-05-03T10:00:00Z", amount: 7, currency: "EUR", transaction_type: "DEBIT", description: "Line" },
    ],
    refreshToken: async () => {
      throw new Error("no refresh in tests");
    },
  }),
}));

const db = getFirestore();
const USER = "shared-conn-user";
const OTHER = "shared-conn-other";
const IBAN = "AT483200000012345864";
const future = () => Timestamp.fromDate(new Date(Date.now() + 3_600_000));

function asOwner(url: string, init: { method?: string; body?: unknown } = {}) {
  return asUser(USER, url, { ...init, headers: { Authorization: `Bearer ${USER}` } });
}

async function deleteSource(sourceId: string, uid = USER) {
  return deleteSourceCallable.run({ data: { sourceId }, auth: { uid, token: {} } } as never);
}

async function disconnect(sourceId: string) {
  const { POST } = await import("@/app/api/sources/[id]/disconnect/route");
  return POST(asOwner(`/api/sources/${sourceId}/disconnect`, { method: "POST" }), { params: Promise.resolve({ id: sourceId }) });
}

async function deleteOrphans() {
  const { POST } = await import("@/app/api/sources/delete-orphans/route");
  return POST(asOwner("/api/sources/delete-orphans", { method: "POST" }));
}

async function sync(sourceId: string) {
  const { POST } = await import("@/app/api/truelayer/sync/route");
  return POST(asUser(USER, "/api/truelayer/sync", { body: { sourceId } }));
}

async function exists(path: string) {
  return (await db.doc(path).get()).exists;
}

async function seedTrueLayerConnection(id: string, userId = USER) {
  await db.doc(`truelayerConnections/${id}`).set({
    userId,
    accessToken: "token",
    refreshToken: "refresh",
    tokenExpiresAt: future(),
    providerId: "tl-bank",
    providerName: "Bank",
  });
}

async function seedTrueLayerAccount(id: string, connectionId: string, extra: Record<string, unknown> = {}) {
  await db.collection("sources").doc(id).set({
    userId: USER,
    name: `Bank ${id}`,
    accountKind: "bank_account",
    type: "api",
    iban: IBAN,
    apiConfig: { provider: "truelayer", connectionId, accountId: `acc-${id}` },
    ...extra,
  });
}

beforeAll(() => {
  enableInternalAuth();
});

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
  finapi.deleted.length = 0;
  // A synced line is written only in a Tracked year.
  await handleTool(USER, "set_fiscal_years", { trackedFrom: "2024-01" });
});

describe("deleting a Bank Account on a shared TrueLayer connection", () => {
  it("keeps the connection while a sibling uses it, and the sibling still syncs", async () => {
    await seedTrueLayerConnection("tl-shared");
    await seedTrueLayerAccount("tl-a", "tl-shared");
    await seedTrueLayerAccount("tl-b", "tl-shared");

    await deleteSource("tl-a");

    expect(await exists("sources/tl-a")).toBe(false);
    expect(await exists("truelayerConnections/tl-shared")).toBe(true);
    const res = await sync("tl-b");
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ imported: 1 });
    expect((await db.collection("transactions").where("sourceId", "==", "tl-b").get()).size).toBe(1);
  });

  it("deletes the connection with the last Bank Account on it", async () => {
    await seedTrueLayerConnection("tl-shared");
    await seedTrueLayerAccount("tl-a", "tl-shared");
    await seedTrueLayerAccount("tl-b", "tl-shared");

    await deleteSource("tl-a");
    await deleteSource("tl-b");

    expect(await exists("sources/tl-b")).toBe(false);
    expect(await exists("truelayerConnections/tl-shared")).toBe(false);
  });

  it("counts only the User's own Bank Accounts as still using it", async () => {
    await seedTrueLayerConnection("tl-mine");
    await seedTrueLayerAccount("tl-a", "tl-mine");
    await db.collection("sources").doc("tl-theirs").set({
      userId: OTHER,
      name: "Their bank",
      accountKind: "bank_account",
      type: "api",
      apiConfig: { provider: "truelayer", connectionId: "tl-mine", accountId: "acc-x" },
    });

    await deleteSource("tl-a");

    expect(await exists("truelayerConnections/tl-mine")).toBe(false);
    expect(await exists("sources/tl-theirs")).toBe(true);
  });
});

/** A finAPI Bank Account on bank connection 42; `bankConnectionId` as the linking path stored it. */
async function seedFinapiAccount(id: string, bankConnectionId: number | string, userId = USER, extra: Record<string, unknown> = {}) {
  await db.collection("sources").doc(id).set({
    userId,
    name: `Bank ${id}`,
    accountKind: "bank_account",
    type: "api",
    apiConfig: { provider: "finapi", bankConnectionId, accountId: id.length, userAccessToken: "finapi-token" },
    ...extra,
  });
}

/**
 * The Bank Account delete calls finAPI's HTTP API itself: its bank connection
 * deletes are recorded (by the id in the URL, so as text) and answered OK.
 * Every other request goes out as it would.
 */
function recordFinapiDeletes() {
  process.env.FINAPI_CLIENT_ID = "id";
  process.env.FINAPI_CLIENT_SECRET = "secret";
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const match = url.match(/finapi\.io\/api\/v2\/bankConnections\/([^/?]+)$/);
    if (match && init?.method === "DELETE") {
      finapi.deleted.push(match[1]);
      return new Response(null, { status: 200 });
    }
    return realFetch(input, init);
  });
}

describe("a shared finAPI bank connection", () => {
  beforeEach(recordFinapiDeletes);
  afterEach(() => vi.unstubAllGlobals());

  it("deleting one of two Bank Accounts on it makes no finAPI delete; deleting the last one does", async () => {
    await seedFinapiAccount("fa-a", 42);
    await seedFinapiAccount("fa-b", "42");

    await deleteSource("fa-a");

    expect(await exists("sources/fa-a")).toBe(false);
    expect(finapi.deleted).toEqual([]);
    expect((await db.collection("sources").doc("fa-b").get()).data()!.apiConfig).toMatchObject({ provider: "finapi", bankConnectionId: "42" });

    await deleteSource("fa-b");

    expect(await exists("sources/fa-b")).toBe(false);
    expect(finapi.deleted).toEqual(["42"]);
  });

  it("disconnecting one of two Bank Accounts on it makes no finAPI delete; disconnecting the last one does", async () => {
    await seedFinapiAccount("fa-a", 42);
    await seedFinapiAccount("fa-b", 42);

    const first = await disconnect("fa-a");

    expect(first.status, await first.clone().text()).toBe(200);
    expect(finapi.deleted).toEqual([]);
    expect((await db.collection("sources").doc("fa-a").get()).data()!).toMatchObject({ type: "csv" });
    expect((await db.collection("sources").doc("fa-b").get()).data()!).toMatchObject({ type: "api", apiConfig: { bankConnectionId: 42 } });

    const last = await disconnect("fa-b");

    expect(last.status, await last.clone().text()).toBe(200);
    expect(finapi.deleted).toEqual([42]);
    expect((await db.collection("sources").doc("fa-b").get()).data()!.apiConfig).toBeUndefined();
  });

  it("counts only the User's own Bank Accounts as still using it", async () => {
    await seedFinapiAccount("fa-a", 42);
    await seedFinapiAccount("fa-theirs", 42, OTHER);

    await deleteSource("fa-a");

    expect(finapi.deleted).toEqual(["42"]);
    expect(await exists("sources/fa-theirs")).toBe(true);
  });

  it("disconnecting counts only the User's own Bank Accounts too", async () => {
    await seedFinapiAccount("fa-a", 42);
    await seedFinapiAccount("fa-theirs", 42, OTHER);

    const res = await disconnect("fa-a");

    expect(res.status, await res.clone().text()).toBe(200);
    expect(finapi.deleted).toEqual([42]);
  });
});

describe("the orphan cleanup keeps a connection a Bank Account still uses", () => {
  beforeEach(recordFinapiDeletes);
  afterEach(() => vi.unstubAllGlobals());

  it("deletes a broken Bank Account and keeps the TrueLayer connection its sibling syncs through", async () => {
    await seedTrueLayerConnection("tl-shared");
    // Missing its accountKind, so the cleanup deletes it.
    await db.collection("sources").doc("tl-broken").set({ userId: USER, name: "Broken", type: "api", apiConfig: { provider: "truelayer", connectionId: "tl-shared" } });
    await seedTrueLayerAccount("tl-whole", "tl-shared");

    const res = await deleteOrphans();

    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ deletedSources: 1, deletedConnections: 0 });
    expect(await exists("sources/tl-broken")).toBe(false);
    expect(await exists("truelayerConnections/tl-shared")).toBe(true);
  });

  it("deletes the TrueLayer connection when the broken Bank Accounts were the only ones on it", async () => {
    await seedTrueLayerConnection("tl-shared");
    await db.collection("sources").doc("tl-broken-1").set({ userId: USER, name: "B1", type: "api", apiConfig: { provider: "truelayer", connectionId: "tl-shared" } });
    await db.collection("sources").doc("tl-broken-2").set({ userId: USER, name: "B2", type: "api", apiConfig: { provider: "truelayer", connectionId: "tl-shared" } });

    const res = await deleteOrphans();

    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ deletedSources: 2 });
    expect(await exists("truelayerConnections/tl-shared")).toBe(false);
  });

  it("makes no finAPI delete for a broken Bank Account whose sibling stays, and one for a broken Bank Account alone on its connection", async () => {
    await db.collection("sources").doc("fa-broken").set({ userId: USER, name: "Broken", type: "api", apiConfig: { provider: "finapi", bankConnectionId: 42, userAccessToken: "t" } });
    await seedFinapiAccount("fa-whole", 42);
    await db.collection("sources").doc("fa-broken-alone").set({ userId: USER, name: "Alone", type: "api", apiConfig: { provider: "finapi", bankConnectionId: 7, userAccessToken: "t" } });

    const res = await deleteOrphans();

    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ deletedSources: 2 });
    expect(await exists("sources/fa-broken")).toBe(false);
    expect(await exists("sources/fa-whole")).toBe(true);
    expect(finapi.deleted).toEqual(["7"]);
  });
});
