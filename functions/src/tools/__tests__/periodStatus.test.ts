/**
 * get_period_status and list_pending_matches: the numbers behind the progress board and the match
 * review widget. They must agree with the tools that act (needing-files rule, auto-connect bar).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { store, createMockFirestore } from "../../test/setup";

vi.mock("firebase-admin/firestore", () => {
  class MockTimestamp {
    constructor(private readonly date: Date) {}
    static fromDate(d: Date) {
      return new MockTimestamp(d);
    }
    static now() {
      return new MockTimestamp(new Date());
    }
    toDate() {
      return this.date;
    }
    valueOf() {
      return this.date.getTime();
    }
  }
  return {
    getFirestore: () => createMockFirestore(),
    FieldValue: { serverTimestamp: () => new Date(), increment: (n: number) => n },
    Timestamp: MockTimestamp,
  };
});

const { getPeriodStatus, listPendingMatches, summarizeTransactions, MISSING_LIST_CAP } = await import("../periodStatus");
const { listTransactionsNeedingFiles } = await import("../handlers");

const USER = "user-period";
const day = (s: string) => new Date(`${s}T00:00:00Z`);

function tx(id: string, date: string, extra: Record<string, unknown> = {}) {
  store.setDoc("transactions", id, { userId: USER, date: day(date), amount: -1000, currency: "EUR", name: id, ...extra });
}

beforeEach(() => {
  store.clear();
});

describe("get_period_status", () => {
  it("counts covered, missing and parked per month, newest month first", async () => {
    tx("a", "2026-09-03", { fileIds: ["f1"] });
    tx("b", "2026-09-04", { noReceiptCategoryId: "cat" });
    tx("c", "2026-09-05");
    tx("d", "2026-09-06", { quotaExceeded: true });
    tx("e", "2026-08-02");
    tx("other-user", "2026-09-05", { userId: "someone-else" });
    tx("outside", "2026-05-01");

    const status = await getPeriodStatus(USER, { dateFrom: "2026-08-01", dateTo: "2026-09-30" });

    expect(status.months).toEqual([
      { month: "2026-09", total: 4, covered: 2, missing: 1, parked: 1, coveragePercent: 50 },
      { month: "2026-08", total: 1, covered: 0, missing: 1, parked: 0, coveragePercent: 0 },
    ]);
    expect(status.totals).toEqual({ total: 5, covered: 2, missing: 2, parked: 1, coveragePercent: 40 });
    expect(status.missing.map((m) => m.id)).toEqual(["c", "e"]);
    expect(status.truncated).toBe(false);
  });

  it("agrees with list_transactions_needing_files on what is missing", async () => {
    tx("a", "2026-09-03", { fileIds: ["f1"] });
    tx("b", "2026-09-04", { noReceiptCategoryId: "cat" });
    tx("c", "2026-09-05");
    tx("d", "2026-09-06", { quotaExceeded: true });
    tx("e", "2026-09-07", { fileIds: [] });

    const status = await getPeriodStatus(USER, { dateFrom: "2026-09-01", dateTo: "2026-09-30" });
    const needing = (await listTransactionsNeedingFiles(USER, {})) as { transactions: Array<{ id: string }> };

    expect(status.missing.map((m) => m.id).sort()).toEqual(needing.transactions.map((t) => t.id).sort());
  });

  it("caps the missing list and says so", () => {
    const many = Array.from({ length: MISSING_LIST_CAP + 5 }, (_, i) => ({ id: `t${i}`, date: "2026-09-01" }));
    const summary = summarizeTransactions(many);
    expect(summary.missing).toHaveLength(MISSING_LIST_CAP);
    expect(summary.missingTruncated).toBe(true);
    expect(summary.totals.missing).toBe(MISSING_LIST_CAP + 5);
  });

  it("reports a fully covered empty period as complete, not as 0%", () => {
    expect(summarizeTransactions([]).totals.coveragePercent).toBe(100);
  });

  it("rejects a malformed boundary instead of widening the window", async () => {
    await expect(getPeriodStatus(USER, { dateFrom: "09/2026" })).rejects.toThrow(/dateFrom/);
    await expect(getPeriodStatus(USER, { dateTo: "tomorrow" })).rejects.toThrow(/dateTo/);
  });

  it("counts waiting suggestions at the default bar", async () => {
    store.setDoc("files", "f1", {
      userId: USER,
      transactionMatchComplete: true,
      transactionIds: [],
      transactionSuggestions: [{ transactionId: "t1", confidence: 90 }],
    });
    store.setDoc("files", "f2", {
      userId: USER,
      transactionMatchComplete: true,
      transactionIds: [],
      transactionSuggestions: [{ transactionId: "t1", confidence: 70 }],
    });
    const status = await getPeriodStatus(USER, { dateFrom: "2026-09-01", dateTo: "2026-09-30" });
    expect(status.waitingSuggestions).toEqual({ count: 1, minConfidence: 85 });
  });
});

describe("list_pending_matches", () => {
  const suggestion = (transactionId: string, confidence: number) => ({
    transactionId,
    confidence,
    preview: { date: day("2026-09-10"), amount: -2390, currency: "EUR", name: "REWE 1234", partner: "REWE" },
  });

  beforeEach(() => {
    store.setDoc("files", "best", {
      userId: USER,
      fileName: "rewe.pdf",
      extractedPartner: "REWE",
      extractedAmount: 2390,
      extractedDate: day("2026-09-10"),
      transactionMatchComplete: true,
      transactionIds: [],
      transactionSuggestions: [suggestion("t1", 91), suggestion("t2", 60)],
    });
    store.setDoc("files", "lower", {
      userId: USER,
      fileName: "x.pdf",
      transactionMatchComplete: true,
      transactionIds: [],
      transactionSuggestions: [suggestion("t3", 86)],
    });
    // None of these may be listed.
    store.setDoc("files", "below-bar", { userId: USER, transactionMatchComplete: true, transactionIds: [], transactionSuggestions: [suggestion("t4", 80)] });
    store.setDoc("files", "connected", { userId: USER, transactionMatchComplete: true, transactionIds: ["t5"], transactionSuggestions: [suggestion("t5", 99)] });
    store.setDoc("files", "deleted", { userId: USER, transactionMatchComplete: true, deletedAt: new Date(), transactionIds: [], transactionSuggestions: [suggestion("t6", 99)] });
    store.setDoc("files", "not-invoice", { userId: USER, transactionMatchComplete: true, isNotInvoice: true, transactionIds: [], transactionSuggestions: [suggestion("t7", 99)] });
    store.setDoc("files", "foreign", { userId: "someone-else", transactionMatchComplete: true, transactionIds: [], transactionSuggestions: [suggestion("t8", 99)] });
  });

  it("lists each waiting file once, with its best suggestion, best first", async () => {
    const result = await listPendingMatches(USER, {});
    expect(result.matches.map((m) => [m.fileId, m.transactionId, m.confidence])).toEqual([
      ["best", "t1", 91],
      ["lower", "t3", 86],
    ]);
    expect(result.matches[0]).toMatchObject({
      fileName: "rewe.pdf",
      filePartner: "REWE",
      fileAmount: 2390,
      fileDate: "2026-09-10",
      transactionName: "REWE 1234",
      transactionAmount: -2390,
      transactionDate: "2026-09-10",
    });
    expect(result.total).toBe(2);
  });

  it("honours minConfidence and limit, and reports the total", async () => {
    expect((await listPendingMatches(USER, { minConfidence: 90 })).matches.map((m) => m.fileId)).toEqual(["best"]);
    const limited = await listPendingMatches(USER, { limit: 1 });
    expect(limited.count).toBe(1);
    expect(limited.total).toBe(2);
  });
});

describe("get_profile", () => {
  it("returns a stable opaque id that differs per user and does not contain the user id", async () => {
    const { handleTool } = await import("../handlers");
    const a1 = (await handleTool("user-a-secret-uid", "get_profile", {})) as { profileId: string };
    const a2 = (await handleTool("user-a-secret-uid", "get_profile", {})) as { profileId: string };
    const b = (await handleTool("user-b", "get_profile", {})) as { profileId: string };
    expect(a1.profileId).toBe(a2.profileId);
    expect(a1.profileId).not.toBe(b.profileId);
    expect(a1.profileId).toMatch(/^fbp_[0-9a-f]{32}$/);
    expect(a1.profileId).not.toContain("secret");
  });
});
