/**
 * Fiscal Years (#794, spec #800, ADR-0018): a User's fiscal year start month,
 * Tracked From and Closed Through split time into untracked, closed and open
 * stretches, always in that order.
 *
 * Driven through the MCP tools and the callables (the settings page) against
 * the self-host in-memory database. What is asserted is what the User or a
 * later surface sees: the settings a read returns, the change records, the
 * stored rows, and the refusals with their messages.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";

// REAL application code, unmodified:
import { handleTool } from "../tools/handlers";
import { agentCaller } from "../tools/caller";
import { getFiscalYearsCallable, updateFiscalYearsCallable } from "../fiscalYears/fiscalYearsCallables";
import { viennaToday } from "../utils/storedDay";
import { updateTransactionCallable } from "../transactions/updateTransaction";
import { bulkUpdateTransactionsCallable } from "../transactions/bulkUpdateTransactions";
import { deleteTransactionsBySourceCallable } from "../transactions/deleteTransactionsBySource";
import { deleteSourceCallable } from "../sources/deleteSource";
import { addCashPaymentCallable, deleteCashPaymentCallable } from "../transactions/cashPayment";
import { bulkCreateTransactionsCallable } from "../imports/bulkCreateTransactions";
import { syncBankTransactionsCallable } from "../banking/syncBankTransactions";

const db = getFirestore();
const USER = "fy-user";
const OTHER = "fy-other";
const AUTH = { uid: USER, token: {} };

const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));

type Settings = { startMonth: number; trackedFrom: string; closedThrough: string | null };
type ChangeRecord = {
  id: string;
  changedBy: string;
  changedAt: string;
  via: string;
  previous: Settings;
  next: Settings;
};

async function settingsOf(uid = USER): Promise<Settings> {
  return ((await handleTool(uid, "get_fiscal_years", {})) as { settings: Settings }).settings;
}

function change(args: Record<string, unknown>, uid = USER) {
  return handleTool(uid, "set_fiscal_years", args) as Promise<{ settings: Settings; record: ChangeRecord | null }>;
}

async function storedRecords(uid = USER) {
  const snap = await db.collection("fiscalYearChanges").where("userId", "==", uid).get();
  return snap.docs.map((d) => d.data());
}

async function seedTransaction(id: string, iso: string, uid = USER) {
  await db.collection("transactions").doc(id).set({
    userId: uid,
    sourceId: "src-1",
    date: day(iso),
    amount: -1000,
    currency: "EUR",
    name: "Vendor",
    fileIds: [],
    isComplete: false,
  });
}

const thisYear = viennaToday().toISOString().slice(0, 4);

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
});

describe("the three settings and their defaults", () => {
  it("a new User tracks the current fiscal year from January, with nothing closed", async () => {
    expect(await settingsOf()).toEqual({ startMonth: 1, trackedFrom: `${thisYear}-01`, closedThrough: null });
  });

  it("a User with older data keeps it tracked: Tracked From defaults to its earliest month", async () => {
    await seedTransaction("tx-old", "2023-04-17");

    expect((await settingsOf()).trackedFrom).toBe("2023-04");
  });

  it("another User's data does not move the default", async () => {
    await seedTransaction("tx-old", "2023-04-17", OTHER);

    expect((await settingsOf()).trackedFrom).toBe(`${thisYear}-01`);
  });
});

describe("every change writes one append-only record", () => {
  it("stores the new settings and returns the record it wrote: who, when, old and new value", async () => {
    const before = await settingsOf();

    const { settings, record } = await change({ trackedFrom: "2022-01", closedThrough: "2024-12" });

    expect(settings).toEqual({ startMonth: 1, trackedFrom: "2022-01", closedThrough: "2024-12" });
    expect(await settingsOf()).toEqual(settings);
    expect(record).toMatchObject({
      changedBy: USER,
      via: "mcp",
      previous: before,
      next: settings,
    });
    expect(Number.isNaN(Date.parse(record!.changedAt))).toBe(false);
    expect(await storedRecords()).toHaveLength(1);
  });

  it("one record per change, the earlier ones left as written", async () => {
    await change({ trackedFrom: "2022-01" });
    await change({ closedThrough: "2023-12" });
    await change({ closedThrough: null });

    const records = await storedRecords();
    expect(records).toHaveLength(3);
    expect(records.map((r) => (r.next as Settings).closedThrough).sort()).toEqual(["2023-12", null, null].sort());
  });

  it("a change that changes nothing writes nothing", async () => {
    await change({ trackedFrom: "2022-01" });

    const { record } = await change({ trackedFrom: "2022-01" });

    expect(record).toBeNull();
    expect(await storedRecords()).toHaveLength(1);
  });

  it("the fiscal year start month is one of the three", async () => {
    const { settings, record } = await change({ startMonth: 7 });

    expect(settings.startMonth).toBe(7);
    expect(record!.previous.startMonth).toBe(1);
    expect(record!.next.startMonth).toBe(7);
  });

  it("the chat records itself as the one who changed it", async () => {
    const { record } = (await handleTool(USER, "set_fiscal_years", { closedThrough: `${thisYear}-01` }, agentCaller(null))) as {
      record: ChangeRecord;
    };
    expect(record.via).toBe("chat");
  });

  it("the settings page changes them through its callable, recording itself", async () => {
    const res = (await updateFiscalYearsCallable.run({
      data: { closedThrough: `${thisYear}-02` },
      auth: AUTH,
    } as never)) as { settings: Settings; record: ChangeRecord };

    expect(res.record).toMatchObject({ changedBy: USER, via: "settings" });
    const read = (await getFiscalYearsCallable.run({ data: {}, auth: AUTH } as never)) as { settings: Settings };
    expect(read.settings.closedThrough).toBe(`${thisYear}-02`);
  });

  it("one User's change leaves another User's settings alone", async () => {
    await change({ closedThrough: `${thisYear}-01` });

    expect((await settingsOf(OTHER)).closedThrough).toBeNull();
  });
});

describe("the order untracked, closed, open always holds", () => {
  it("refuses Closed Through before the month ahead of Tracked From (a closed stretch inside untracked time)", async () => {
    await change({ trackedFrom: "2024-01" });

    await expect(change({ closedThrough: "2023-11" })).rejects.toThrow(/Closed Through/);
    expect((await settingsOf()).closedThrough).toBeNull();
  });

  it("allows Closed Through the month before Tracked From: nothing closed yet", async () => {
    await change({ trackedFrom: "2024-01" });

    await expect(change({ closedThrough: "2023-12" })).resolves.toBeTruthy();
  });

  it("refuses Tracked From past the month after Closed Through (a gap between closed and open)", async () => {
    await change({ trackedFrom: "2022-01", closedThrough: "2023-12" });

    await expect(change({ trackedFrom: "2024-02" })).rejects.toThrow(/Tracked From/);
    expect((await settingsOf()).trackedFrom).toBe("2022-01");
  });

  it("refuses values that are not a month, and a start month outside 1-12", async () => {
    await expect(change({ trackedFrom: "2024-13" })).rejects.toThrow(/YYYY-MM/);
    await expect(change({ closedThrough: "2024-01-31" })).rejects.toThrow(/YYYY-MM/);
    await expect(change({ startMonth: 0 })).rejects.toThrow(/startMonth/);
    expect(await storedRecords()).toHaveLength(0);
  });
});

describe("moving Tracked From later", () => {
  it("is refused when the months it would leave behind hold a Transaction", async () => {
    await change({ trackedFrom: "2022-01" });
    await seedTransaction("tx-2022", "2022-06-10");

    await expect(change({ trackedFrom: "2023-01" })).rejects.toThrow(/2022-06/);
    expect((await settingsOf()).trackedFrom).toBe("2022-01");
  });

  it("is refused when those months hold a File", async () => {
    await change({ trackedFrom: "2022-01" });
    await db.collection("files").doc("f-2022").set({ userId: USER, fileName: "a.pdf", extractedDate: day("2022-03-01") });

    await expect(change({ trackedFrom: "2023-01" })).rejects.toThrow(/Tracked From/);
  });

  it("succeeds when they hold nothing, another User's rows included", async () => {
    await change({ trackedFrom: "2022-01" });
    await seedTransaction("tx-other", "2022-06-10", OTHER);
    await seedTransaction("tx-2023", "2023-02-01");

    const { settings } = await change({ trackedFrom: "2023-01" });
    expect(settings.trackedFrom).toBe("2023-01");
  });
});

describe("a Transaction in the Closed stretch is locked", () => {
  const LOCK = /Closed Through is 2024-12.*move Closed Through back/;

  async function closedAccount() {
    await db.collection("sources").doc("src-1").set({ userId: USER, name: "Giro", type: "manual", isActive: true });
    await change({ trackedFrom: "2023-01", closedThrough: "2024-12" });
    await seedTransaction("tx-closed", "2024-12-31");
    await seedTransaction("tx-open", "2025-01-01");
  }

  async function stored(id: string) {
    return (await db.collection("transactions").doc(id).get()).data();
  }

  it("refuses an edit through update_transaction, naming Closed Through and how to lift it", async () => {
    await closedAccount();

    await expect(handleTool(USER, "update_transaction", { transactionId: "tx-closed", description: "x" })).rejects.toThrow(LOCK);
    expect((await stored("tx-closed"))!.description).toBeUndefined();
  });

  it("refuses an edit through the updateTransaction callable", async () => {
    await closedAccount();

    await expect(
      updateTransactionCallable.run({ data: { id: "tx-closed", data: { saleSupplyKind: null } }, auth: AUTH } as never)
    ).rejects.toMatchObject({ code: "failed-precondition", message: expect.stringMatching(LOCK) });
  });

  it("refuses the closed rows of a bulk edit and edits the open ones", async () => {
    await closedAccount();

    const res = (await bulkUpdateTransactionsCallable.run({
      data: { ids: ["tx-closed", "tx-open"], data: { description: "bulk" } },
      auth: AUTH,
    } as never)) as { success: number; failed: number; errors: Array<{ id: string; error: string }> };

    expect(res.success).toBe(1);
    expect(res.errors).toEqual([{ id: "tx-closed", error: expect.stringMatching(LOCK) }]);
    expect((await stored("tx-closed"))!.description).toBeUndefined();
    expect((await stored("tx-open"))!.description).toBe("bulk");
  });

  it("leaves edits of open Transactions alone", async () => {
    await closedAccount();

    await handleTool(USER, "update_transaction", { transactionId: "tx-open", description: "fine" });
    expect((await stored("tx-open"))!.description).toBe("fine");
  });

  it("refuses deleting the Bank Account's contents, and leaves every row", async () => {
    await closedAccount();

    await expect(
      deleteTransactionsBySourceCallable.run({ data: { sourceId: "src-1" }, auth: AUTH } as never)
    ).rejects.toMatchObject({ message: expect.stringMatching(LOCK) });
    await expect(handleTool(USER, "delete_source", { sourceId: "src-1", confirm: true })).rejects.toThrow(LOCK);
    await expect(deleteSourceCallable.run({ data: { sourceId: "src-1" }, auth: AUTH } as never)).rejects.toMatchObject({
      message: expect.stringMatching(LOCK),
    });

    expect(await stored("tx-closed")).toBeDefined();
    expect(await stored("tx-open")).toBeDefined();
    expect((await db.collection("sources").doc("src-1").get()).exists).toBe(true);
  });

  it("refuses deleting a single Cash Payment dated in it", async () => {
    await db.collection("sources").doc("cash-1").set({ userId: USER, name: "Kassa", type: "manual", accountKind: "cash", currency: "EUR", isActive: true });
    const { transactionId } = (await addCashPaymentCallable.run({
      data: { sourceId: "cash-1", date: "2024-06-01", amount: -450, name: "Parkschein" },
      auth: AUTH,
    } as never)) as { transactionId: string };
    await change({ trackedFrom: "2023-01", closedThrough: "2024-12" });

    await expect(deleteCashPaymentCallable.run({ data: { transactionId }, auth: AUTH } as never)).rejects.toMatchObject({
      message: expect.stringMatching(/Closed Through is 2024-12/),
    });
    expect(await stored(transactionId)).toBeDefined();
  });

  it("after Closed Through is moved back, the same edit and delete succeed", async () => {
    await closedAccount();
    await change({ closedThrough: "2024-11" });

    await handleTool(USER, "update_transaction", { transactionId: "tx-closed", description: "fixed" });
    expect((await stored("tx-closed"))!.description).toBe("fixed");

    const res = (await deleteTransactionsBySourceCallable.run({ data: { sourceId: "src-1" }, auth: AUTH } as never)) as {
      deleted: number;
    };
    expect(res.deleted).toBe(2);
  });
});

describe("the Import writer skips Untracked rows and counts them per fiscal year", () => {
  async function account() {
    await db.collection("sources").doc("src-1").set({ userId: USER, name: "Giro", type: "manual", isActive: true });
  }

  async function storedDays() {
    const snap = await db.collection("transactions").where("userId", "==", USER).get();
    return snap.docs.map((d) => (d.data().date as Timestamp).toDate().toISOString().slice(0, 10)).sort();
  }

  const row = (iso: string, i: number) => ({ date: iso, amount: -100 - i, name: `Vendor ${i}`, reference: `ref-${i}` });

  it("import_transactions skips rows before Tracked From and writes the Closed and open ones", async () => {
    await account();
    await change({ trackedFrom: "2023-07", closedThrough: "2023-12" });

    const res = (await handleTool(USER, "import_transactions", {
      sourceId: "src-1",
      transactions: [row("2022-03-01", 1), row("2022-11-30", 2), row("2023-06-30", 3), row("2023-07-01", 4), row("2024-02-02", 5)],
    })) as { count: number; untrackedCount: number; untrackedByFiscalYear: Record<string, number> };

    expect(res.count).toBe(2);
    expect(res.untrackedCount).toBe(3);
    expect(res.untrackedByFiscalYear).toEqual({ "2022": 2, "2023": 1 });
    expect(await storedDays()).toEqual(["2023-07-01", "2024-02-02"]);
    // No setting moves on an Import.
    expect((await settingsOf()).trackedFrom).toBe("2023-07");
  });

  it("names a fiscal year that does not start in January by both its years", async () => {
    await account();
    await change({ startMonth: 7, trackedFrom: "2024-07" });

    const res = (await handleTool(USER, "import_transactions", {
      sourceId: "src-1",
      transactions: [row("2023-06-30", 1), row("2023-07-01", 2), row("2024-06-30", 3)],
    })) as { untrackedByFiscalYear: Record<string, number> };

    expect(res.untrackedByFiscalYear).toEqual({ "2022/23": 1, "2023/24": 2 });
  });

  it("the CSV Import (bulkCreateTransactions) skips and counts the same way", async () => {
    await account();
    await change({ trackedFrom: "2024-01" });

    const res = (await bulkCreateTransactionsCallable.run({
      data: {
        sourceId: "src-1",
        transactions: ["2023-12-31", "2024-01-01"].map((iso, i) => ({
          sourceId: "src-1",
          date: `${iso}T00:00:00.000Z`,
          amount: -100 - i,
          currency: "EUR",
          name: `Vendor ${i}`,
          importJobId: "job-1",
          csvRowIndex: i,
          _original: { date: iso, amount: "-1", rawRow: {} },
        })),
      },
      auth: AUTH,
    } as never)) as { count: number; untrackedCount: number; untrackedByFiscalYear: Record<string, number> };

    expect(res.count).toBe(1);
    expect(res.untrackedCount).toBe(1);
    expect(res.untrackedByFiscalYear).toEqual({ "2023": 1 });
    expect(await storedDays()).toEqual(["2024-01-01"]);
  });

  it("an Import with nothing before Tracked From reports none skipped", async () => {
    await account();
    await change({ trackedFrom: "2024-01" });

    const res = (await handleTool(USER, "import_transactions", { sourceId: "src-1", transactions: [row("2024-05-05", 1)] })) as {
      count: number;
      untrackedCount: number;
      untrackedByFiscalYear: Record<string, number>;
    };
    expect(res).toMatchObject({ count: 1, untrackedCount: 0, untrackedByFiscalYear: {} });
  });
});

describe("a bank sync skips Untracked months without asking", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes the tracked rows, counts the rest per fiscal year, and records them on the Import", async () => {
    process.env.FINAPI_CLIENT_ID = "test-client";
    process.env.FINAPI_CLIENT_SECRET = "test-secret";
    await db.collection("sources").doc("api-1").set({
      userId: USER,
      name: "Bank",
      type: "api",
      isActive: true,
      apiConfig: { provider: "finapi", accountId: "7", userAccessToken: "token" },
    });
    await change({ trackedFrom: "2024-01" });
    const lines = [
      { id: 1, accountId: 7, valueDate: "2023-12-30", bankBookingDate: "2023-12-30", amount: -10, purpose: "Old" },
      { id: 2, accountId: 7, valueDate: "2024-01-02", bankBookingDate: "2024-01-02", amount: -20, purpose: "New" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () =>
          String(url).includes("/transactions")
            ? { transactions: lines, paging: { page: 1, perPage: 500, totalPages: 1, totalCount: 2 } }
            : { balance: 100 },
      }))
    );

    const res = (await syncBankTransactionsCallable.run({
      data: { sourceId: "api-1", fromYear: 2023 },
      auth: AUTH,
    } as never)) as { imported: number; untrackedCount: number; untrackedByFiscalYear: Record<string, number>; importRecordId: string };

    expect(res.imported).toBe(1);
    expect(res.untrackedCount).toBe(1);
    expect(res.untrackedByFiscalYear).toEqual({ "2023": 1 });
    const stored = await db.collection("transactions").where("sourceId", "==", "api-1").get();
    expect(stored.docs.map((d) => d.data().name)).toEqual(["New"]);
    const record = (await db.collection("imports").doc(res.importRecordId).get()).data()!;
    expect(record).toMatchObject({ untrackedCount: 1, untrackedByFiscalYear: { "2023": 1 } });
  });
});
