/**
 * Tool Registry Handler Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  store,
  createMockFirestore,
  createTestTransaction,
  createTestFile,
  createTestPartner,
  createTestSource,
} from "../../test/setup";

// Mock firebase-admin/firestore
vi.mock("firebase-admin/firestore", () => {
  // Minimal Timestamp stand-in. The mock in-memory store compares values via
  // toDate()/getTime(), so we only need fromDate/toDate/now.
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
    FieldValue: {
      serverTimestamp: () => new Date(),
      arrayUnion: (...elements: unknown[]) => ({ elements, constructor: { name: "ArrayUnionTransform" } }),
      arrayRemove: (...elements: unknown[]) => ({ elements, constructor: { name: "ArrayRemoveTransform" } }),
      increment: (n: number) => n,
      delete: () => ({ constructor: { name: "DeleteTransform" } }),
    },
    Timestamp: MockTimestamp,
  };
});

// retry_file_extraction is the one tool that spends an AI call; the model
// boundary and the secret are mocked, the eligibility rule and the writes are
// the real ones.
const extraction = vi.hoisted(() => ({ runExtraction: vi.fn() }));

vi.mock("../../extraction/extractionCore", () => ({
  runExtraction: (...args: unknown[]) => extraction.runExtraction(...args),
}));

vi.mock("firebase-functions/params", () => ({
  defineSecret: (name: string) => ({ value: () => `test-${name}` }),
}));

// Import handlers after mocking
const handlers = await import("../handlers");

describe("Tool Registry Handlers", () => {
  const userId = "test-user-123";
  const otherUserId = "other-user-456";

  beforeEach(() => {
    store.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // Sources
  // ==========================================================================

  describe("listSources", () => {
    it("should return all active sources for user", async () => {
      store.setDoc("sources", "src-1", createTestSource({ userId, name: "Bank A", isActive: true }));
      store.setDoc("sources", "src-2", createTestSource({ userId, name: "Bank B", isActive: true }));
      store.setDoc("sources", "src-3", createTestSource({ userId, name: "Inactive", isActive: false }));
      store.setDoc("sources", "src-4", createTestSource({ userId: otherUserId, name: "Other User", isActive: true }));

      const result = await handlers.listSources(userId);

      expect(result).toHaveLength(2);
      expect(result.map((s: { name: string }) => s.name)).toContain("Bank A");
      expect(result.map((s: { name: string }) => s.name)).toContain("Bank B");
    });

    it("should return empty array when no sources exist", async () => {
      const result = await handlers.listSources(userId);
      expect(result).toEqual([]);
    });
  });

  describe("getSource", () => {
    it("should return source by ID", async () => {
      store.setDoc("sources", "src-1", createTestSource({ userId, name: "My Bank" }));

      const result = await handlers.getSource(userId, "src-1");

      expect(result.id).toBe("src-1");
      expect(result.name).toBe("My Bank");
    });

    it("should throw error for non-existent source", async () => {
      await expect(handlers.getSource(userId, "non-existent")).rejects.toThrow("Source not found");
    });

    it("should throw error for source owned by another user", async () => {
      store.setDoc("sources", "src-1", createTestSource({ userId: otherUserId }));

      await expect(handlers.getSource(userId, "src-1")).rejects.toThrow("Source not found");
    });

    it("should throw error when sourceId is missing", async () => {
      await expect(handlers.getSource(userId, "")).rejects.toThrow("sourceId is required");
    });
  });

  // ==========================================================================
  // Transactions
  // ==========================================================================

  describe("listTransactions", () => {
    it("should return transactions for user", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, name: "Purchase 1" }));
      store.setDoc("transactions", "tx-2", createTestTransaction({ userId, name: "Purchase 2" }));
      store.setDoc("transactions", "tx-3", createTestTransaction({ userId: otherUserId }));

      const result = await handlers.listTransactions(userId, {});

      expect(result.transactions).toHaveLength(2);
    });

    it("should filter by isComplete", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, isComplete: true }));
      store.setDoc("transactions", "tx-2", createTestTransaction({ userId, isComplete: false }));

      const complete = await handlers.listTransactions(userId, { isComplete: true });
      const incomplete = await handlers.listTransactions(userId, { isComplete: false });

      expect(complete.transactions).toHaveLength(1);
      expect(incomplete.transactions).toHaveLength(1);
    });

    it("should filter by sourceId", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, sourceId: "src-a" }));
      store.setDoc("transactions", "tx-2", createTestTransaction({ userId, sourceId: "src-b" }));

      const result = await handlers.listTransactions(userId, { sourceId: "src-a" });

      expect(result.transactions).toHaveLength(1);
    });

    it("should filter by search term", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, name: "Amazon Purchase" }));
      store.setDoc("transactions", "tx-2", createTestTransaction({ userId, name: "Netflix" }));

      const result = await handlers.listTransactions(userId, { search: "amazon" });

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].name).toBe("Amazon Purchase");
    });

    it("should include formatted amount", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, amount: -2500, currency: "EUR" }));

      const result = await handlers.listTransactions(userId, {});

      expect(result.transactions[0].amountFormatted).toBe("-25.00 EUR");
    });
  });

  describe("listTransactions - date window (fork #65)", () => {
    // Dates are stored as UTC midnight of the Vienna calendar day, so the
    // window is a pure-UTC comparison. Rows written by the bank sync paths
    // (finapi/banking) carry the booking timestamp as-is rather than a
    // normalised midnight, which is where a Vienna-offset boundary misfiles
    // them by a whole period.
    const seedQuarterEdges = () => {
      store.setDoc("transactions", "q1-last-midnight", createTestTransaction({
        userId, name: "Q1 last day", date: new Date("2026-03-31T00:00:00Z"),
      }));
      store.setDoc("transactions", "q1-last-late", createTestTransaction({
        userId, name: "Q1 last day late", date: new Date("2026-03-31T23:30:00Z"),
      }));
      store.setDoc("transactions", "q2-first", createTestTransaction({
        userId, name: "Q2 first day", date: new Date("2026-04-01T00:00:00Z"),
      }));
      store.setDoc("transactions", "q2-mid", createTestTransaction({
        userId, name: "Q2 middle", date: new Date("2026-05-15T00:00:00Z"),
      }));
      store.setDoc("transactions", "q2-last-late", createTestTransaction({
        userId, name: "Q2 last day late", date: new Date("2026-06-30T23:30:00Z"),
      }));
      store.setDoc("transactions", "q3-first", createTestTransaction({
        userId, name: "Q3 first day", date: new Date("2026-07-01T00:00:00Z"),
      }));
    };

    const names = (result: { transactions: { name?: unknown }[] }) =>
      result.transactions.map((t) => t.name).sort();

    it("returns exactly the quarter, both edges included", async () => {
      seedQuarterEdges();

      const result = await handlers.listTransactions(userId, {
        dateFrom: "2026-04-01",
        dateTo: "2026-06-30",
      });

      expect(names(result)).toEqual([
        "Q2 first day",
        "Q2 last day late",
        "Q2 middle",
      ]);
    });

    it("does not pull in the last hours of the previous period", async () => {
      seedQuarterEdges();

      const result = await handlers.listTransactions(userId, { dateFrom: "2026-04-01" });

      expect(names(result)).not.toContain("Q1 last day late");
      expect(names(result)).not.toContain("Q1 last day");
    });

    it("does not drop the last hours of the end day", async () => {
      seedQuarterEdges();

      const result = await handlers.listTransactions(userId, { dateTo: "2026-06-30" });

      expect(names(result)).toContain("Q2 last day late");
      expect(names(result)).not.toContain("Q3 first day");
    });

    it("holds in summer, when Vienna is +02:00 rather than +01:00", async () => {
      store.setDoc("transactions", "jul-1", createTestTransaction({
        userId, name: "July first", date: new Date("2026-07-01T00:00:00Z"),
      }));
      store.setDoc("transactions", "jun-30-late", createTestTransaction({
        userId, name: "June last late", date: new Date("2026-06-30T23:30:00Z"),
      }));

      const result = await handlers.listTransactions(userId, {
        dateFrom: "2026-07-01",
        dateTo: "2026-09-30",
      });

      expect(names(result)).toEqual(["July first"]);
    });

    it("rejects a malformed boundary instead of silently widening the window", async () => {
      seedQuarterEdges();

      // Dropping the filter would answer with the newest transactions of all
      // time, which reads as "the period holds nothing older".
      await expect(
        handlers.listTransactions(userId, { dateFrom: "01/04/2026", dateTo: "2026-06-30" })
      ).rejects.toThrow("dateFrom must be a calendar day");

      await expect(
        handlers.listTransactions(userId, { dateTo: "30.06.2026" })
      ).rejects.toThrow("dateTo must be a calendar day");

      await expect(
        handlers.listTransactions(userId, { dateFrom: "2026-02-30" })
      ).rejects.toThrow("dateFrom must be a calendar day");
    });

    it("reports each row under the day the window selected it by", async () => {
      // The returned `date` and the filter have to read the timestamp the same
      // way, or a June query answers with a row labelled July.
      seedQuarterEdges();

      const result = await handlers.listTransactions(userId, {
        dateFrom: "2026-04-01",
        dateTo: "2026-06-30",
      });
      const lateRow = result.transactions.find((t) => t.name === "Q2 last day late");

      expect(lateRow?.date).toBe("2026-06-30");
    });
  });

  describe("getTransaction", () => {
    it("should return transaction by ID", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, name: "Test TX" }));

      const result = await handlers.getTransaction(userId, "tx-1");

      expect(result.id).toBe("tx-1");
      expect(result.name).toBe("Test TX");
    });

    it("should throw error for non-existent transaction", async () => {
      await expect(handlers.getTransaction(userId, "non-existent")).rejects.toThrow("Transaction not found");
    });

    it("should throw error for transaction owned by another user", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId: otherUserId }));

      await expect(handlers.getTransaction(userId, "tx-1")).rejects.toThrow("Transaction not found");
    });
  });

  describe("updateTransaction", () => {
    it("should update transaction description", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId }));

      const result = await handlers.updateTransaction(userId, {
        transactionId: "tx-1",
        description: "Updated description",
      });

      expect(result.success).toBe(true);
      const updated = store.getDoc("transactions", "tx-1");
      expect(updated?.description).toBe("Updated description");
    });

    it("should update isComplete status", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, isComplete: false }));

      await handlers.updateTransaction(userId, {
        transactionId: "tx-1",
        isComplete: true,
      });

      const updated = store.getDoc("transactions", "tx-1");
      expect(updated?.isComplete).toBe(true);
    });

    it("should throw error for non-existent transaction", async () => {
      await expect(
        handlers.updateTransaction(userId, { transactionId: "non-existent", description: "test" })
      ).rejects.toThrow("Transaction not found");
    });

    // #215: marking complete must re-derive documentationState — this writer
    // changes neither fileIds nor the category, so the trigger guard never
    // fires and a stale/unset state would stay that way forever.
    it("derives documentationState when marking a bare line complete", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, isComplete: false }));

      await handlers.updateTransaction(userId, { transactionId: "tx-1", isComplete: true });

      const updated = store.getDoc("transactions", "tx-1");
      expect(updated?.isComplete).toBe(true);
      expect(updated?.documentationState).toBe("undocumented");
    });

    it("derives documentationState from attached files when setting isComplete", async () => {
      store.setDoc("files", "file-1", createTestFile({ userId, documentType: "invoice" }));
      store.setDoc(
        "transactions",
        "tx-1",
        createTestTransaction({ userId, fileIds: ["file-1"], isComplete: false })
      );

      await handlers.updateTransaction(userId, { transactionId: "tx-1", isComplete: true });

      const updated = store.getDoc("transactions", "tx-1");
      expect(updated?.documentationState).toBe("invoice");
    });

    it("leaves documentationState alone on a description-only update", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId }));

      await handlers.updateTransaction(userId, { transactionId: "tx-1", description: "note" });

      const updated = store.getDoc("transactions", "tx-1");
      expect(updated?.documentationState).toBeUndefined();
    });
  });

  describe("listTransactionsNeedingFiles", () => {
    it("should return transactions without files or categories", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, fileIds: [], noReceiptCategoryId: null }));
      store.setDoc("transactions", "tx-2", createTestTransaction({ userId, fileIds: ["file-1"] }));
      store.setDoc("transactions", "tx-3", createTestTransaction({ userId, fileIds: [], noReceiptCategoryId: "cat-1" }));

      const result = await handlers.listTransactionsNeedingFiles(userId, {});

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].id).toBe("tx-1");
      expect(result.count).toBe(1);
      expect(result.nextCursor).toBeNull();
    });

    it("should filter by minAmount", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, amount: -5000, fileIds: [] }));
      store.setDoc("transactions", "tx-2", createTestTransaction({ userId, amount: -500, fileIds: [] }));

      const result = await handlers.listTransactionsNeedingFiles(userId, { minAmount: 1000 });

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].id).toBe("tx-1");
    });

    it("should exclude transactions parked on a quota-exceeded flag", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, fileIds: [] }));
      store.setDoc("transactions", "tx-2", createTestTransaction({ userId, fileIds: [], quotaExceeded: true }));

      const result = await handlers.listTransactionsNeedingFiles(userId, {});

      expect(result.count).toBe(1);
      expect(result.transactions[0].id).toBe("tx-1");
    });
  });

  describe("listTransactionsMissingInvoice", () => {
    it("returns only the receipt-only lines, not the ones holding an invoice", async () => {
      store.setDoc("files", "file-receipt", createTestFile({ userId, documentType: "receipt" }));
      store.setDoc("files", "file-invoice", createTestFile({ userId, documentType: "invoice" }));
      store.setDoc(
        "transactions",
        "tx-gap",
        createTestTransaction({ userId, fileIds: ["file-receipt"], isComplete: true, documentationState: "receipt-only" })
      );
      store.setDoc(
        "transactions",
        "tx-fine",
        createTestTransaction({ userId, fileIds: ["file-invoice"], isComplete: true, documentationState: "invoice" })
      );
      store.setDoc("transactions", "tx-empty", createTestTransaction({ userId, documentationState: "undocumented" }));

      const result = await handlers.listTransactionsMissingInvoice(userId, {});

      expect(result.transactions.map((t) => t.id)).toEqual(["tx-gap"]);
      expect(result.count).toBe(1);
      expect(result.nextCursor).toBeNull();
    });

    it("carries the vendor, the amount and the date so the queue can be prioritised", async () => {
      store.setDoc("files", "file-receipt", createTestFile({ userId, documentType: "receipt" }));
      store.setDoc(
        "transactions",
        "tx-gap",
        createTestTransaction({
          userId,
          amount: -12000,
          partner: "Amazon EU S.à r.l.",
          fileIds: ["file-receipt"],
          documentationState: "receipt-only",
        })
      );

      const [row] = (await handlers.listTransactionsMissingInvoice(userId, {})).transactions;

      expect(row.partner).toBe("Amazon EU S.à r.l.");
      expect(row.amount).toBe(-12000);
      expect(row.date).toBe("2024-01-15");
    });

    it("names the § 11 elements the attached document is missing", async () => {
      store.setDoc(
        "files",
        "file-receipt",
        createTestFile({
          userId,
          documentType: "receipt",
          documentTypeMissingElements: ["steuersatz", "supplier-vat-id"],
          documentTypeBasis: { reason: "no-vat-no-invoice-identity" },
        })
      );
      store.setDoc(
        "transactions",
        "tx-gap",
        createTestTransaction({ userId, fileIds: ["file-receipt"], documentationState: "receipt-only" })
      );

      const [row] = (await handlers.listTransactionsMissingInvoice(userId, {})).transactions;

      expect(row.missingElements).toEqual(["steuersatz", "supplier-vat-id"]);
      expect(row.documents[0].basisReason).toBe("no-vat-no-invoice-identity");
    });

    it("survives a dangling file reference rather than failing the whole page", async () => {
      store.setDoc(
        "transactions",
        "tx-gap",
        createTestTransaction({ userId, fileIds: ["file-gone"], documentationState: "receipt-only" })
      );

      const [row] = (await handlers.listTransactionsMissingInvoice(userId, {})).transactions;

      expect(row.documents).toEqual([]);
      expect(row.missingElements).toEqual([]);
    });

    it("filters by minAmount on the absolute value, since expenses are negative", async () => {
      store.setDoc(
        "transactions",
        "tx-big",
        createTestTransaction({ userId, amount: -50000, documentationState: "receipt-only" })
      );
      store.setDoc(
        "transactions",
        "tx-small",
        createTestTransaction({ userId, amount: -500, documentationState: "receipt-only" })
      );

      const result = await handlers.listTransactionsMissingInvoice(userId, { minAmount: 1000 });

      expect(result.transactions.map((t) => t.id)).toEqual(["tx-big"]);
    });

    it("never returns another user's transactions", async () => {
      store.setDoc(
        "transactions",
        "tx-theirs",
        createTestTransaction({ userId: otherUserId, documentationState: "receipt-only" })
      );

      const result = await handlers.listTransactionsMissingInvoice(userId, {});

      expect(result.transactions).toEqual([]);
    });

    it("pages the whole queue when the receipt-only rows are sparse in the scan", async () => {
      // 60 transactions, every fifth one a receipt-only gap. With limit 3 the
      // scan window (3 * 5 = 15 rows) holds exactly 3 matches, so the cursor
      // has to resume from the last row CONSUMED, not the last one returned —
      // the case a copied pagination block gets wrong.
      for (let i = 0; i < 60; i++) {
        store.setDoc(
          "transactions",
          `tx-${String(i).padStart(3, "0")}`,
          createTestTransaction({
            userId,
            date: new Date(Date.UTC(2026, 0, 1) + (60 - i) * 60_000),
            documentationState: i % 5 === 0 ? "receipt-only" : "invoice",
          })
        );
      }

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 40; guard++) {
        const page: Awaited<ReturnType<typeof handlers.listTransactionsMissingInvoice>> =
          await handlers.listTransactionsMissingInvoice(userId, {
            limit: 3,
            ...(cursor ? { cursor } : {}),
          });
        seen.push(...page.transactions.map((t) => t.id as string));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }

      expect(seen).toHaveLength(12);
      expect(new Set(seen).size).toBe(12);
      expect(seen.every((id) => Number(id.slice(3)) % 5 === 0)).toBe(true);
    });

    it("is reachable through the dispatcher under its tool name", async () => {
      store.setDoc(
        "transactions",
        "tx-gap",
        createTestTransaction({ userId, documentationState: "receipt-only" })
      );

      const result = (await handlers.handleTool(userId, "list_transactions_missing_invoice", {})) as {
        count: number;
      };

      expect(result.count).toBe(1);
    });
  });

  describe("listTransactionsNeedingFiles - paging and the limit", () => {
    // Seed n transactions, newest first by date so page order is deterministic.
    const seedTransactions = (n: number, overridesFor: (i: number) => Record<string, unknown> = () => ({})) => {
      for (let i = 0; i < n; i++) {
        store.setDoc(
          "transactions",
          `tx-${String(i).padStart(3, "0")}`,
          createTestTransaction({
            userId,
            fileIds: [],
            date: new Date(Date.UTC(2026, 0, 1) + (n - i) * 60_000),
            ...overridesFor(i),
          })
        );
      }
    };

    it("honours a limit above 100 instead of silently clamping to it", async () => {
      seedTransactions(120);

      const result = await handlers.listTransactionsNeedingFiles(userId, { limit: 200 });

      expect(result.count).toBe(120);
      expect(result.transactions).toHaveLength(120);
    });

    it("caps the page at 500 for an absurd limit, and says there is more", async () => {
      seedTransactions(600);

      const result = await handlers.listTransactionsNeedingFiles(userId, { limit: 10_000 });

      expect(result.count).toBe(500);
      expect(result.nextCursor).not.toBeNull();
    });

    it("reaches transactions past the old 500-document scan", async () => {
      // The pre-fix handler read exactly 500 documents and filtered inside
      // them, so anything older than the newest 500 was unreachable through
      // the tool no matter what limit was passed.
      seedTransactions(700);

      const seen = new Set<string>();
      let cursor: string | null | undefined = undefined;
      let guard = 0;

      do {
        const page: Awaited<ReturnType<typeof handlers.listTransactionsNeedingFiles>> =
          await handlers.listTransactionsNeedingFiles(userId, { limit: 200, ...(cursor ? { cursor } : {}) });
        page.transactions.forEach((t) => seen.add(t.id as string));
        cursor = page.nextCursor;
      } while (cursor && ++guard < 20);

      expect(seen.size).toBe(700);
      expect(seen.has("tx-699")).toBe(true);
    });

    it("fills the page past already-matched rows instead of letting them consume slots", async () => {
      // The 60 newest already have receipts, the ones needing files sit behind
      // them. The pre-fix handler filtered after the cap, so a small limit
      // could come back empty while work remained.
      seedTransactions(120, (i) => (i < 60 ? { fileIds: ["file-1"] } : {}));

      const result = await handlers.listTransactionsNeedingFiles(userId, { limit: 20 });

      expect(result.count).toBe(20);
      expect(result.transactions.every((t) => ((t.fileIds as string[]) || []).length === 0)).toBe(true);
    });

    it("pages to exhaustion via nextCursor, no duplicates, no gaps", async () => {
      seedTransactions(25);

      const seen: string[] = [];
      let cursor: string | null | undefined = undefined;
      let guard = 0;

      do {
        const page: Awaited<ReturnType<typeof handlers.listTransactionsNeedingFiles>> =
          await handlers.listTransactionsNeedingFiles(userId, { limit: 7, ...(cursor ? { cursor } : {}) });
        seen.push(...page.transactions.map((t) => t.id as string));
        cursor = page.nextCursor;
      } while (cursor && ++guard < 20);

      expect(seen).toHaveLength(25);
      expect(new Set(seen).size).toBe(25);
    });

    it("keeps paging when a whole scan window is filtered away", async () => {
      // 60 matched rows in front of 5 unmatched ones, page size 5 -> scan
      // window 25, so the first two pages are empty but must still hand back
      // a cursor.
      seedTransactions(65, (i) => (i < 60 ? { fileIds: ["file-1"] } : {}));

      const seen: string[] = [];
      let cursor: string | null | undefined = undefined;
      let guard = 0;

      do {
        const page: Awaited<ReturnType<typeof handlers.listTransactionsNeedingFiles>> =
          await handlers.listTransactionsNeedingFiles(userId, { limit: 5, ...(cursor ? { cursor } : {}) });
        seen.push(...page.transactions.map((t) => t.id as string));
        cursor = page.nextCursor;
      } while (cursor && ++guard < 30);

      expect(seen).toHaveLength(5);
    });

    it("ignores a cursor belonging to another user", async () => {
      seedTransactions(3);
      store.setDoc("transactions", "tx-other", createTestTransaction({ userId: otherUserId }));

      const result = await handlers.listTransactionsNeedingFiles(userId, { cursor: "tx-other" });

      expect(result.count).toBe(3);
    });
  });

  // ==========================================================================
  // Files
  // ==========================================================================

  describe("listFiles", () => {
    it("should return files for user", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId }));
      store.setDoc("files", "f-2", createTestFile({ userId }));
      store.setDoc("files", "f-3", createTestFile({ userId: otherUserId }));

      const result = await handlers.listFiles(userId, {});

      expect(result.files).toHaveLength(2);
      expect(result.count).toBe(2);
      expect(result.nextCursor).toBeNull();
    });

    it("should exclude deleted files", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId }));
      store.setDoc("files", "f-2", createTestFile({ userId, deletedAt: new Date() }));

      const result = await handlers.listFiles(userId, {});

      expect(result.files).toHaveLength(1);
    });

    it("should filter by hasConnections", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, transactionIds: ["tx-1"] }));
      store.setDoc("files", "f-2", createTestFile({ userId, transactionIds: [] }));

      const connected = await handlers.listFiles(userId, { hasConnections: true });
      const unconnected = await handlers.listFiles(userId, { hasConnections: false });

      expect(connected.files).toHaveLength(1);
      expect(unconnected.files).toHaveLength(1);
    });

    it("filters to the hand-corrected population, and away from it", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({ userId, extractionCorrectedFields: { vatPercent: new Date() } })
      );
      store.setDoc("files", "f-2", createTestFile({ userId }));

      const corrected = await handlers.listFiles(userId, { handCorrected: true });
      const untouched = await handlers.listFiles(userId, { handCorrected: false });

      expect(corrected.files.map((f) => f.id)).toEqual(["f-1"]);
      expect(untouched.files.map((f) => f.id)).toEqual(["f-2"]);
    });
  });

  describe("listFiles - paging and the limit (#116)", () => {
    // Seed n files, newest first by uploadedAt so page order is deterministic.
    const seedFiles = (n: number, overridesFor: (i: number) => Record<string, unknown> = () => ({})) => {
      for (let i = 0; i < n; i++) {
        store.setDoc(
          "files",
          `f-${String(i).padStart(3, "0")}`,
          createTestFile({
            userId,
            uploadedAt: new Date(Date.UTC(2026, 0, 1) + (n - i) * 60_000),
            ...overridesFor(i),
          })
        );
      }
    };

    it("honours a limit above 100 instead of silently clamping to it", async () => {
      seedFiles(120);

      const result = await handlers.listFiles(userId, { limit: 200 });

      expect(result.count).toBe(120);
      expect(result.files).toHaveLength(120);
    });

    it("caps the page at 500 for an absurd limit, and says there is more", async () => {
      seedFiles(600);

      const result = await handlers.listFiles(userId, { limit: 10_000 });

      expect(result.count).toBe(500);
      expect(result.nextCursor).not.toBeNull();
    });

    it("does not report an empty account when the newest documents are all filtered away", async () => {
      // The headline bug: the pre-fix handler read the newest `limit`
      // documents and dropped the soft-deleted and not-an-invoice ones after
      // that, so an account whose newest 100 are all filtered came back as [],
      // which reads to an agent as "this account has no files".
      seedFiles(120, (i) => (i < 100 ? { deletedAt: new Date() } : {}));

      const result = await handlers.listFiles(userId, { limit: 50 });

      expect(result.count).toBe(20);
      expect(result.files.every((f) => !f.deletedAt)).toBe(true);
    });

    it("reaches files past the newest 100 documents", async () => {
      // Anything older than the newest 100 by uploadedAt was unreachable
      // through the tool at all: the cap was hard and there was no cursor.
      seedFiles(250);

      const seen = new Set<string>();
      let cursor: string | null | undefined = undefined;
      let guard = 0;

      do {
        const page: Awaited<ReturnType<typeof handlers.listFiles>> = await handlers.listFiles(userId, {
          limit: 50,
          ...(cursor ? { cursor } : {}),
        });
        page.files.forEach((f) => seen.add(f.id as string));
        cursor = page.nextCursor;
      } while (cursor && ++guard < 20);

      expect(seen.size).toBe(250);
      expect(seen.has("f-249")).toBe(true);
    });

    it("pages to exhaustion via nextCursor, no duplicates, no gaps", async () => {
      seedFiles(25);

      const seen: string[] = [];
      let cursor: string | null | undefined = undefined;
      let guard = 0;

      do {
        const page: Awaited<ReturnType<typeof handlers.listFiles>> = await handlers.listFiles(userId, {
          limit: 7,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...page.files.map((f) => f.id as string));
        cursor = page.nextCursor;
      } while (cursor && ++guard < 20);

      expect(seen).toHaveLength(25);
      expect(new Set(seen).size).toBe(25);
    });

    it("keeps paging when a whole scan window is filtered away", async () => {
      // 60 not-an-invoice files in front of 5 real ones, page size 5 -> scan
      // window 25, so the first two pages are empty but must still hand back a
      // cursor rather than ending the walk.
      seedFiles(65, (i) => (i < 60 ? { isNotInvoice: true } : {}));

      const seen: string[] = [];
      let cursor: string | null | undefined = undefined;
      let guard = 0;

      do {
        const page: Awaited<ReturnType<typeof handlers.listFiles>> = await handlers.listFiles(userId, {
          limit: 5,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...page.files.map((f) => f.id as string));
        cursor = page.nextCursor;
      } while (cursor && ++guard < 30);

      expect(seen).toHaveLength(5);
    });

    it("ignores a cursor belonging to another user", async () => {
      // Without the ownership check on the cursor document, a caller holding
      // another user's file id resumes paging from a position in that user's
      // data.
      seedFiles(3);
      store.setDoc("files", "f-other", createTestFile({ userId: otherUserId }));

      const result = await handlers.listFiles(userId, { cursor: "f-other" });

      expect(result.count).toBe(3);
    });

    it("ignores a cursor that does not exist", async () => {
      seedFiles(3);

      const result = await handlers.listFiles(userId, { cursor: "f-gone" });

      expect(result.count).toBe(3);
    });
  });

  describe("getFile", () => {
    it("should return file by ID", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, fileName: "invoice.pdf" }));

      const result = await handlers.getFile(userId, "f-1");

      expect(result.id).toBe("f-1");
      expect(result.fileName).toBe("invoice.pdf");
    });

    it("should throw error for non-existent file", async () => {
      await expect(handlers.getFile(userId, "non-existent")).rejects.toThrow("File not found");
    });
  });

  describe("connectFileToTransaction", () => {
    it("should connect file to transaction", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, transactionIds: [] }));
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, fileIds: [] }));

      const result = await handlers.connectFileToTransaction(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
      });

      expect(result.success).toBe(true);

      const file = store.getDoc("files", "f-1");
      const tx = store.getDoc("transactions", "tx-1");
      expect(file?.transactionIds).toContain("tx-1");
      expect(tx?.fileIds).toContain("f-1");
      expect(tx?.isComplete).toBe(true);
    });

    it("should create fileConnection record", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId }));
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId }));

      await handlers.connectFileToTransaction(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
      });

      const connections = store.queryDocs("fileConnections", [{ field: "fileId", op: "==", value: "f-1" }]);
      expect(connections).toHaveLength(1);
      expect(connections[0].data.connectionType).toBe("api");
    });

    it("should throw error when file not found", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId }));

      await expect(
        handlers.connectFileToTransaction(userId, { fileId: "non-existent", transactionId: "tx-1" })
      ).rejects.toThrow("File not found");
    });

    it("should throw error when transaction not found", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId }));

      await expect(
        handlers.connectFileToTransaction(userId, { fileId: "f-1", transactionId: "non-existent" })
      ).rejects.toThrow("Transaction not found");
    });
  });

  // Fork #101. The gate lives in this handler rather than at its callers
  // because auto_connect_file_suggestions reaches the same write through it.
  describe("connectFileToTransaction — dismissal gate (fork #101)", () => {
    it("refuses a pair the file has rejected", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({ userId, dismissedTransactionIds: ["tx-1"] })
      );
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, fileIds: [] }));

      await expect(
        handlers.connectFileToTransaction(userId, { fileId: "f-1", transactionId: "tx-1" })
      ).rejects.toThrow("PAIR_REJECTED");

      // The refusal must leave no half-written state behind.
      const file = store.getDoc("files", "f-1");
      const tx = store.getDoc("transactions", "tx-1");
      expect(file?.transactionIds ?? []).not.toContain("tx-1");
      expect(tx?.fileIds ?? []).not.toContain("f-1");
      expect(
        store.queryDocs("fileConnections", [{ field: "fileId", op: "==", value: "f-1" }])
      ).toHaveLength(0);
    });

    it("refuses on the record shape too, not only the legacy id array", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({
          userId,
          dismissedTransactions: [{ transactionId: "tx-1", dismissedAt: new Date() }],
        })
      );
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId }));

      await expect(
        handlers.connectFileToTransaction(userId, { fileId: "f-1", transactionId: "tx-1" })
      ).rejects.toThrow("PAIR_REJECTED");
    });

    it("connects again once the rejection is taken back", async () => {
      // What undismiss leaves behind: the id gone from the enforcement array,
      // the record kept as history and stamped. The pair must be connectable.
      store.setDoc(
        "files",
        "f-1",
        createTestFile({
          userId,
          dismissedTransactionIds: [],
          dismissedTransactions: [
            { transactionId: "tx-1", dismissedAt: new Date(), undismissedAt: new Date() },
          ],
        })
      );
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, fileIds: [] }));

      const result = await handlers.connectFileToTransaction(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
      });

      expect(result.success).toBe(true);
      expect(store.getDoc("files", "f-1")?.transactionIds).toContain("tx-1");
    });

    it("leaves an unrelated dismissal alone", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({ userId, dismissedTransactionIds: ["tx-other"] })
      );
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, fileIds: [] }));

      const result = await handlers.connectFileToTransaction(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
      });

      expect(result.success).toBe(true);
    });

    it("stops autoConnectFileSuggestions from reconnecting a rejected pair", async () => {
      // The suggestion is stale: dismissal normally strips it, but a file
      // written before the record format, or re-scored by a path that predates
      // the filter, can still carry one. The handler is the backstop.
      store.setDoc(
        "files",
        "f-1",
        createTestFile({
          userId,
          transactionIds: [],
          transactionMatchComplete: true,
          dismissedTransactionIds: ["tx-1"],
          transactionSuggestions: [{ transactionId: "tx-1", confidence: 99 }],
        })
      );
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, fileIds: [] }));

      const result = await handlers.autoConnectFileSuggestions(userId, { minConfidence: 89 });

      expect(result.connected).toBe(0);
      expect(result.skipped).toBe(1);
      expect(store.getDoc("files", "f-1")?.transactionIds ?? []).not.toContain("tx-1");
    });
  });

  describe("disconnectFileFromTransaction", () => {
    it("should disconnect file from transaction", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, transactionIds: ["tx-1"] }));
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, fileIds: ["f-1"] }));
      store.setDoc("fileConnections", "conn-1", {
        fileId: "f-1",
        transactionId: "tx-1",
        userId,
      });

      const result = await handlers.disconnectFileFromTransaction(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
      });

      expect(result.success).toBe(true);
    });

    it("should throw error when connection not found", async () => {
      await expect(
        handlers.disconnectFileFromTransaction(userId, { fileId: "f-1", transactionId: "tx-1" })
      ).rejects.toThrow("Connection not found");
    });
  });

  describe("updateFileExtraction", () => {
    it("corrects only what was passed and makes the human the authority", async () => {
      // IV-26-1170: a Schlussrechnung due 3180.00 whose items describe the
      // full 6360.00 scope, flagged and carrying a printed rate-group block.
      store.setDoc(
        "files",
        "f-1",
        createTestFile({
          userId,
          extractedAmount: 636000,
          extractedVatAmount: 106000,
          extractedVatPercent: 20,
          extractedPartner: "ELDI Handels GmbH",
          lineItemsUnreconciled: true,
          extractedRateGroups: [{ rate: 20, net: 530000, vat: 106000, gross: 636000 }],
        })
      );

      const result = await handlers.updateFileExtraction(userId, {
        fileId: "f-1",
        amount: 318000,
        vatAmount: 53000,
      });

      expect(result).toMatchObject({ success: true, fileId: "f-1", changed: ["amount", "vatAmount"] });

      const file = store.getDoc("files", "f-1");
      expect(file?.extractedAmount).toBe(318000);
      expect(file?.extractedVatAmount).toBe(53000);
      // Untouched by this correction.
      expect(file?.extractedVatPercent).toBe(20);
      expect(file?.extractedPartner).toBe("ELDI Handels GmbH");
      // The artefacts that would outrank the correction are gone.
      expect(file?.lineItemsUnreconciled).toBe(false);
      expect(file?.extractedRateGroups).toBeNull();
      expect(file?.vatSourceDowngraded).toBe(false);
    });

    it("recomputes the § 11 document type, since it is stored and not read-time (#104)", async () => {
      // Under 400 EUR with a rate: a valid Kleinbetragsrechnung.
      store.setDoc(
        "files",
        "f-1",
        createTestFile({
          userId,
          extractedAmount: 5400,
          extractedVatPercent: 20,
          extractedDate: new Date("2026-03-04"),
          extractedPartner: "Elektro Huber e.U.",
          extractedAddress: "Wien",
          extractedLineItems: [{ description: "USB-C Kabel", vatPercent: 20 }],
          extractedSelfDesignation: "Rechnung",
          extractedInvoiceNumber: null,
          documentType: "invoice",
        })
      );

      // Clearing the rate takes the § 11 Abs 6 discriminator away with it.
      await handlers.updateFileExtraction(userId, { fileId: "f-1", vatPercent: null, lineItems: [] });

      const file = store.getDoc("files", "f-1");
      expect(file?.documentType).toBe("receipt");
      expect(file?.documentTypeMissingElements).toContain("steuersatz");
    });

    it("propagates a changed document type to the transactions holding the file (#104)", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({
          userId,
          extractedAmount: 5400,
          extractedVatPercent: 20,
          documentType: "receipt",
          transactionIds: ["tx-1"],
        })
      );
      store.setDoc(
        "transactions",
        "tx-1",
        createTestTransaction({ userId, fileIds: ["f-1"], documentationState: "receipt-only" })
      );

      // A rate at this amount makes it a Kleinbetragsrechnung.
      await handlers.updateFileExtraction(userId, { fileId: "f-1", vatPercent: 20 });

      expect(store.getDoc("files", "f-1")?.documentType).toBe("invoice");
      expect(store.getDoc("transactions", "tx-1")?.documentationState).toBe("invoice");
    });

    it("writes a zero rate rather than reading it as unset", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, extractedVatPercent: 20, extractedVatAmount: 4533 }));

      await handlers.updateFileExtraction(userId, { fileId: "f-1", vatPercent: 0, vatAmount: 0 });

      const file = store.getDoc("files", "f-1");
      expect(file?.extractedVatPercent).toBe(0);
      expect(file?.extractedVatAmount).toBe(0);
    });

    it("refuses a file the caller does not own", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId: "someone-else" }));

      await expect(
        handlers.updateFileExtraction(userId, { fileId: "f-1", amount: 1 })
      ).rejects.toThrow("File not found");
    });

    it("refuses a correction that corrects nothing", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId }));

      await expect(handlers.updateFileExtraction(userId, { fileId: "f-1" })).rejects.toThrow(
        /Nothing to correct/
      );
    });

    it("ignores a key the schema does not name", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, extractedPartner: "ELDI Handels GmbH" }));

      await handlers.updateFileExtraction(userId, {
        fileId: "f-1",
        amount: 318000,
        extractedPartner: "Somebody Else",
      });

      expect(store.getDoc("files", "f-1")?.extractedPartner).toBe("ELDI Handels GmbH");
    });
  });

  // ==========================================================================
  // Classifier write path (#204)
  //
  // The sweep itself is tested in documents/reclassifyStoredDocuments.test.ts;
  // what belongs here is the tool surface — one call covering both
  // collections, and the dry-run default a typo must not get past.
  // ==========================================================================

  describe("reclassifyDocumentsTool", () => {
    /** A payment confirmation: no rate, no UID, and it says what it is. */
    function receiptFile() {
      return createTestFile({
        userId,
        extractedAmount: 2499,
        extractedDate: new Date("2026-03-05"),
        extractedIssuer: { name: "Amazon EU S.à r.l.", address: "Luxembourg", vatId: null },
        extractedSelfDesignation: "Zahlungsbestätigung",
        extractedInvoiceNumber: null,
      });
    }

    it("defaults to a dry run when dispatched with no arguments", async () => {
      store.setDoc("files", "f-1", receiptFile());
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, fileIds: ["f-1"] }));

      const result = (await handlers.handleTool(userId, "reclassify_documents", {})) as {
        dryRun: boolean;
        files: { changed: number; written: number };
        transactions: { changed: number; written: number };
      };

      expect(result.dryRun).toBe(true);
      expect(result.files).toMatchObject({ changed: 1, written: 0 });
      expect(result.transactions).toMatchObject({ changed: 1, written: 0 });
      expect(store.getDoc("files", "f-1")?.documentType).toBeUndefined();
    });

    it("classifies files and re-derives transactions in one call when opted in", async () => {
      store.setDoc("files", "f-1", receiptFile());
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, fileIds: ["f-1"] }));

      await handlers.reclassifyDocumentsTool(userId, { dryRun: false });

      expect(store.getDoc("files", "f-1")?.documentType).toBe("receipt");
      expect(store.getDoc("transactions", "tx-1")?.documentationState).toBe("receipt-only");
    });

    it("refuses a dryRun that is not a boolean", async () => {
      await expect(
        handlers.reclassifyDocumentsTool(userId, { dryRun: "false" })
      ).rejects.toThrow("dryRun must be a boolean");
    });
  });

  describe("markFileAsNotInvoice / unmarkFileAsNotInvoice", () => {
    it("should flag the file, clear extracted data and empty the suggestion queue", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({
          userId,
          transactionIds: [],
          isNotInvoice: false,
          extractedAmount: 1999,
          extractedIssuer: "Anthropic, PBC",
          extractionConfidence: 92,
          transactionMatchComplete: true,
          transactionSuggestions: [{ transactionId: "tx-1", confidence: 91 }],
        })
      );

      const result = await handlers.markFileAsNotInvoice(userId, {
        fileId: "f-1",
        reason: "duplicate re-send",
      });

      expect(result).toMatchObject({ success: true, fileId: "f-1", isNotInvoice: true });

      const file = store.getDoc("files", "f-1");
      expect(file?.isNotInvoice).toBe(true);
      expect(file?.notInvoiceReason).toBe("duplicate re-send");
      expect(file?.extractedAmount).toBeNull();
      expect(file?.extractionConfidence).toBeNull();
      expect(file?.transactionSuggestions).toEqual([]);
      expect(file?.transactionMatchComplete).toBe(false);
      // Nothing left to extract, so extraction counts as done.
      expect(file?.extractionComplete).toBe(true);
    });

    it("should default the reason when none is given", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, transactionIds: [] }));

      await handlers.markFileAsNotInvoice(userId, { fileId: "f-1" });

      expect(store.getDoc("files", "f-1")?.notInvoiceReason).toBe("Marked by user");
    });

    it("should preserve a manually-set partner", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({
          userId,
          transactionIds: [],
          partnerId: "p-1",
          partnerMatchedBy: "manual",
        })
      );

      await handlers.markFileAsNotInvoice(userId, { fileId: "f-1" });

      const file = store.getDoc("files", "f-1");
      expect(file?.partnerId).toBe("p-1");
      expect(file?.partnerMatchedBy).toBe("manual");
    });

    it("should clear an auto-matched partner", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({ userId, transactionIds: [], partnerId: "p-1", partnerMatchedBy: "auto" })
      );

      await handlers.markFileAsNotInvoice(userId, { fileId: "f-1" });

      expect(store.getDoc("files", "f-1")?.partnerId).toBeNull();
    });

    it("should refuse while the file is still connected to a transaction", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, transactionIds: ["tx-1"] }));

      await expect(handlers.markFileAsNotInvoice(userId, { fileId: "f-1" })).rejects.toThrow(
        /connected to 1 transaction/
      );

      // The refusal must not have written anything.
      expect(store.getDoc("files", "f-1")?.isNotInvoice).toBeFalsy();
    });

    it("should require a fileId", async () => {
      await expect(handlers.markFileAsNotInvoice(userId, {})).rejects.toThrow("fileId is required");
      await expect(handlers.unmarkFileAsNotInvoice(userId, {})).rejects.toThrow("fileId is required");
    });

    it("should not reach another user's file", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId: otherUserId, transactionIds: [] }));

      await expect(handlers.markFileAsNotInvoice(userId, { fileId: "f-1" })).rejects.toThrow("File not found");
      await expect(handlers.unmarkFileAsNotInvoice(userId, { fileId: "f-1" })).rejects.toThrow("File not found");
    });

    it("should re-open extraction on unmark", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({
          userId,
          isNotInvoice: true,
          notInvoiceReason: "duplicate re-send",
          extractionComplete: true,
        })
      );

      const result = await handlers.unmarkFileAsNotInvoice(userId, { fileId: "f-1" });

      expect(result).toMatchObject({ success: true, isNotInvoice: false });

      const file = store.getDoc("files", "f-1");
      expect(file?.isNotInvoice).toBe(false);
      expect(file?.notInvoiceReason).toBeNull();
      expect(file?.extractionComplete).toBe(false);
      expect(file?.transactionMatchComplete).toBe(false);
    });

    it("should leave transaction matching alone when a manual connection exists", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({ userId, isNotInvoice: true, transactionMatchComplete: true })
      );
      store.setDoc("fileConnections", "conn-1", {
        fileId: "f-1",
        transactionId: "tx-1",
        userId,
        connectionType: "manual",
      });

      await handlers.unmarkFileAsNotInvoice(userId, { fileId: "f-1" });

      const file = store.getDoc("files", "f-1");
      expect(file?.isNotInvoice).toBe(false);
      // Re-running the match would discard a connection a human made by hand.
      expect(file?.transactionMatchComplete).toBe(true);
    });

    it("should round-trip mark then unmark", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, transactionIds: [], extractedAmount: 1999 }));

      await handlers.markFileAsNotInvoice(userId, { fileId: "f-1", reason: "statement" });
      expect(store.getDoc("files", "f-1")?.isNotInvoice).toBe(true);

      await handlers.unmarkFileAsNotInvoice(userId, { fileId: "f-1" });

      const file = store.getDoc("files", "f-1");
      expect(file?.isNotInvoice).toBe(false);
      expect(file?.notInvoiceReason).toBeNull();
      // The cleared fields come back via re-extraction, which this re-opens.
      expect(file?.extractionComplete).toBe(false);
    });
  });

  // #203. The marker is a judgement about the document, not a correction to
  // it, which is what separates this pair from update_file_extraction.
  describe("markFileVatNotClaimable / unmarkFileVatNotClaimable", () => {
    it("stores the reason and leaves the extracted figures alone", async () => {
      // paperless-ap-1004: 11% Versicherungssteuer, printed rate-group block.
      store.setDoc(
        "files",
        "f-1",
        createTestFile({
          userId,
          transactionIds: ["tx-1"],
          extractedAmount: 22200,
          extractedRateGroups: [{ rate: 11, net: 20000, vat: 2200, gross: 22200 }],
        })
      );

      const result = await handlers.markFileVatNotClaimable(userId, {
        fileId: "f-1",
        reason: "insurance-tax",
        note: "Filmproduktionshaftpflicht",
      });

      expect(result).toMatchObject({
        success: true,
        fileId: "f-1",
        vatNotClaimableReason: "insurance-tax",
      });

      const file = store.getDoc("files", "f-1");
      expect(file?.vatNotClaimableReason).toBe("insurance-tax");
      expect(file?.vatNotClaimableNote).toBe("Filmproduktionshaftpflicht");
      expect(file?.extractedAmount).toBe(22200);
      expect(file?.extractedRateGroups).toEqual([
        { rate: 11, net: 20000, vat: 2200, gross: 22200 },
      ]);
    });

    it("refuses a reason outside the closed set", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId }));

      await expect(
        handlers.markFileVatNotClaimable(userId, { fileId: "f-1", reason: "because" })
      ).rejects.toThrow(/insurance-tax/);
      expect(store.getDoc("files", "f-1")?.vatNotClaimableReason).toBeUndefined();
    });

    it("marks a connected file — that is the case it exists for", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, transactionIds: ["tx-1"] }));

      await handlers.markFileVatNotClaimable(userId, {
        fileId: "f-1",
        reason: "discount-to-zero",
      });

      expect(store.getDoc("files", "f-1")?.vatNotClaimableReason).toBe("discount-to-zero");
    });

    it("round-trips mark then unmark", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, extractedVatAmount: 2000 }));

      await handlers.markFileVatNotClaimable(userId, { fileId: "f-1", reason: "private" });
      await handlers.unmarkFileVatNotClaimable(userId, { fileId: "f-1" });

      const file = store.getDoc("files", "f-1");
      expect(file?.vatNotClaimableReason).toBeNull();
      expect(file?.vatNotClaimableNote).toBeNull();
      // Nothing was ever cleared, so nothing has to come back.
      expect(file?.extractedVatAmount).toBe(2000);
    });

    it("refuses a file that is not the caller's", async () => {
      store.setDoc("files", "f-other", createTestFile({ userId: otherUserId }));

      await expect(
        handlers.markFileVatNotClaimable(userId, { fileId: "f-other", reason: "levy" })
      ).rejects.toThrow("File not found");
    });
  });

  // ==========================================================================
  // Categories
  // ==========================================================================

  describe("listNoReceiptCategories", () => {
    it("should return active categories for user", async () => {
      store.setDoc("noReceiptCategories", "cat-1", { userId, name: "Bank Fees", isActive: true });
      store.setDoc("noReceiptCategories", "cat-2", { userId, name: "Interest", isActive: true });
      store.setDoc("noReceiptCategories", "cat-3", { userId, name: "Inactive", isActive: false });

      const result = await handlers.listNoReceiptCategories(userId);

      expect(result).toHaveLength(2);
    });
  });

  describe("assignNoReceiptCategory", () => {
    it("should assign category to transaction", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, isComplete: false }));
      store.setDoc("noReceiptCategories", "cat-1", {
        userId,
        name: "Bank Fees",
        templateId: "template-1",
        isActive: true,
        transactionCount: 0,
      });

      const result = await handlers.assignNoReceiptCategory(userId, {
        transactionId: "tx-1",
        categoryId: "cat-1",
      });

      expect(result.success).toBe(true);
      expect(result.categoryName).toBe("Bank Fees");

      const tx = store.getDoc("transactions", "tx-1");
      expect(tx?.noReceiptCategoryId).toBe("cat-1");
      expect(tx?.isComplete).toBe(true);
    });

    it("should throw error for non-existent category", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId }));

      await expect(
        handlers.assignNoReceiptCategory(userId, { transactionId: "tx-1", categoryId: "non-existent" })
      ).rejects.toThrow("Category not found");
    });
  });

  describe("removeNoReceiptCategory", () => {
    it("should remove category from transaction", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({
        userId,
        noReceiptCategoryId: "cat-1",
        isComplete: true,
        fileIds: [],
      }));
      store.setDoc("noReceiptCategories", "cat-1", {
        userId,
        name: "Bank Fees",
        transactionCount: 1,
      });

      const result = await handlers.removeNoReceiptCategory(userId, "tx-1");

      expect(result.success).toBe(true);
      expect(result.isComplete).toBe(false);

      const tx = store.getDoc("transactions", "tx-1");
      expect(tx?.noReceiptCategoryId).toBe(null);
    });

    it("should keep isComplete true if transaction has files", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({
        userId,
        noReceiptCategoryId: "cat-1",
        isComplete: true,
        fileIds: ["f-1"],
      }));
      store.setDoc("noReceiptCategories", "cat-1", { userId, transactionCount: 1 });

      const result = await handlers.removeNoReceiptCategory(userId, "tx-1");

      expect(result.isComplete).toBe(true);
    });

    it("should throw error if no category assigned", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, noReceiptCategoryId: null }));

      await expect(handlers.removeNoReceiptCategory(userId, "tx-1")).rejects.toThrow(
        "Transaction has no category assigned"
      );
    });
  });

  // ==========================================================================
  // autoConnectFileSuggestions
  // ==========================================================================

  describe("autoConnectFileSuggestions", () => {
    it("should auto-connect files with high confidence suggestions", async () => {
      store.setDoc("files", "f-1", createTestFile({
        userId,
        transactionIds: [],
        transactionMatchComplete: true,
        transactionSuggestions: [
          { transactionId: "tx-1", confidence: 95 },
          { transactionId: "tx-2", confidence: 70 },
        ],
      }));
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, fileIds: [] }));
      store.setDoc("transactions", "tx-2", createTestTransaction({ userId, fileIds: [] }));

      const result = await handlers.autoConnectFileSuggestions(userId, { minConfidence: 89 });

      expect(result.connected).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.connections).toHaveLength(1);
      expect(result.connections[0].transactionId).toBe("tx-1");
      expect(result.connections[0].confidence).toBe(95);
    });

    it("should skip files below confidence threshold", async () => {
      // When using fileId, it processes that specific file regardless of transactionMatchComplete
      store.setDoc("files", "f-1", createTestFile({
        userId,
        transactionIds: [],
        transactionSuggestions: [{ transactionId: "tx-1", confidence: 50 }],
      }));

      const result = await handlers.autoConnectFileSuggestions(userId, { fileId: "f-1", minConfidence: 89 });

      expect(result.connected).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it("should skip already connected files", async () => {
      store.setDoc("files", "f-1", createTestFile({
        userId,
        transactionIds: ["tx-existing"],
        transactionSuggestions: [{ transactionId: "tx-1", confidence: 95 }],
      }));

      // Using fileId to target specific file
      const result = await handlers.autoConnectFileSuggestions(userId, { fileId: "f-1" });

      expect(result.connected).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it("should process specific file when fileId provided", async () => {
      store.setDoc("files", "f-1", createTestFile({
        userId,
        transactionIds: [],
        transactionSuggestions: [{ transactionId: "tx-1", confidence: 95 }],
      }));
      store.setDoc("files", "f-2", createTestFile({
        userId,
        transactionIds: [],
        transactionSuggestions: [{ transactionId: "tx-2", confidence: 95 }],
      }));
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId }));

      const result = await handlers.autoConnectFileSuggestions(userId, { fileId: "f-1" });

      expect(result.connected).toBe(1);
      expect(result.connections[0].fileId).toBe("f-1");
    });

    it("should throw error for non-existent fileId", async () => {
      await expect(
        handlers.autoConnectFileSuggestions(userId, { fileId: "non-existent" })
      ).rejects.toThrow("File not found");
    });

    it("should use default confidence of 89 when not specified", async () => {
      store.setDoc("files", "f-1", createTestFile({
        userId,
        transactionIds: [],
        transactionSuggestions: [{ transactionId: "tx-1", confidence: 88 }],
      }));

      // Using fileId to target specific file
      const result = await handlers.autoConnectFileSuggestions(userId, { fileId: "f-1" });

      expect(result.connected).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it("should connect to highest confidence suggestion", async () => {
      store.setDoc("files", "f-1", createTestFile({
        userId,
        transactionIds: [],
        transactionMatchComplete: true,
        transactionSuggestions: [
          { transactionId: "tx-low", confidence: 90 },
          { transactionId: "tx-high", confidence: 98 },
          { transactionId: "tx-mid", confidence: 95 },
        ],
      }));
      store.setDoc("transactions", "tx-high", createTestTransaction({ userId }));

      const result = await handlers.autoConnectFileSuggestions(userId, {});

      expect(result.connections[0].transactionId).toBe("tx-high");
    });
  });

  // ==========================================================================
  // Edge Cases: Date Filtering
  // ==========================================================================

  describe("listTransactions - date filtering", () => {
    it("should filter by dateFrom", async () => {
      store.setDoc("transactions", "tx-old", createTestTransaction({
        userId,
        date: new Date("2024-01-01"),
      }));
      store.setDoc("transactions", "tx-new", createTestTransaction({
        userId,
        date: new Date("2024-06-15"),
      }));

      const result = await handlers.listTransactions(userId, { dateFrom: "2024-03-01" });

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].id).toBe("tx-new");
    });

    it("should filter by dateTo", async () => {
      store.setDoc("transactions", "tx-old", createTestTransaction({
        userId,
        date: new Date("2024-01-01"),
      }));
      store.setDoc("transactions", "tx-new", createTestTransaction({
        userId,
        date: new Date("2024-06-15"),
      }));

      const result = await handlers.listTransactions(userId, { dateTo: "2024-03-01" });

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].id).toBe("tx-old");
    });

    it("should filter by date range", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, date: new Date("2024-01-01") }));
      store.setDoc("transactions", "tx-2", createTestTransaction({ userId, date: new Date("2024-03-15") }));
      store.setDoc("transactions", "tx-3", createTestTransaction({ userId, date: new Date("2024-06-01") }));

      const result = await handlers.listTransactions(userId, {
        dateFrom: "2024-02-01",
        dateTo: "2024-05-01",
      });

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].id).toBe("tx-2");
    });
  });

  // ==========================================================================
  // Edge Cases: Limit Parameter
  // ==========================================================================

  describe("limit parameter", () => {
    // Note: Mock Firestore doesn't enforce limits, so we test that:
    // 1. The handler doesn't throw with limit param
    // 2. listTransactionsNeedingFiles applies limit client-side (after filter)

    it("listTransactions should accept limit parameter without error", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId }));

      const result = await handlers.listTransactions(userId, { limit: 3 });

      expect(result).toBeDefined();
      expect(Array.isArray(result.transactions)).toBe(true);
    });

    it("listTransactions should cap limit at 100", async () => {
      const result = await handlers.listTransactions(userId, { limit: 200 });
      // Just verify it doesn't throw - limit is applied server-side
      expect(result).toBeDefined();
      expect(Array.isArray(result.transactions)).toBe(true);
    });

    it("listFiles should accept limit parameter without error", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId }));

      const result = await handlers.listFiles(userId, { limit: 5 });

      expect(result).toBeDefined();
      expect(Array.isArray(result.files)).toBe(true);
    });

    it("listTransactionsNeedingFiles should apply limit after filtering", async () => {
      // This handler applies limit client-side after filtering, so we can test it
      for (let i = 0; i < 10; i++) {
        store.setDoc(`transactions`, `tx-${i}`, createTestTransaction({
          userId,
          fileIds: [],
          noReceiptCategoryId: null,
        }));
      }

      const result = await handlers.listTransactionsNeedingFiles(userId, { limit: 4 });

      expect(result.transactions).toHaveLength(4);
      expect(result.count).toBe(4);
      expect(result.nextCursor).not.toBeNull();
    });
  });

  // ==========================================================================
  // Edge Cases: Already Connected / Duplicate Operations
  // ==========================================================================

  describe("duplicate operations", () => {
    it("connectFileToTransaction should handle already connected file (adds duplicate)", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, transactionIds: ["tx-1"] }));
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, fileIds: ["f-1"] }));

      // Should still succeed (creates another connection record)
      const result = await handlers.connectFileToTransaction(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
      });

      expect(result.success).toBe(true);
    });

    it("assignNoReceiptCategory should overwrite existing category", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({
        userId,
        noReceiptCategoryId: "cat-old",
      }));
      store.setDoc("noReceiptCategories", "cat-old", { userId, transactionCount: 1 });
      store.setDoc("noReceiptCategories", "cat-new", {
        userId,
        name: "New Category",
        templateId: "t-1",
        transactionCount: 0,
      });

      const result = await handlers.assignNoReceiptCategory(userId, {
        transactionId: "tx-1",
        categoryId: "cat-new",
      });

      expect(result.success).toBe(true);
      const tx = store.getDoc("transactions", "tx-1");
      expect(tx?.noReceiptCategoryId).toBe("cat-new");
    });
  });

  // ==========================================================================
  // Edge Cases: Missing/Invalid Parameters
  // ==========================================================================

  describe("missing parameters", () => {
    it("connectFileToTransaction should throw when fileId missing", async () => {
      await expect(
        handlers.connectFileToTransaction(userId, { transactionId: "tx-1" } as any)
      ).rejects.toThrow("fileId and transactionId are required");
    });

    it("connectFileToTransaction should throw when transactionId missing", async () => {
      await expect(
        handlers.connectFileToTransaction(userId, { fileId: "f-1" } as any)
      ).rejects.toThrow("fileId and transactionId are required");
    });

    it("disconnectFileFromTransaction should throw when params missing", async () => {
      await expect(
        handlers.disconnectFileFromTransaction(userId, {} as any)
      ).rejects.toThrow("fileId and transactionId are required");
    });

    it("updateTransaction should throw when transactionId missing", async () => {
      await expect(
        handlers.updateTransaction(userId, { description: "test" } as any)
      ).rejects.toThrow("transactionId is required");
    });

    it("assignNoReceiptCategory should throw when params missing", async () => {
      await expect(
        handlers.assignNoReceiptCategory(userId, { transactionId: "tx-1" } as any)
      ).rejects.toThrow("transactionId and categoryId are required");
    });

    it("getTransaction should throw when transactionId empty", async () => {
      await expect(handlers.getTransaction(userId, "")).rejects.toThrow("transactionId is required");
    });

    it("getFile should throw when fileId empty", async () => {
      await expect(handlers.getFile(userId, "")).rejects.toThrow("fileId is required");
    });

    it("removeNoReceiptCategory should throw when transactionId empty", async () => {
      await expect(handlers.removeNoReceiptCategory(userId, "")).rejects.toThrow("transactionId is required");
    });
  });

  // ==========================================================================
  // Edge Cases: Search in Different Fields
  // ==========================================================================

  describe("listTransactions - search edge cases", () => {
    it("should search in description field", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({
        userId,
        name: "Generic",
        description: "Office supplies from Amazon",
      }));

      const result = await handlers.listTransactions(userId, { search: "amazon" });

      expect(result.transactions).toHaveLength(1);
    });

    it("should search in partner field", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({
        userId,
        name: "Generic",
        partner: "Amazon EU SARL",
      }));

      const result = await handlers.listTransactions(userId, { search: "amazon" });

      expect(result.transactions).toHaveLength(1);
    });

    it("should be case insensitive", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({
        userId,
        name: "AMAZON PURCHASE",
      }));

      const result = await handlers.listTransactions(userId, { search: "amazon" });

      expect(result.transactions).toHaveLength(1);
    });

    it("should handle null fields gracefully", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({
        userId,
        name: null,
        description: null,
        partner: null,
      }));

      // Should not throw, just return no matches
      const result = await handlers.listTransactions(userId, { search: "test" });

      expect(result.transactions).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Edge Cases: listFiles filters
  // ==========================================================================

  // #203: the rate-review queue has to be reachable from the tool surface, or
  // the flag is only ever seen by someone already looking at the file.
  describe("listFiles - VAT rate review queue", () => {
    it("filters to files printing a rate outside the Austrian set", async () => {
      store.setDoc(
        "files",
        "f-flagged",
        createTestFile({ userId, needsVatRateReview: true, vatRatesOutsideSet: [11] })
      );
      store.setDoc("files", "f-ok", createTestFile({ userId, needsVatRateReview: false }));
      // Written before the detector existed: no flag at all, not a flagged one.
      store.setDoc("files", "f-legacy", createTestFile({ userId }));

      const flagged = await handlers.listFiles(userId, { needsVatRateReview: true });
      const rest = await handlers.listFiles(userId, { needsVatRateReview: false });

      expect(flagged.files.map((f) => f.id)).toEqual(["f-flagged"]);
      expect(flagged.files[0].vatRatesOutsideSet).toEqual([11]);
      expect(rest.files.map((f) => f.id).sort()).toEqual(["f-legacy", "f-ok"]);
    });

    it("returns every file when the filter is not passed", async () => {
      store.setDoc("files", "f-flagged", createTestFile({ userId, needsVatRateReview: true }));
      store.setDoc("files", "f-ok", createTestFile({ userId }));

      expect((await handlers.listFiles(userId, {})).files).toHaveLength(2);
    });
  });

  describe("listFiles - additional filters", () => {
    it("should filter by hasSuggestions true", async () => {
      store.setDoc("files", "f-1", createTestFile({
        userId,
        transactionSuggestions: [{ transactionId: "tx-1", confidence: 90 }],
      }));
      store.setDoc("files", "f-2", createTestFile({
        userId,
        transactionSuggestions: [],
      }));

      const result = await handlers.listFiles(userId, { hasSuggestions: true });

      expect(result.files).toHaveLength(1);
      expect(result.files[0].id).toBe("f-1");
    });

    it("should filter by hasSuggestions false", async () => {
      store.setDoc("files", "f-1", createTestFile({
        userId,
        transactionSuggestions: [{ transactionId: "tx-1", confidence: 90 }],
      }));
      store.setDoc("files", "f-2", createTestFile({
        userId,
        transactionSuggestions: [],
      }));

      const result = await handlers.listFiles(userId, { hasSuggestions: false });

      expect(result.files).toHaveLength(1);
      expect(result.files[0].id).toBe("f-2");
    });

    it("should exclude isNotInvoice files", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId }));
      store.setDoc("files", "f-2", createTestFile({ userId, isNotInvoice: true }));

      const result = await handlers.listFiles(userId, {});

      expect(result.files).toHaveLength(1);
      expect(result.files[0].id).toBe("f-1");
    });

    it("should combine multiple filters", async () => {
      store.setDoc("files", "f-1", createTestFile({
        userId,
        transactionIds: [],
        transactionSuggestions: [{ transactionId: "tx-1", confidence: 90 }],
      }));
      store.setDoc("files", "f-2", createTestFile({
        userId,
        transactionIds: ["tx-1"],
        transactionSuggestions: [{ transactionId: "tx-2", confidence: 80 }],
      }));
      store.setDoc("files", "f-3", createTestFile({
        userId,
        transactionIds: [],
        transactionSuggestions: [],
      }));

      const result = await handlers.listFiles(userId, {
        hasConnections: false,
        hasSuggestions: true,
      });

      expect(result.files).toHaveLength(1);
      expect(result.files[0].id).toBe("f-1");
    });
  });

  // ==========================================================================
  // Edge Cases: disconnectFileFromTransaction updates
  // ==========================================================================

  describe("disconnectFileFromTransaction - array updates", () => {
    it("should remove fileId from transaction", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, transactionIds: ["tx-1"] }));
      store.setDoc("transactions", "tx-1", createTestTransaction({
        userId,
        fileIds: ["f-1", "f-2"],
      }));
      store.setDoc("fileConnections", "conn-1", {
        fileId: "f-1",
        transactionId: "tx-1",
        userId,
      });

      await handlers.disconnectFileFromTransaction(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
      });

      const tx = store.getDoc("transactions", "tx-1");
      expect(tx?.fileIds).not.toContain("f-1");
      expect(tx?.fileIds).toContain("f-2");
    });

    it("should remove transactionId from file", async () => {
      store.setDoc("files", "f-1", createTestFile({
        userId,
        transactionIds: ["tx-1", "tx-2"],
      }));
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, fileIds: ["f-1"] }));
      store.setDoc("fileConnections", "conn-1", {
        fileId: "f-1",
        transactionId: "tx-1",
        userId,
      });

      await handlers.disconnectFileFromTransaction(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
      });

      const file = store.getDoc("files", "f-1");
      expect(file?.transactionIds).not.toContain("tx-1");
      expect(file?.transactionIds).toContain("tx-2");
    });

    it("should delete the fileConnection record", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, transactionIds: ["tx-1"] }));
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, fileIds: ["f-1"] }));
      store.setDoc("fileConnections", "conn-1", {
        fileId: "f-1",
        transactionId: "tx-1",
        userId,
      });

      await handlers.disconnectFileFromTransaction(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
      });

      const conn = store.getDoc("fileConnections", "conn-1");
      expect(conn).toBeUndefined();
    });
  });

  // ==========================================================================
  // handleTool Dispatcher
  // ==========================================================================

  describe("handleTool", () => {
    it("should dispatch to correct handler", async () => {
      store.setDoc("sources", "src-1", createTestSource({ userId }));

      const result = await handlers.handleTool(userId, "list_sources", {});

      expect(result).toHaveLength(1);
    });

    it("should throw error for unknown tool", async () => {
      await expect(handlers.handleTool(userId, "unknown_tool", {})).rejects.toThrow("Unknown tool: unknown_tool");
    });

    it("should pass arguments to handler", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, isComplete: true }));
      store.setDoc("transactions", "tx-2", createTestTransaction({ userId, isComplete: false }));

      const result = await handlers.handleTool(userId, "list_transactions", { isComplete: false }) as {
        transactions: unknown[];
      };

      expect(result.transactions).toHaveLength(1);
    });

    it("should handle all tool names", async () => {
      // Verify TOOL_NAMES matches actual handlers
      for (const toolName of handlers.TOOL_NAMES) {
        // Just verify it doesn't throw "Unknown tool"
        try {
          await handlers.handleTool(userId, toolName, {});
        } catch (e) {
          // Errors like "sourceId is required" are fine - means handler was called
          expect((e as Error).message).not.toContain("Unknown tool");
        }
      }
    });
  });
  describe("dismissTransactionSuggestion / undismissTransactionSuggestion", () => {
    const suggestion = (transactionId: string, confidence: number) => ({
      transactionId,
      confidence,
      matchSources: [{ type: "amount", weight: 40 }],
    });

    it("should drop the suggestion, blacklist the pair and report its confidence", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({
          userId,
          transactionSuggestions: [suggestion("tx-1", 82), suggestion("tx-2", 61)],
        })
      );

      const result = await handlers.dismissTransactionSuggestion(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
        reason: "coincidental amount",
      });

      expect(result).toMatchObject({
        success: true,
        fileId: "f-1",
        transactionId: "tx-1",
        dismissedConfidence: 82,
      });

      const file = store.getDoc("files", "f-1");
      expect(file?.transactionSuggestions).toEqual([suggestion("tx-2", 61)]);
      expect(file?.dismissedTransactionIds).toEqual(["tx-1"]);
      expect(file?.dismissedTransactions).toEqual([
        expect.objectContaining({ transactionId: "tx-1", confidence: 82, reason: "coincidental amount" }),
      ]);
    });

    it("should succeed with a null confidence when the pair was not suggested", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, transactionSuggestions: [] }));

      const result = await handlers.dismissTransactionSuggestion(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
      });

      expect(result).toMatchObject({ success: true, dismissedConfidence: null });
      expect(store.getDoc("files", "f-1")?.dismissedTransactionIds).toEqual(["tx-1"]);
    });

    it("should be idempotent across a sweep re-run", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({ userId, transactionSuggestions: [suggestion("tx-1", 82)] })
      );

      await handlers.dismissTransactionSuggestion(userId, { fileId: "f-1", transactionId: "tx-1" });
      const second = await handlers.dismissTransactionSuggestion(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
      });

      expect(second).toMatchObject({ success: true, dismissedConfidence: null });
      const file = store.getDoc("files", "f-1");
      expect(file?.dismissedTransactionIds).toEqual(["tx-1"]);
      // A second record here would double-count the rejection in the learning export.
      expect(file?.dismissedTransactions).toHaveLength(1);
    });

    it("should refuse a reason longer than 500 characters without writing", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({ userId, transactionSuggestions: [suggestion("tx-1", 82)] })
      );

      await expect(
        handlers.dismissTransactionSuggestion(userId, {
          fileId: "f-1",
          transactionId: "tx-1",
          reason: "x".repeat(501),
        })
      ).rejects.toThrow(/at most 500 characters/);

      expect(store.getDoc("files", "f-1")?.dismissedTransactionIds).toBeUndefined();
    });

    it("should refuse a non-string reason rather than persist it raw", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({ userId, transactionSuggestions: [suggestion("tx-1", 82)] })
      );

      await expect(
        handlers.dismissTransactionSuggestion(userId, {
          fileId: "f-1",
          transactionId: "tx-1",
          reason: { note: "x".repeat(9999) },
        })
      ).rejects.toThrow(/must be a string/);

      expect(store.getDoc("files", "f-1")?.dismissedTransactionIds).toBeUndefined();
    });

    it("should require both ids", async () => {
      await expect(handlers.dismissTransactionSuggestion(userId, {})).rejects.toThrow(
        "fileId is required"
      );
      await expect(
        handlers.dismissTransactionSuggestion(userId, { fileId: "f-1" })
      ).rejects.toThrow("transactionId is required");
      await expect(handlers.undismissTransactionSuggestion(userId, {})).rejects.toThrow(
        "fileId is required"
      );
      await expect(
        handlers.undismissTransactionSuggestion(userId, { fileId: "f-1" })
      ).rejects.toThrow("transactionId is required");
    });

    it("should separate an unknown file from another user's file", async () => {
      await expect(
        handlers.dismissTransactionSuggestion(userId, { fileId: "f-1", transactionId: "tx-1" })
      ).rejects.toThrow("File not found");

      store.setDoc("files", "f-2", createTestFile({ userId: otherUserId }));

      await expect(
        handlers.dismissTransactionSuggestion(userId, { fileId: "f-2", transactionId: "tx-1" })
      ).rejects.toThrow("Access denied");
      await expect(
        handlers.undismissTransactionSuggestion(userId, { fileId: "f-2", transactionId: "tx-1" })
      ).rejects.toThrow("Access denied");

      // The refusal must not have written anything.
      expect(store.getDoc("files", "f-2")?.dismissedTransactionIds).toBeUndefined();
    });

    it("should round-trip dismiss then undismiss, keeping the attempt as history", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({ userId, transactionSuggestions: [suggestion("tx-1", 82)] })
      );

      await handlers.dismissTransactionSuggestion(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
        reason: "coincidence",
      });

      const result = await handlers.undismissTransactionSuggestion(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
      });

      expect(result).toMatchObject({ success: true, wasDismissed: true });

      const file = store.getDoc("files", "f-1");
      // The enforcement list is what undo clears.
      expect(file?.dismissedTransactionIds).toEqual([]);
      // The record survives, stamped, so a later sweep can see what was tried
      // and why rather than re-deriving the same wrong pairing blind.
      expect(file?.dismissedTransactions).toEqual([
        expect.objectContaining({
          transactionId: "tx-1",
          confidence: 82,
          reason: "coincidence",
          undismissedAt: expect.anything(),
        }),
      ]);
      // Undismissing does not fabricate the suggestion back — matching does that.
      expect(file?.transactionSuggestions).toEqual([]);
    });

    it("should log a second rejection after an undo instead of silently keeping one", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({ userId, transactionSuggestions: [suggestion("tx-1", 82)] })
      );

      await handlers.dismissTransactionSuggestion(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
        reason: "first call",
      });
      await handlers.undismissTransactionSuggestion(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
      });
      await handlers.dismissTransactionSuggestion(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
        reason: "second call",
      });

      const file = store.getDoc("files", "f-1");
      // Two decisions logged, one of them reversed...
      expect(file?.dismissedTransactions).toEqual([
        expect.objectContaining({ reason: "first call", undismissedAt: expect.anything() }),
        expect.objectContaining({ reason: "second call" }),
      ]);
      expect(
        (file?.dismissedTransactions as Array<Record<string, unknown>>)[1]
      ).not.toHaveProperty("undismissedAt");
      // ...and exactly one live entry on the list matching enforces against.
      expect(file?.dismissedTransactionIds).toEqual(["tx-1"]);
    });

    it("should report wasDismissed false and write nothing for a pair that was never dismissed", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId }));
      const before = { ...store.getDoc("files", "f-1") };

      const result = await handlers.undismissTransactionSuggestion(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
      });

      expect(result).toMatchObject({ success: true, wasDismissed: false });
      // Not even updatedAt: a sweep clearing a speculative list must not stamp
      // every file it looked at.
      expect(store.getDoc("files", "f-1")).toEqual(before);
    });

    it("should treat a reversed rejection as no rejection at all", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({
          userId,
          dismissedTransactionIds: [],
          dismissedTransactions: [
            {
              transactionId: "tx-1",
              dismissedAt: new Date(),
              confidence: 82,
              reason: null,
              undismissedAt: new Date(),
            },
          ],
        })
      );
      const before = { ...store.getDoc("files", "f-1") };

      const result = await handlers.undismissTransactionSuggestion(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
      });

      expect(result).toMatchObject({ wasDismissed: false });
      expect(store.getDoc("files", "f-1")).toEqual(before);
    });
  });

  // ==========================================================================
  // Partner billing cycle (#167)
  // ==========================================================================

  describe("billing cycle over the MCP", () => {
    /**
     * A partner's stored cycle in the shape `learnBillingCycle` writes it:
     * one entry per recurrence in each half, plus the resolved effective view.
     */
    function learnedBillingCycle(overrides: Record<string, unknown> = {}) {
      const learned = {
        frequencyDays: 30,
        frequencyConfidence: 80,
        typicalDayOfMonth: 5,
        dayVariance: 2,
        sampleSize: 6,
        learnedAt: new Date("2026-07-05T00:00:00Z"),
        ...overrides,
      };
      const { sampleSize, learnedAt, ...effective } = learned;
      return { learned: [learned], effective: [{ source: "learned", ...effective }] };
    }

    function charge(overrides: Record<string, unknown> = {}) {
      return createTestTransaction({
        userId,
        partnerId: "partner-1",
        amount: -3825,
        currency: "EUR",
        ...overrides,
      });
    }

    describe("get_partner / list_partners", () => {
      it("returns the effective cycle and both halves it was resolved from", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({
          userId,
          name: "Anthropic",
          billingCycle: learnedBillingCycle(),
        }));

        const partner = await handlers.getPartner(userId, "partner-1") as {
          billingCycle: {
            effective: Array<{ source: string; frequencyDays: number }>;
            learned: Array<{ sampleSize: number; learnedAt: string }>;
            declared: unknown[];
          };
        };

        expect(partner.billingCycle.effective).toEqual([
          expect.objectContaining({ source: "learned", frequencyDays: 30, typicalDayOfMonth: 5 }),
        ]);
        expect(partner.billingCycle.learned[0].sampleSize).toBe(6);
        // An instant, not a calendar day — a Timestamp would not survive JSON.
        expect(partner.billingCycle.learned[0].learnedAt).toBe("2026-07-05T00:00:00.000Z");
        expect(partner.billingCycle.declared).toEqual([]);
      });

      it("carries the cycle on list_partners, so no second call per partner is needed", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({
          userId,
          name: "Notion",
          billingCycle: learnedBillingCycle({ frequencyDays: 365 }),
        }));
        store.setDoc("partners", "partner-2", createTestPartner({ userId, name: "Rewe" }));

        const list = await handlers.listPartners(userId, {}) as Array<{
          name: string;
          billingCycle: { effective: Array<{ frequencyDays: number }> } | null;
        }>;

        expect(list[0].billingCycle!.effective[0].frequencyDays).toBe(365);
        // A partner that does not bill on a schedule reads as null, not as an
        // empty hull the caller has to unpack.
        expect(list[1].billingCycle).toBeNull();
      });
    });

    describe("set_partner_billing_cycle", () => {
      it("declares a cycle on a partner with no history behind it", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({ userId, name: "Canva" }));

        const result = await handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: { cadence: "monthly" },
        }) as { billingCycle: { effective: Array<Record<string, unknown>> } };

        expect(result.billingCycle.effective).toEqual([
          { source: "declared", frequencyDays: 30, documentExpectation: "invoice" },
        ]);
        const stored = store.getDoc("partners", "partner-1")!.billingCycle as {
          declared: Array<{ frequencyDays: number }>;
          learned?: unknown;
        };
        expect(stored.declared[0].frequencyDays).toBe(30);
        expect(stored.learned).toBeUndefined();
      });

      it("lets the declaration win over the learned cycle and keeps the learned half visible", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({
          userId,
          name: "Anthropic",
          billingCycle: learnedBillingCycle(),
        }));

        const result = await handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: { cadence: "weekly", documentExpectation: "nothing" },
        }) as {
          billingCycle: {
            effective: Array<{ source: string; frequencyDays: number; documentExpectation: string }>;
            learned: Array<{ frequencyDays: number }>;
            declared: Array<{ frequencyDays: number }>;
          };
        };

        expect(result.billingCycle.effective[0]).toMatchObject({
          source: "declared",
          frequencyDays: 7,
          documentExpectation: "nothing",
          // The declaration inherits what was actually observed.
          typicalDayOfMonth: 5,
        });
        expect(result.billingCycle.learned[0].frequencyDays).toBe(30);
        expect(result.billingCycle.declared[0].frequencyDays).toBe(7);
      });

      it("takes an interval with no name, and an expected amount band in the billed currency", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({ userId, name: "OpenAI" }));

        const result = await handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: {
            frequencyDays: 14,
            expectedAmountMin: 1900,
            expectedAmountMax: 2100,
            currency: "usd",
          },
        }) as { billingCycle: { declared: Array<Record<string, unknown>> } };

        expect(result.billingCycle.declared[0]).toEqual({
          frequencyDays: 14,
          // Nominal amount of the band, derived from the range it was given as.
          amountBand: 2000,
          expectedAmountMin: 1900,
          expectedAmountMax: 2100,
          currency: "USD",
          documentExpectation: "invoice",
        });
      });

      it("declares one recurrence per amount band", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({ userId, name: "Anthropic" }));

        const result = await handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: [
            { cadence: "weekly", amountBand: 3825 },
            { cadence: "monthly", amountBand: 9000 },
          ],
        }) as { billingCycle: { effective: Array<{ amountBand: number; frequencyDays: number }> } };

        expect(result.billingCycle.effective.map((e) => [e.amountBand, e.frequencyDays])).toEqual([
          [3825, 7],
          [9000, 30],
        ]);
      });

      it("clears the declaration on null and falls back to the learned cycle", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({
          userId,
          name: "Anthropic",
          billingCycle: learnedBillingCycle(),
        }));
        await handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: { cadence: "weekly" },
        });

        const cleared = await handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: null,
        }) as {
          billingCycle: {
            effective: Array<{ source: string; frequencyDays: number }>;
            declared: unknown[];
            learned: Array<{ frequencyDays: number }>;
          };
        };

        expect(cleared.billingCycle.declared).toEqual([]);
        expect(cleared.billingCycle.effective[0]).toMatchObject({ source: "learned", frequencyDays: 30 });
        expect(cleared.billingCycle.learned[0].frequencyDays).toBe(30);
        expect((store.getDoc("partners", "partner-1")!.billingCycle as { declared?: unknown }).declared)
          .toBeUndefined();
      });

      it("drops the field entirely when there is nothing learned to fall back to", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({ userId, name: "Vidio" }));
        await handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: { cadence: "monthly" },
        });

        const cleared = await handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: null,
        }) as { billingCycle: unknown };

        expect(cleared.billingCycle).toBeNull();
        expect(store.getDoc("partners", "partner-1")!.billingCycle).toBeUndefined();
      });

      it("refuses a declaration it cannot store", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({ userId }));
        store.setDoc("partners", "partner-2", createTestPartner({ userId: otherUserId }));

        await expect(handlers.setPartnerBillingCycle(userId, { declared: null }))
          .rejects.toThrow("partnerId is required");
        await expect(handlers.setPartnerBillingCycle(userId, { partnerId: "partner-2", declared: null }))
          .rejects.toThrow("Partner not found");
        await expect(handlers.setPartnerBillingCycle(userId, { partnerId: "partner-1" }))
          .rejects.toThrow("declared is required");
        await expect(handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: { cadence: "fortnightly" },
        })).rejects.toThrow("declared.cadence must be one of");
        await expect(handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: { typicalDayOfMonth: 3 },
        })).rejects.toThrow("declared needs either a cadence or frequencyDays");
        await expect(handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: { cadence: "monthly", frequencyDays: 31 },
        })).rejects.toThrow('declared.cadence "monthly" is 30 days');
        await expect(handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: [{ cadence: "weekly" }, { cadence: "monthly" }],
        })).rejects.toThrow("each declared recurrence needs its own amountBand");
      });
    });

    describe("list_recurring_partners", () => {
      it("returns the cycle, the last charge, the next expected window and coverage", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({
          userId,
          name: "Anthropic",
          website: "https://anthropic.com",
          billingCycle: learnedBillingCycle(),
        }));
        store.setDoc("transactions", "tx-1", charge({ date: new Date("2026-05-05"), fileIds: ["file-1"] }));
        store.setDoc("transactions", "tx-2", charge({ date: new Date("2026-06-05"), noReceiptCategoryId: "cat-1" }));
        store.setDoc("transactions", "tx-3", charge({ date: new Date("2026-07-05") }));

        const result = await handlers.listRecurringPartners(userId, {
          dateFrom: "2026-01-01",
          dateTo: "2026-07-31",
        }) as {
          partners: Array<{
            partnerId: string;
            name: string;
            website: string;
            billingCycle: { effective: Array<{ frequencyDays: number }> };
            lastCharge: Record<string, unknown>;
            nextExpected: Record<string, unknown>;
            coverage: Record<string, number>;
            recurrences: Array<Record<string, unknown>>;
          }>;
          nextCursor: string | null;
          count: number;
          dateFrom: string;
          dateTo: string;
        };

        expect(result.count).toBe(1);
        const partner = result.partners[0];
        expect(partner).toMatchObject({
          partnerId: "partner-1",
          name: "Anthropic",
          website: "https://anthropic.com",
        });
        expect(partner.billingCycle.effective[0].frequencyDays).toBe(30);
        expect(partner.lastCharge).toEqual({
          transactionId: "tx-3",
          date: "2026-07-05",
          amount: 3825,
          currency: "EUR",
          amountEur: 3825,
          hasFile: false,
          hasCategory: false,
          noReceiptCategoryId: null,
        });
        // 2026-07-05 plus the learned 30 days, plus or minus the day variance.
        expect(partner.nextExpected).toEqual({
          expectedAt: "2026-08-04",
          from: "2026-08-02",
          to: "2026-08-06",
          varianceDays: 2,
        });
        expect(partner.coverage).toEqual({ charges: 3, withFile: 1, withCategory: 1, missing: 1 });
        expect(partner.recurrences).toHaveLength(1);
        expect(partner.recurrences[0]).toMatchObject({
          amountBand: null,
          source: "learned",
          frequencyDays: 30,
          documentExpectation: "invoice",
          coverage: { charges: 3, missing: 1 },
        });
        expect(result).toMatchObject({
          nextCursor: null,
          dateFrom: "2026-01-01",
          dateTo: "2026-07-31",
        });
      });

      it("counts coverage inside the range, and still reports the last charge seen", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({
          userId,
          name: "Anthropic",
          billingCycle: learnedBillingCycle(),
        }));
        store.setDoc("transactions", "tx-1", charge({ date: new Date("2025-12-05") }));
        store.setDoc("transactions", "tx-2", charge({ date: new Date("2026-06-05") }));
        store.setDoc("transactions", "tx-3", charge({ date: new Date("2026-07-05") }));

        const result = await handlers.listRecurringPartners(userId, {
          dateFrom: "2026-06-01",
          dateTo: "2026-07-05",
        }) as { partners: Array<{ coverage: { charges: number }; lastCharge: { transactionId: string } }> };

        expect(result.partners[0].coverage.charges).toBe(2);
        // dateTo is inclusive: the charge booked on the last day counts.
        expect(result.partners[0].lastCharge.transactionId).toBe("tx-3");
      });

      it("reports the amount in the currency the bank says it charged, and in EUR", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({
          userId,
          name: "OpenAI",
          billingCycle: learnedBillingCycle(),
        }));
        store.setDoc("transactions", "tx-1", charge({
          date: new Date("2026-07-05"),
          amount: -1847,
          currency: "EUR",
          _original: {
            date: "05.07.2026",
            amount: "-18,47",
            rawRow: { "Original Amount": "20.00", "Original Currency": "USD", "Exchange Rate": "0.9235" },
          },
        }));

        const result = await handlers.listRecurringPartners(userId, {}) as {
          partners: Array<{ lastCharge: { amount: number; currency: string; amountEur: number } }>;
        };

        expect(result.partners[0].lastCharge).toMatchObject({
          amount: 2000,
          currency: "USD",
          amountEur: 1847,
        });
      });

      it("splits the recurrences of a partner that bills in more than one band", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({
          userId,
          name: "Anthropic",
          billingCycle: {
            learned: [
              { amountBand: 3825, frequencyDays: 7, frequencyConfidence: 90, sampleSize: 8, learnedAt: new Date("2026-07-06T00:00:00Z") },
              { amountBand: 9000, frequencyDays: 30, frequencyConfidence: 85, sampleSize: 4, learnedAt: new Date("2026-07-06T00:00:00Z") },
            ],
            effective: [
              { amountBand: 3825, source: "learned", frequencyDays: 7, frequencyConfidence: 90 },
              { amountBand: 9000, source: "learned", frequencyDays: 30, frequencyConfidence: 85 },
            ],
          },
        }));
        store.setDoc("transactions", "tx-1", charge({ date: new Date("2026-06-29"), amount: -3825 }));
        store.setDoc("transactions", "tx-2", charge({ date: new Date("2026-07-06"), amount: -3825, fileIds: ["file-1"] }));
        store.setDoc("transactions", "tx-3", charge({ date: new Date("2026-07-01"), amount: -9000 }));
        // A one-off payment to a recurring vendor: it belongs to no band.
        store.setDoc("transactions", "tx-4", charge({ date: new Date("2026-07-10"), amount: -50000 }));

        const result = await handlers.listRecurringPartners(userId, {
          dateFrom: "2026-06-01",
          dateTo: "2026-07-31",
        }) as {
          partners: Array<{
            lastCharge: { transactionId: string };
            coverage: { charges: number };
            recurrences: Array<{
              amountBand: number;
              frequencyDays: number;
              lastCharge: { transactionId: string };
              nextExpected: { expectedAt: string; varianceDays: number };
              coverage: { charges: number; withFile: number; missing: number };
            }>;
          }>;
        };

        // Counted for the partner, but it is nobody's recurrence.
        expect(result.partners[0].lastCharge.transactionId).toBe("tx-4");
        expect(result.partners[0].coverage.charges).toBe(4);

        const [weekly, monthly] = result.partners[0].recurrences;
        expect(weekly).toMatchObject({
          amountBand: 3825,
          frequencyDays: 7,
          lastCharge: { transactionId: "tx-2" },
          coverage: { charges: 2, withFile: 1, missing: 1 },
        });
        // A weekly recurrence carries no learned day variance; the window
        // falls back to the derivation's tolerance, clamped to half a period.
        expect(weekly.nextExpected).toMatchObject({ expectedAt: "2026-07-13", varianceDays: 3 });
        expect(monthly).toMatchObject({
          amountBand: 9000,
          frequencyDays: 30,
          lastCharge: { transactionId: "tx-3" },
          coverage: { charges: 1, withFile: 0, missing: 1 },
        });
      });

      it("never reports a missing document for a recurrence that produces none", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({ userId, name: "SVS" }));
        await handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: { cadence: "quarterly", documentExpectation: "nothing" },
        });
        store.setDoc("transactions", "tx-1", charge({ date: new Date("2026-07-05") }));

        const result = await handlers.listRecurringPartners(userId, {
          dateFrom: "2026-01-01",
          dateTo: "2026-12-31",
        }) as { partners: Array<{ coverage: { charges: number; missing: number } }> };

        expect(result.partners[0].coverage).toMatchObject({ charges: 1, missing: 0 });
      });

      it("skips partners with no cycle and partners of another user", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({
          userId,
          name: "Anthropic",
          billingCycle: learnedBillingCycle(),
        }));
        store.setDoc("partners", "partner-2", createTestPartner({ userId, name: "Rewe" }));
        store.setDoc("partners", "partner-3", createTestPartner({
          userId: otherUserId,
          name: "Netflix",
          billingCycle: learnedBillingCycle(),
        }));

        const result = await handlers.listRecurringPartners(userId, {}) as {
          partners: Array<{ partnerId: string }>;
        };

        expect(result.partners.map((p) => p.partnerId)).toEqual(["partner-1"]);
      });

      it("pages with a cursor", async () => {
        for (const [id, name] of [["partner-1", "Anthropic"], ["partner-2", "Notion"], ["partner-3", "Vidio"]]) {
          store.setDoc("partners", id, createTestPartner({
            userId,
            name,
            billingCycle: learnedBillingCycle(),
          }));
        }

        const first = await handlers.listRecurringPartners(userId, { limit: 2 }) as {
          partners: Array<{ name: string }>;
          nextCursor: string | null;
        };
        expect(first.partners.map((p) => p.name)).toEqual(["Anthropic", "Notion"]);
        expect(first.nextCursor).toBe("partner-2");

        const second = await handlers.listRecurringPartners(userId, {
          limit: 2,
          cursor: first.nextCursor!,
        }) as { partners: Array<{ name: string }>; nextCursor: string | null };
        expect(second.partners.map((p) => p.name)).toEqual(["Vidio"]);
        expect(second.nextCursor).toBeNull();
      });

      it("has no charge and no window for a partner declared recurring from day one", async () => {
        store.setDoc("partners", "partner-1", createTestPartner({ userId, name: "Canva" }));
        await handlers.setPartnerBillingCycle(userId, {
          partnerId: "partner-1",
          declared: { cadence: "monthly" },
        });

        const result = await handlers.listRecurringPartners(userId, {}) as {
          partners: Array<{ lastCharge: unknown; nextExpected: unknown; coverage: { charges: number } }>;
        };

        expect(result.partners[0]).toMatchObject({
          lastCharge: null,
          nextExpected: null,
          coverage: { charges: 0, withFile: 0, withCategory: 0, missing: 0 },
        });
      });

      it("rejects a malformed date boundary rather than widening the range", async () => {
        await expect(handlers.listRecurringPartners(userId, { dateFrom: "01.01.2026" }))
          .rejects.toThrow("dateFrom must be a calendar day");
        await expect(handlers.listRecurringPartners(userId, { dateTo: "2026-13-01" }))
          .rejects.toThrow("dateTo must be a calendar day");
      });
    });
  });
  // ==========================================================================
  // Extraction retry (fork #74)
  // ==========================================================================

  describe("retryFileExtractionTool", () => {
    beforeEach(() => {
      extraction.runExtraction.mockReset();
      extraction.runExtraction.mockResolvedValue({ success: true, duration: 12 });
    });

    it("re-extracts a file whose extraction errored", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({ userId, extractionComplete: true, extractionError: "boom" })
      );

      const result = await handlers.retryFileExtractionTool(userId, { fileId: "f-1" });

      expect(result).toMatchObject({ success: true, fileId: "f-1", duration: 12 });
      expect(extraction.runExtraction).toHaveBeenCalledTimes(1);
      // The reset is written before extraction runs, and matching is re-armed.
      const file = store.getDoc("files", "f-1") as Record<string, unknown>;
      expect(file.extractionError).toBeNull();
      expect(file.partnerMatchComplete).toBe(false);
      expect(file.transactionSuggestions).toEqual([]);
    });

    it("refuses a clean extraction without force, and runs it with force", async () => {
      store.setDoc(
        "files",
        "f-2",
        createTestFile({ userId, extractionComplete: true, extractionError: null })
      );

      await expect(handlers.retryFileExtractionTool(userId, { fileId: "f-2" })).rejects.toThrow(
        /^ALREADY_EXTRACTED:/
      );
      expect(extraction.runExtraction).not.toHaveBeenCalled();

      await handlers.retryFileExtractionTool(userId, { fileId: "f-2", force: true });
      expect(extraction.runExtraction).toHaveBeenCalledTimes(1);
    });

    // #184: the whole point — a sweep must not re-roll the model over a value a
    // person decided, and force cannot be the flag that protects it because
    // every sweep (and the UI button) passes force already.
    it("refuses a hand-corrected file, naming the fields, even when forced", async () => {
      store.setDoc(
        "files",
        "f-corrected",
        createTestFile({
          userId,
          extractionComplete: true,
          extractedVatPercent: 0,
          extractionCorrectedFields: { vatPercent: new Date(), amount: new Date() },
        })
      );

      await expect(
        handlers.retryFileExtractionTool(userId, { fileId: "f-corrected" })
      ).rejects.toThrow(/^HAND_CORRECTED: .*\(amount, vatPercent\)/);
      await expect(
        handlers.retryFileExtractionTool(userId, { fileId: "f-corrected", force: true })
      ).rejects.toThrow(/^HAND_CORRECTED:/);

      expect(extraction.runExtraction).not.toHaveBeenCalled();
      // A refused retry leaves the record alone — the corrected rate is intact.
      expect((store.getDoc("files", "f-corrected") as Record<string, unknown>).extractedVatPercent).toBe(0);
    });

    it("re-extracts a corrected file when the caller says so per file", async () => {
      store.setDoc(
        "files",
        "f-corrected",
        createTestFile({
          userId,
          extractionComplete: true,
          extractionCorrectedFields: { vatPercent: new Date() },
        })
      );

      // Both flags: force answers "it already extracted cleanly",
      // overwriteCorrections answers "and a person corrected it".
      await handlers.retryFileExtractionTool(userId, {
        fileId: "f-corrected",
        force: true,
        overwriteCorrections: true,
      });

      expect(extraction.runExtraction).toHaveBeenCalledTimes(1);
      // The marker is not cleared: a person did rule on this document, and the
      // file stays on the next sweep's exclusion list rather than falling off
      // it because it was overridden once.
      const marker = (store.getDoc("files", "f-corrected") as Record<string, unknown>)
        .extractionCorrectedFields as Record<string, unknown>;
      expect(Object.keys(marker)).toEqual(["vatPercent"]);
    });

    it("keeps a manual partner assignment across the reset", async () => {
      store.setDoc(
        "files",
        "f-3",
        createTestFile({
          userId,
          extractionComplete: true,
          extractionError: "boom",
          partnerId: "p-manual",
          partnerMatchedBy: "manual",
        })
      );

      await handlers.retryFileExtractionTool(userId, { fileId: "f-3" });

      const file = store.getDoc("files", "f-3") as Record<string, unknown>;
      expect(file.partnerId).toBe("p-manual");
      expect(file.partnerMatchedBy).toBe("manual");
    });

    it("refuses another user's file without touching it", async () => {
      store.setDoc(
        "files",
        "f-4",
        createTestFile({ userId: otherUserId, extractionComplete: true, extractionError: "boom" })
      );

      await expect(handlers.retryFileExtractionTool(userId, { fileId: "f-4" })).rejects.toThrow(
        /^ACCESS_DENIED:/
      );
      expect(extraction.runExtraction).not.toHaveBeenCalled();
      expect((store.getDoc("files", "f-4") as Record<string, unknown>).extractionError).toBe("boom");
    });

    it("distinguishes a missing file from one that is not the caller's", async () => {
      await expect(handlers.retryFileExtractionTool(userId, { fileId: "nope" })).rejects.toThrow(
        /^NOT_FOUND:/
      );
      await expect(handlers.retryFileExtractionTool(userId, {})).rejects.toThrow(
        "fileId is required"
      );
    });

    it("stamps a failed extraction on the document and reports it", async () => {
      store.setDoc(
        "files",
        "f-5",
        createTestFile({ userId, extractionComplete: true, extractionError: "boom" })
      );
      extraction.runExtraction.mockRejectedValue(new Error("No such object: missing/nope.pdf"));

      await expect(handlers.retryFileExtractionTool(userId, { fileId: "f-5" })).rejects.toThrow(
        /^EXTRACTION_FAILED: No such object/
      );

      const file = store.getDoc("files", "f-5") as Record<string, unknown>;
      expect(file.extractionComplete).toBe(true);
      expect(file.extractionError).toBe("No such object: missing/nope.pdf");
    });

    it("is reachable through the dispatcher, behind the aiExtraction gate", async () => {
      store.setDoc(
        "files",
        "f-6",
        createTestFile({ userId, extractionComplete: true, extractionError: "boom" })
      );

      // Extraction spends an AI call, so the tool is gated like the other AI
      // tools. On the free plan the dispatcher refuses it before the handler.
      await expect(
        handlers.handleTool(userId, "retry_file_extraction", { fileId: "f-6" })
      ).rejects.toThrow(/requires the "aiExtraction" feature/);
      expect(extraction.runExtraction).not.toHaveBeenCalled();

      store.setDoc("subscriptions", userId, { plan: "smart" });
      await handlers.handleTool(userId, "retry_file_extraction", { fileId: "f-6" });
      expect(extraction.runExtraction).toHaveBeenCalledTimes(1);
    });
  });
});
