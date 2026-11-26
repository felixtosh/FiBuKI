/**
 * Fiscal Years (#794) on the Next API routes that write Transactions: a bank
 * disconnect and the orphan cleanup keep closed rows, and the TrueLayer
 * syncs skip rows before Tracked From and count them per fiscal year.
 *
 * Routes are called in-process as the User (security/routes.ts) against the
 * self-host in-memory database. They write through the server's Admin SDK and
 * its writers (#813): the client SDK is the self-host one, which a server
 * route cannot authenticate to, so a route still using it fails here.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { __resetFirestoreShim, __whenShimIdle, getFirestore, Timestamp } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";
import { asUser, enableInternalAuth } from "./security/routes";
import { handleTool } from "../tools/handlers";
import { createDataPlane } from "./data-plane";
import { startTestServer, type TestServer } from "./test-helpers";

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
vi.mock("@/lib/truelayer", () => ({
  getAccountIban: () => "AT483200000012345864",
  getTrueLayerClient: () => ({
    getTransactions: async () => [
      { transaction_id: "tl-old", timestamp: "2023-12-30T10:00:00Z", amount: 5, currency: "EUR", transaction_type: "DEBIT", description: "Old" },
      { transaction_id: "tl-new", timestamp: "2024-01-03T10:00:00Z", amount: 7, currency: "EUR", transaction_type: "DEBIT", description: "New" },
    ],
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

describe("a bank disconnect checks every row it deletes (#813)", () => {
  beforeEach(async () => {
    await db.collection("sources").doc("api-1").set({ userId: USER, name: "Bank", type: "api", apiConfig: { provider: "truelayer" } });
    await handleTool(USER, "set_fiscal_years", { trackedFrom: "2023-01", closedThrough: "2024-12" });
  });

  async function disconnect() {
    const { POST } = await import("@/app/api/sources/[id]/disconnect/route");
    return POST(asUser(USER, "/api/sources/api-1/disconnect", { method: "POST" }), { params: Promise.resolve({ id: "api-1" }) });
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

    const { POST } = await import("@/app/api/sources/delete-orphans/route");
    const res = await POST(asUser(USER, "/api/sources/delete-orphans", { method: "POST" }));
    expect(res.status, await res.clone().text()).toBe(200);

    expect(await res.json()).toMatchObject({ deletedSources: 1, deletedConnections: 1, deletedTransactions: 1, keptClosedTransactions: 0 });
    expect((await db.collection("sources").doc("broken").get()).exists).toBe(false);
    expect((await db.collection("sources").doc("whole").get()).exists).toBe(true);
    expect((await db.doc("truelayerConnections/tl-unused").get()).exists).toBe(false);
    expect((await db.doc("truelayerConnections/tl-used").get()).exists).toBe(true);
    expect((await db.doc("truelayerConnections/tl-someone-else").get()).exists).toBe(true);
    expect(await exists("on-whole")).toBe(true);
    expect(await exists("on-broken")).toBe(false);
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

    expect(body).toMatchObject({ imported: 1, skipped: 0, total: 2, untrackedCount: 1, untrackedByFiscalYear: { "2023": 1 } });
    expect(await names("tl-src")).toEqual(["New"]);
    const [row] = (await db.collection("transactions").where("sourceId", "==", "tl-src").get()).docs.map((d) => d.data());
    expect(row).toMatchObject({ userId: USER, amount: -700, externalRowId: "tl-new", fileIds: [], isComplete: false });
    expect((await db.collection("sources").doc("tl-src").get()).data()!.apiConfig.lastSyncAt).toBeDefined();

    const again = await POST(asUser(USER, "/api/truelayer/sync", { body: { sourceId: "tl-src" } }));
    expect(await again.json()).toMatchObject({ imported: 0, skipped: 1, untrackedCount: 1 });
    expect(await names("tl-src")).toEqual(["New"]);
  });

  it("creating a Bank Account from an account stores it and runs its first sync with the same skip", async () => {
    const { POST } = await import("@/app/api/truelayer/accounts/route");
    const res = await POST(asUser(USER, "/api/truelayer/accounts", { body: { connectionId: "tl-1", accountId: "acc-1", name: "Giro" } }));
    expect(res.status, await res.clone().text()).toBe(200);
    const { sourceId } = (await res.json()) as { sourceId: string };

    const source = (await db.collection("sources").doc(sourceId).get()).data()!;
    expect(source).toMatchObject({ userId: USER, name: "Giro", type: "api", iban: "AT483200000012345864", apiConfig: { provider: "truelayer", connectionId: "tl-1", accountId: "acc-1" } });
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
