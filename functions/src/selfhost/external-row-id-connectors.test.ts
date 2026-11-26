/**
 * External Row Id from the bank connectors and the CSV Import (#804, spec #800).
 *
 * The finAPI syncs fill it from finAPI's transaction id, the TrueLayer syncs
 * from TrueLayer's, and the CSV Import from the column mapped as Reference /
 * Transaction ID when that column is one. All of them go through the Import
 * writer's duplicate split (imports/dedupe.ts), so a line whose id the Bank
 * Account already stores is never written twice, and the connectors' own
 * dedupe hashes still hold back the rows stored before ids existed.
 *
 * Driven through the sync callables, the TrueLayer routes and the CSV callable
 * against the self-host in-memory database; asserted on the stored rows. The
 * TrueLayer routes' client Firestore SDK points at the same shim database, as
 * in fiscal-years-routes.test.ts.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { getFirestore, FieldValue, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";
import { asUser, enableInternalAuth } from "./security/routes";

// REAL application code, unmodified:
import { handleTool } from "../tools/handlers";
import { syncFinapiTransactions } from "../finapi/syncCallable";
import { syncBankTransactionsCallable } from "../banking/syncBankTransactions";
import { bulkCreateTransactionsCallable } from "../imports/bulkCreateTransactions";
import { applyImportRemapCallable } from "../imports/applyImportRemap";
import { externalRowIdsFromReferences } from "../imports/externalRowId";

const truelayer = vi.hoisted(() => ({ lines: [] as Array<Record<string, unknown>> }));

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
    getTransactions: async () => truelayer.lines,
    getAccount: async () => ({ account_id: "acc-1", currency: "EUR", account_number: { iban: "AT483200000012345864" } }),
    refreshToken: async () => {
      throw new Error("no refresh in tests");
    },
  }),
}));

const db = getFirestore();
const USER = "erc-user";
const AUTH = { uid: USER, token: {} };
const future = () => Timestamp.fromDate(new Date(Date.now() + 3_600_000));

type Stored = { externalRowId: string | null; name: string; amount: number };

async function stored(sourceId: string): Promise<Stored[]> {
  const snap = await db.collection("transactions").where("sourceId", "==", sourceId).get();
  return snap.docs
    .map((d) => {
      const data = d.data() as { externalRowId?: string; name: string; amount: number };
      return { externalRowId: data.externalRowId ?? null, name: data.name, amount: data.amount };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A row stored before this change: same row, no External Row Id. */
async function forgetIds(sourceId: string) {
  const snap = await db.collection("transactions").where("sourceId", "==", sourceId).get();
  for (const d of snap.docs) await d.ref.update({ externalRowId: FieldValue.delete() });
}

beforeAll(() => enableInternalAuth());

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
  await handleTool(USER, "set_fiscal_years", { trackedFrom: "2024-01" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ============================================================================
// finAPI
// ============================================================================

type FinapiLine = { id: number; bankBookingDate: string; amount: number; counterpartName?: string; purpose?: string };

function stubFinapi(lines: FinapiLine[]) {
  const full = lines.map((l) => ({ accountId: 7, valueDate: l.bankBookingDate, ...l }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        String(url).includes("/transactions")
          ? { transactions: full, paging: { page: 1, perPage: 500, totalPages: 1, totalCount: full.length } }
          : { balance: 100 },
    }))
  );
}

describe("the finAPI sync stores finAPI's transaction id as the External Row Id", () => {
  beforeEach(async () => {
    process.env.FINAPI_CLIENT_ID = "test-client";
    process.env.FINAPI_CLIENT_SECRET = "test-secret";
    await db.collection("sources").doc("fin-1").set({
      userId: USER,
      name: "Bank",
      type: "api",
      isActive: true,
      apiConfig: { provider: "finapi", accountId: "7", userAccessToken: "token", tokenExpiresAt: future() },
    });
  });

  const sync = () =>
    syncFinapiTransactions.run({ data: { sourceId: "fin-1" }, auth: AUTH } as never) as Promise<{ imported: number; skipped: number }>;

  it("stores the id on each row", async () => {
    stubFinapi([
      { id: 101, bankBookingDate: "2024-03-01", amount: -10, counterpartName: "A" },
      { id: 102, bankBookingDate: "2024-03-02", amount: -20, counterpartName: "B" },
    ]);

    expect(await sync()).toMatchObject({ imported: 2 });
    expect((await stored("fin-1")).map((r) => r.externalRowId)).toEqual(["101", "102"]);
  });

  it("syncing the same transaction twice stores it once, even when the bank moved its booking date", async () => {
    stubFinapi([{ id: 101, bankBookingDate: "2024-03-01", amount: -10, counterpartName: "A" }]);
    await sync();

    stubFinapi([
      { id: 101, bankBookingDate: "2024-03-02", amount: -10, counterpartName: "A" },
      { id: 103, bankBookingDate: "2024-03-02", amount: -30, counterpartName: "C" },
    ]);
    const res = await sync();

    expect(res).toMatchObject({ imported: 1, skipped: 1 });
    expect((await stored("fin-1")).map((r) => r.externalRowId)).toEqual(["101", "103"]);
  });

  it("a row stored before ids existed still holds its line back by the connector's hash", async () => {
    stubFinapi([{ id: 101, bankBookingDate: "2024-03-01", amount: -10, counterpartName: "A" }]);
    await sync();
    await forgetIds("fin-1");

    const res = await sync();

    expect(res).toMatchObject({ imported: 0, skipped: 1 });
    expect(await stored("fin-1")).toHaveLength(1);
  });
});

