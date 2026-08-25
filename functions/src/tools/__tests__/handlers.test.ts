/**
 * Tool Registry Handler Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  store,
  createMockFirestore,
  createTestTransaction,
  createTestFile,
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
    },
    Timestamp: MockTimestamp,
  };
});

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

      expect(result).toHaveLength(2);
    });

    it("should exclude deleted files", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId }));
      store.setDoc("files", "f-2", createTestFile({ userId, deletedAt: new Date() }));

      const result = await handlers.listFiles(userId, {});

      expect(result).toHaveLength(1);
    });

    it("should filter by hasConnections", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, transactionIds: ["tx-1"] }));
      store.setDoc("files", "f-2", createTestFile({ userId, transactionIds: [] }));

      const connected = await handlers.listFiles(userId, { hasConnections: true });
      const unconnected = await handlers.listFiles(userId, { hasConnections: false });

      expect(connected).toHaveLength(1);
      expect(unconnected).toHaveLength(1);
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
      expect(Array.isArray(result)).toBe(true);
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

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("f-1");
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

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("f-2");
    });

    it("should exclude isNotInvoice files", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId }));
      store.setDoc("files", "f-2", createTestFile({ userId, isNotInvoice: true }));

      const result = await handlers.listFiles(userId, {});

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("f-1");
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

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("f-1");
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
});
