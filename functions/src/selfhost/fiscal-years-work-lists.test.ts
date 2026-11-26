/**
 * Fiscal Years keep the Closed stretch out of the work (#802, spec #800,
 * ADR-0018): the "needs a receipt" and missing-invoice lists and the weekly
 * digest leave out records dated outside the open stretch, so importing old
 * years never reads as new work.
 *
 * Driven through the MCP tools and the digest's stats against the self-host
 * in-memory database holding untracked, closed and open records.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";

// REAL application code, unmodified:
import { handleTool } from "../tools/handlers";
import { viennaToday } from "../utils/storedDay";
import { gatherUserStats } from "../digest/sendWeeklyDigest";
import { addMonths, openFrom, stretchOf } from "../fiscalYears/settings";

const db = getFirestore();
const USER = "fy-lists-user";

const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));

const thisYear = Number(viennaToday().toISOString().slice(0, 4));
const lastYear = thisYear - 1;

async function seedTransaction(id: string, iso: string, fields: Record<string, unknown> = {}) {
  await db.collection("transactions").doc(id).set({
    userId: USER,
    sourceId: "src-1",
    date: day(iso),
    amount: -1000,
    currency: "EUR",
    name: "Vendor",
    fileIds: [],
    isComplete: false,
    createdAt: Timestamp.now(),
    ...fields,
  });
}

function setFiscalYears(args: Record<string, unknown>) {
  return handleTool(USER, "set_fiscal_years", args);
}

type Row = { id: string };
const ids = (result: unknown) => (result as { transactions: Row[] }).transactions.map((t) => t.id);

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
});

describe("the open stretch's first month agrees with the one stretch check", () => {
  it("a month is open exactly when it is on or after openFrom", () => {
    const cases = [
      { startMonth: 1, trackedFrom: "2024-01", closedThrough: null },
      { startMonth: 1, trackedFrom: "2024-01", closedThrough: "2024-12" },
      { startMonth: 7, trackedFrom: "2023-07", closedThrough: "2025-03" },
      // Closed Through the month before Tracked From: nothing closed yet.
      { startMonth: 1, trackedFrom: "2025-01", closedThrough: "2024-12" },
    ];
    for (const settings of cases) {
      for (let i = -18; i <= 18; i++) {
        const month = addMonths("2025-01", i);
        expect(stretchOf(settings, `${month}-15`) === "open", `${month} ${JSON.stringify(settings)}`).toBe(
          month >= openFrom(settings)
        );
      }
    }
  });
});

describe("list_transactions_needing_files", () => {
  beforeEach(async () => {
    await seedTransaction("tx-closed-old", `${lastYear - 1}-05-10`);
    await seedTransaction("tx-closed", `${lastYear}-11-20`);
    await seedTransaction("tx-open-1", `${thisYear}-01-05`);
    await seedTransaction("tx-open-2", `${thisYear}-01-20`);
  });

  it("omits Transactions dated in the Closed stretch and lists the open ones newest first", async () => {
    await setFiscalYears({ trackedFrom: `${lastYear - 1}-01`, closedThrough: `${lastYear}-12` });

    expect(ids(await handleTool(USER, "list_transactions_needing_files", {}))).toEqual(["tx-open-2", "tx-open-1"]);
  });

  it("a Closed year does not fill the pages: the last open row ends the list", async () => {
    await setFiscalYears({ trackedFrom: `${lastYear - 1}-01`, closedThrough: `${lastYear}-12` });

    const first = (await handleTool(USER, "list_transactions_needing_files", { limit: 1 })) as {
      transactions: Row[];
      nextCursor: string | null;
    };
    expect(ids(first)).toEqual(["tx-open-2"]);
    const second = (await handleTool(USER, "list_transactions_needing_files", {
      limit: 1,
      cursor: first.nextCursor,
    })) as { transactions: Row[]; nextCursor: string | null };
    expect(ids(second)).toEqual(["tx-open-1"]);
    expect(second.nextCursor).toBeNull();
  });

  it("closing through the middle of a year keeps its later months listed", async () => {
    await setFiscalYears({ trackedFrom: `${lastYear - 1}-01`, closedThrough: `${lastYear}-10` });

    expect(ids(await handleTool(USER, "list_transactions_needing_files", {}))).toEqual([
      "tx-open-2",
      "tx-open-1",
      "tx-closed",
    ]);
  });

  it("with Closed Through none, lists every tracked Transaction as before", async () => {
    await setFiscalYears({ closedThrough: null });

    expect(ids(await handleTool(USER, "list_transactions_needing_files", {}))).toEqual([
      "tx-open-2",
      "tx-open-1",
      "tx-closed",
      "tx-closed-old",
    ]);
  });

  it("after Closed Through is moved back, the reopened year is listed again", async () => {
    await setFiscalYears({ trackedFrom: `${lastYear - 1}-01`, closedThrough: `${lastYear}-12` });
    await setFiscalYears({ closedThrough: `${lastYear - 1}-12` });

    expect(ids(await handleTool(USER, "list_transactions_needing_files", {}))).toEqual([
      "tx-open-2",
      "tx-open-1",
      "tx-closed",
    ]);
  });
});

describe("a Transaction dated before Tracked From (Untracked) is not work either", () => {
  it("is left out of the list with nothing closed", async () => {
    await seedTransaction("tx-open", `${thisYear}-01-05`);
    // The default tracks the current fiscal year; a row written before it
    // bypassed the Import's skip.
    await handleTool(USER, "get_fiscal_years", {});
    await seedTransaction("tx-untracked", `${lastYear}-06-01`);

    expect(ids(await handleTool(USER, "list_transactions_needing_files", {}))).toEqual(["tx-open"]);
  });
});

describe("list_transactions_missing_invoice", () => {
  beforeEach(async () => {
    await db.collection("files").doc("f-receipt").set({
      userId: USER,
      fileName: "receipt.pdf",
      documentType: "receipt",
      documentTypeMissingElements: ["recipient"],
    });
    const receiptOnly = { fileIds: ["f-receipt"], documentationState: "receipt-only" };
    await seedTransaction("tx-closed", `${lastYear}-03-02`, receiptOnly);
    await seedTransaction("tx-open-1", `${thisYear}-01-03`, receiptOnly);
    await seedTransaction("tx-open-2", `${thisYear}-01-09`, receiptOnly);
  });

  it("omits Transactions dated in the Closed stretch and lists the open ones newest first", async () => {
    await setFiscalYears({ trackedFrom: `${lastYear}-01`, closedThrough: `${lastYear}-12` });

    const result = await handleTool(USER, "list_transactions_missing_invoice", {});
    expect(ids(result)).toEqual(["tx-open-2", "tx-open-1"]);
    expect((result as { count: number }).count).toBe(2);
  });

  it("with Closed Through none, lists them all as before", async () => {
    expect(ids(await handleTool(USER, "list_transactions_missing_invoice", {}))).toEqual([
      "tx-open-2",
      "tx-open-1",
      "tx-closed",
    ]);
  });
});

describe("list_pending_matches", () => {
  async function seedPendingFile(id: string, iso: string) {
    await db.collection("files").doc(id).set({
      userId: USER,
      fileName: `${id}.pdf`,
      extractionComplete: true,
      transactionMatchComplete: true,
      extractedDate: day(iso),
      transactionIds: [],
      transactionSuggestions: [{ transactionId: "tx-open-1", confidence: 90, matchSources: ["amount"] }],
    });
  }

  beforeEach(async () => {
    await seedTransaction("tx-open-1", `${thisYear}-01-05`);
    await seedPendingFile("f-closed", `${lastYear}-12-30`);
    await seedPendingFile("f-open", `${thisYear}-01-04`);
  });

  it("lists only Files dated in the open stretch: a Closed File is no work, like one before Tracked From", async () => {
    await setFiscalYears({ trackedFrom: `${lastYear - 1}-01`, closedThrough: `${lastYear}-12` });
    await seedPendingFile("f-untracked", `${lastYear - 2}-06-01`);

    const result = (await handleTool(USER, "list_pending_matches", {})) as { matches: Array<{ fileId: string }> };
    expect(result.matches.map((m) => m.fileId)).toEqual(["f-open"]);
  });

  it("with Closed Through none, lists every tracked File as before", async () => {
    await setFiscalYears({ trackedFrom: `${lastYear - 1}-01` });
    await seedPendingFile("f-untracked", `${lastYear - 2}-06-01`);

    const result = (await handleTool(USER, "list_pending_matches", {})) as { matches: Array<{ fileId: string }> };
    expect(result.matches.map((m) => m.fileId).sort()).toEqual(["f-closed", "f-open"]);
  });
});

describe("the weekly digest", () => {
  const weekAgo = () => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const stats = () => gatherUserStats(db as unknown as FirebaseFirestore.Firestore, USER, weekAgo());
  const monthAgo = Timestamp.fromDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));

  async function seedFile(id: string, extractedDate: string | null) {
    await db.collection("files").doc(id).set({
      userId: USER,
      fileName: `${id}.pdf`,
      createdAt: Timestamp.now(),
      ...(extractedDate ? { extractedDate: day(extractedDate) } : {}),
    });
  }

  beforeEach(async () => {
    // Imported this week into a closed year: no receipt, not complete.
    await seedTransaction("tx-closed-1", `${lastYear}-04-01`);
    await seedTransaction("tx-closed-2", `${lastYear}-09-15`);
    // Open: one new and done, one new and missing its receipt, one older and done.
    await seedTransaction("tx-open-done", `${thisYear}-01-10`, { fileIds: ["f-open"], isComplete: true });
    await seedTransaction("tx-open-missing", `${thisYear}-01-12`);
    await seedTransaction("tx-open-older", `${thisYear}-01-02`, {
      noReceiptCategoryId: "cat-1",
      isComplete: true,
      createdAt: monthAgo,
    });
    await seedFile("f-closed", `${lastYear}-09-15`);
    await seedFile("f-open", `${thisYear}-01-10`);
    await seedFile("f-not-yet-read", null);
  });

  it("leaves records dated in the Closed stretch out of the new counts and the completion rate", async () => {
    await setFiscalYears({ trackedFrom: `${lastYear}-01`, closedThrough: `${lastYear}-12` });

    expect(await stats()).toEqual({
      newTransactions: 2,
      unmatchedTransactions: 1,
      completionRate: 67,
      newFiles: 2,
    });
  });

  it("with Closed Through none, counts every record as before", async () => {
    expect(await stats()).toEqual({
      newTransactions: 4,
      unmatchedTransactions: 3,
      completionRate: 40,
      newFiles: 3,
    });
  });

  it("a week that only imported a closed year has no new work", async () => {
    await setFiscalYears({ trackedFrom: `${lastYear}-01`, closedThrough: `${lastYear}-12` });
    for (const id of ["tx-open-done", "tx-open-missing"]) {
      await db.collection("transactions").doc(id).update({ createdAt: monthAgo });
    }

    expect((await stats()).newTransactions).toBe(0);
  });

  it("a File dated before Tracked From is not new work either", async () => {
    await setFiscalYears({ trackedFrom: `${lastYear}-01`, closedThrough: `${lastYear}-12` });
    await seedFile("f-untracked", `${lastYear - 3}-02-01`);

    expect((await stats()).newFiles).toBe(2);
  });
});

describe("viewing and searching a Closed year are unchanged", () => {
  it("list_transactions still returns closed Transactions", async () => {
    await seedTransaction("tx-closed", `${lastYear}-11-20`);
    await seedTransaction("tx-open", `${thisYear}-01-05`);
    await setFiscalYears({ trackedFrom: `${lastYear}-01`, closedThrough: `${lastYear}-12` });

    const listed = ids(await handleTool(USER, "list_transactions", {}));
    expect(listed).toContain("tx-closed");
    expect(listed).toContain("tx-open");
  });
});