describe("the bank sync (finAPI) stores finAPI's transaction id too", () => {
  beforeEach(async () => {
    process.env.FINAPI_CLIENT_ID = "test-client";
    process.env.FINAPI_CLIENT_SECRET = "test-secret";
    await db.collection("sources").doc("api-1").set({
      userId: USER,
      name: "Bank",
      type: "api",
      isActive: true,
      iban: "AT611904300234573201",
      apiConfig: { provider: "finapi", accountId: "7", userAccessToken: "token", tokenExpiresAt: future() },
    });
  });

  const sync = () =>
    syncBankTransactionsCallable.run({ data: { sourceId: "api-1", fromYear: 2024 }, auth: AUTH } as never) as Promise<{
      imported: number;
      skipped: number;
    }>;

  it("stores the id, and a second sync of the same transaction stores it once", async () => {
    stubFinapi([{ id: 201, bankBookingDate: "2024-04-01", amount: -10, purpose: "A" }]);
    await sync();

    stubFinapi([
      { id: 201, bankBookingDate: "2024-04-02", amount: -10, purpose: "A" },
      { id: 202, bankBookingDate: "2024-04-02", amount: -20, purpose: "B" },
    ]);
    const res = await sync();

    expect(res).toMatchObject({ imported: 1, skipped: 1 });
    expect((await stored("api-1")).map((r) => r.externalRowId)).toEqual(["201", "202"]);
  });

  it("a row stored before ids existed still holds its line back by the connector's hash", async () => {
    stubFinapi([{ id: 201, bankBookingDate: "2024-04-01", amount: -10, purpose: "A" }]);
    await sync();
    await forgetIds("api-1");

    const res = await sync();

    expect(res).toMatchObject({ imported: 0, skipped: 1 });
    expect(await stored("api-1")).toHaveLength(1);
  });
});

// ============================================================================
// TrueLayer
// ============================================================================

const tlLine = (id: string, iso: string, amount: number, description: string) => ({
  transaction_id: id,
  timestamp: `${iso}T10:00:00Z`,
  amount,
  currency: "EUR",
  transaction_type: "DEBIT",
  description,
});

describe("the TrueLayer syncs store TrueLayer's transaction id as the External Row Id", () => {
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
    await db.collection("sources").doc("tl-src").set({
      userId: USER,
      name: "Bank",
      type: "api",
      iban: "AT483200000012345864",
      apiConfig: { provider: "truelayer", connectionId: "tl-1", accountId: "acc-1" },
    });
  });

  async function sync() {
    const { POST } = await import("@/app/api/truelayer/sync/route");
    const res = await POST(asUser(USER, "/api/truelayer/sync", { body: { sourceId: "tl-src" } }));
    return (await res.json()) as { imported: number; skipped: number };
  }

  it("stores the id, and a second sync of the same transaction stores it once", async () => {
    truelayer.lines = [tlLine("tl-1", "2024-05-01", 5, "A")];
    await sync();

    truelayer.lines = [tlLine("tl-1", "2024-05-02", 5, "A"), tlLine("tl-2", "2024-05-02", 7, "B")];
    const res = await sync();

    expect(res).toMatchObject({ imported: 1, skipped: 1 });
    expect((await stored("tl-src")).map((r) => r.externalRowId)).toEqual(["tl-1", "tl-2"]);
  });

  it("two identical lines with different ids are both kept", async () => {
    truelayer.lines = [tlLine("tl-1", "2024-05-01", 5, "Coffee"), tlLine("tl-2", "2024-05-01", 5, "Coffee")];
    await sync();

    expect((await stored("tl-src")).map((r) => r.externalRowId).sort()).toEqual(["tl-1", "tl-2"]);
  });

  it("a row stored before ids existed still holds its line back by the connector's hash", async () => {
    truelayer.lines = [tlLine("tl-1", "2024-05-01", 5, "A")];
    await sync();
    await forgetIds("tl-src");

    const res = await sync();

    expect(res).toMatchObject({ imported: 0, skipped: 1 });
    expect(await stored("tl-src")).toHaveLength(1);
  });

  it("linking an account stores the ids in cents, and a later sync of the same lines adds nothing", async () => {
    await db.collection("sources").doc("tl-link").set({ userId: USER, name: "Bank", type: "csv" });
    truelayer.lines = [tlLine("tl-1", "2024-05-01", 5, "A")];

    const { POST } = await import("@/app/api/truelayer/accounts/route");
    const res = await POST(
      asUser(USER, "/api/truelayer/accounts", { body: { connectionId: "tl-1", accountId: "acc-1", sourceId: "tl-link" } })
    );
    expect(res.status, await res.clone().text()).toBe(200);
    await vi.waitFor(async () => expect(await stored("tl-link")).toHaveLength(1));
    expect(await stored("tl-link")).toEqual([{ externalRowId: "tl-1", name: "A", amount: -500 }]);

    // Linking again (the same lines once more) writes no twin.
    await POST(asUser(USER, "/api/truelayer/accounts", { body: { connectionId: "tl-1", accountId: "acc-1", sourceId: "tl-link" } }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await __whenShimIdle();
    expect(await stored("tl-link")).toHaveLength(1);
  });
});

// ============================================================================
// CSV Import
// ============================================================================

type CsvLine = { date: string; amount: number; name: string; reference: string | null };

/**
 * The rows the CSV Import sends: the browser reads the Reference / Transaction ID
 * column of the whole file and asks the shared rule which values are External Row Ids.
 */
function csvRows(lines: CsvLine[], importJobId: string) {
  const ids = externalRowIdsFromReferences(lines.map((l) => l.reference));
  return lines.map((l, i) => ({
    sourceId: "csv-1",
    date: `${l.date}T00:00:00.000Z`,
    amount: l.amount,
    currency: "EUR",
    name: l.name,
    reference: l.reference,
    ...(ids[i] ? { externalRowId: ids[i] } : {}),
    importJobId,
    csvRowIndex: i,
    _original: { date: l.date, amount: String(l.amount / 100), rawRow: {} },
  }));
}

function uploadCsv(lines: CsvLine[], importJobId: string) {
  return bulkCreateTransactionsCallable.run({
    data: { sourceId: "csv-1", transactions: csvRows(lines, importJobId) },
    auth: AUTH,
  } as never) as Promise<{ count: number; duplicateCount: number; transactionIds: string[] }>;
}

describe("the CSV Import fills the External Row Id from the Reference / Transaction ID column", () => {
  beforeEach(async () => {
    await db.collection("sources").doc("csv-1").set({ userId: USER, name: "Giro", type: "csv", isActive: true });
  });

  const withIds: CsvLine[] = [
    { date: "2024-06-03", amount: -450, name: "Cafe", reference: "TXN-1" },
    { date: "2024-06-03", amount: -450, name: "Cafe", reference: "TXN-2" },
    { date: "2024-06-04", amount: -1200, name: "Shop", reference: "TXN-3" },
  ];

  it("stores the column's value as the External Row Id, and re-uploading the file adds no rows", async () => {
    expect(await uploadCsv(withIds, "job-1")).toMatchObject({ count: 3, duplicateCount: 0 });
    expect((await stored("csv-1")).map((r) => r.externalRowId).sort()).toEqual(["TXN-1", "TXN-2", "TXN-3"]);

    expect(await uploadCsv(withIds, "job-2")).toMatchObject({ count: 0, duplicateCount: 3 });
    expect(await stored("csv-1")).toHaveLength(3);
  });

  it("a later file overlapping the first adds only its new lines, even with the booking text changed", async () => {
    await uploadCsv(withIds, "job-1");

    const res = await uploadCsv(
      [
        { date: "2024-06-04", amount: -1200, name: "SHOP GMBH", reference: "TXN-3" },
        { date: "2024-06-05", amount: -800, name: "Fuel", reference: "TXN-4" },
      ],
      "job-2"
    );

    expect(res).toMatchObject({ count: 1, duplicateCount: 1 });
    expect((await stored("csv-1")).map((r) => r.externalRowId).sort()).toEqual(["TXN-1", "TXN-2", "TXN-3", "TXN-4"]);
  });

  it("without a mapped column, no External Row Id is stored and today's duplicate check applies", async () => {
    const lines: CsvLine[] = [
      { date: "2024-06-03", amount: -450, name: "Cafe", reference: null },
      { date: "2024-06-03", amount: -450, name: "Cafe", reference: null },
    ];

    expect(await uploadCsv(lines, "job-1")).toMatchObject({ count: 2, duplicateCount: 0 });
    expect((await stored("csv-1")).map((r) => r.externalRowId)).toEqual([null, null]);
    expect(await uploadCsv(lines, "job-2")).toMatchObject({ count: 0, duplicateCount: 2 });
  });

  it("a column whose values repeat is no transaction id: every line is kept, without ids", async () => {
    // A mandate reference, or SEPA's NOTPROVIDED, repeats across lines of one file.
    const lines: CsvLine[] = [
      { date: "2024-06-01", amount: -1299, name: "Streaming", reference: "MANDATE-77" },
      { date: "2024-07-01", amount: -1299, name: "Streaming", reference: "MANDATE-77" },
      { date: "2024-07-02", amount: -500, name: "Transfer", reference: "NOTPROVIDED" },
    ];

    expect(await uploadCsv(lines, "job-1")).toMatchObject({ count: 3, duplicateCount: 0 });
    expect((await stored("csv-1")).map((r) => r.externalRowId)).toEqual([null, null, null]);
    expect(await uploadCsv(lines, "job-2")).toMatchObject({ count: 0, duplicateCount: 3 });
  });

  it("a column empty on some lines is no transaction id either: the file carries no ids", async () => {
    const lines: CsvLine[] = [
      { date: "2024-06-01", amount: -100, name: "Card", reference: null },
      { date: "2024-06-02", amount: -200, name: "Transfer", reference: "E2E-1" },
    ];

    expect(await uploadCsv(lines, "job-1")).toMatchObject({ count: 2 });
    expect((await stored("csv-1")).map((r) => r.externalRowId)).toEqual([null, null]);
  });

  it("refuses an External Row Id that is not a string, or longer than 256 characters", async () => {
    const row = csvRows([{ date: "2024-06-03", amount: -450, name: "Cafe", reference: null }], "job-1")[0];
    for (const externalRowId of [42, "x".repeat(257)]) {
      await expect(
        bulkCreateTransactionsCallable.run({
          data: { sourceId: "csv-1", transactions: [{ ...row, externalRowId }] },
          auth: AUTH,
        } as never)
      ).rejects.toThrow(/externalRowId/);
    }
    expect(await stored("csv-1")).toEqual([]);
  });

  /** The rows a remap of job-1 sends for these lines, under a new mapping. */
  function remapRows(lines: CsvLine[], transactionIds: string[]) {
    return csvRows(lines, "job-1").map((r, i) => ({
      transactionId: transactionIds[i],
      date: r.date,
      amount: r.amount,
      name: r.name,
      partner: null,
      reference: r.reference,
      partnerIban: null,
      externalRowId: r.externalRowId,
      original: r._original,
    }));
  }

  async function remap(rows: ReturnType<typeof remapRows>) {
    await db.collection("imports").doc("job-1").set({ userId: USER, sourceId: "csv-1", fieldMappings: [] });
    await applyImportRemapCallable.run({
      data: { importJobId: "job-1", sourceId: "csv-1", fieldMappings: [], rows },
      auth: AUTH,
    } as never);
  }

  it("a remap never writes a new id onto a stored row; a re-upload of the corrected file still adds nothing", async () => {
    const lines: CsvLine[] = [
      { date: "2024-06-03", amount: -450, name: "Cafe", reference: "MANDATE-1" },
      { date: "2024-06-04", amount: -450, name: "Cafe", reference: "MANDATE-1" },
    ];
    const { transactionIds } = await uploadCsv(lines, "job-1");
    const corrected = lines.map((l, i) => ({ ...l, reference: `TXN-${i + 1}` }));

    await remap(remapRows(corrected, transactionIds));

    expect((await stored("csv-1")).map((r) => r.externalRowId)).toEqual([null, null]);
    // Today's duplicate check holds the corrected file's lines back.
    expect(await uploadCsv(corrected, "job-2")).toMatchObject({ count: 0, duplicateCount: 2 });
    expect(await stored("csv-1")).toHaveLength(2);
  });

  it("a remap clears an id the new mapping no longer gives, and keeps one it still gives", async () => {
    const { transactionIds } = await uploadCsv(withIds, "job-1");

    // TXN-1 and TXN-2 stay; the third line's column now reads another value.
    await remap(remapRows([withIds[0], withIds[1], { ...withIds[2], reference: "OTHER-3" }], transactionIds));
    expect((await stored("csv-1")).map((r) => r.externalRowId).sort()).toEqual(["TXN-1", "TXN-2", null].sort());

    // A column that is no id at all clears every id.
    await remap(remapRows(withIds.map((l) => ({ ...l, reference: "NOTPROVIDED" })), transactionIds));
    expect((await stored("csv-1")).map((r) => r.externalRowId)).toEqual([null, null, null]);
  });
});
