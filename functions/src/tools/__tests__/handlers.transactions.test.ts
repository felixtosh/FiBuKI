/**
 * Tool handler tests: transaction listing, reading, updating and the receipt-only queue.
 *
 * One of four files split from the former handlers.test.ts by area; shared
 * mocks and setup live in handlers-harness.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { store, createTestTransaction, createTestFile } from "../../test/setup";
import { userId, otherUserId } from "./handlers-harness";

// vi.mock is hoisted per file, so the factories are imported inside it.
const extraction = vi.hoisted(() => ({ runExtraction: vi.fn() }));
vi.mock("firebase-admin/firestore", async () => (await import("./handlers-harness")).firestoreMock());
vi.mock("../../extraction/extractionCore", async () =>
  (await import("./handlers-harness")).extractionCoreMock(extraction),
);
vi.mock("firebase-functions/params", async () => (await import("./handlers-harness")).paramsMock());

// Import handlers after mocking
const handlers = await import("../handlers");

describe("Tool Registry Handlers: Transactions", () => {
  beforeEach(() => {
    store.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

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

    // #214: the goods/service answer to the foreign-regime review.
    it("writes foreignSupplyKind and clears it with null", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId }));

      await handlers.updateTransaction(userId, {
        transactionId: "tx-1",
        foreignSupplyKind: "goods",
      });
      expect(store.getDoc("transactions", "tx-1")?.foreignSupplyKind).toBe("goods");

      await handlers.updateTransaction(userId, {
        transactionId: "tx-1",
        foreignSupplyKind: null,
      });
      expect(store.getDoc("transactions", "tx-1")?.foreignSupplyKind).toBeNull();
    });

    it("rejects a foreignSupplyKind outside goods/service/null", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId }));

      await expect(
        handlers.updateTransaction(userId, {
          transactionId: "tx-1",
          foreignSupplyKind: "wares",
        })
      ).rejects.toThrow(/goods.*service/);
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

    // #165: a live Accepted Receipt ruling closes the queue entry without
    // touching the documentation state - the line stays receipt-only, it just
    // stops being work.
    describe("Accepted Receipt exclusion (#165)", () => {
      const liveAcceptance = (fileIds: string[]) => ({
        by: userId,
        at: new Date("2026-09-27T10:00:00Z"),
        reason: "Marketplace seller charges no VAT; nothing chaseable",
        fileIds,
      });

      it("excludes a line with a live ruling and reports it in acceptedCount", async () => {
        store.setDoc(
          "transactions",
          "tx-ruled",
          createTestTransaction({
            userId,
            fileIds: ["f-1"],
            documentationState: "receipt-only",
            receiptOnlyAcceptance: liveAcceptance(["f-1"]),
          })
        );
        store.setDoc(
          "transactions",
          "tx-open",
          createTestTransaction({ userId, fileIds: ["f-2"], documentationState: "receipt-only" })
        );

        const result = await handlers.listTransactionsMissingInvoice(userId, {});

        expect(result.transactions.map((t) => t.id)).toEqual(["tx-open"]);
        expect(result.acceptedCount).toBe(1);
      });

      it("keeps a line whose ruling went stale because the files changed", async () => {
        store.setDoc(
          "transactions",
          "tx-stale",
          createTestTransaction({
            userId,
            fileIds: ["f-1", "f-new"],
            documentationState: "receipt-only",
            receiptOnlyAcceptance: liveAcceptance(["f-1"]),
          })
        );

        const result = await handlers.listTransactionsMissingInvoice(userId, {});

        expect(result.transactions.map((t) => t.id)).toEqual(["tx-stale"]);
        expect(result.acceptedCount).toBe(0);
      });
    });
  });

  describe("acceptReceiptOnly (#165)", () => {
    const receiptOnlyTx = (overrides: Record<string, unknown> = {}) =>
      createTestTransaction({
        userId,
        fileIds: ["f-receipt"],
        documentationState: "receipt-only",
        ...overrides,
      });

    it("records who ruled, when, why, and over which files", async () => {
      store.setDoc("transactions", "tx-1", receiptOnlyTx());

      const result = await handlers.acceptReceiptOnly(userId, {
        transactionId: "tx-1",
        reason: "Marketplace seller charges no VAT; no § 11 invoice obtainable",
      });

      expect(result.success).toBe(true);
      const updated = store.getDoc("transactions", "tx-1");
      const acceptance = updated?.receiptOnlyAcceptance as Record<string, unknown>;
      expect(acceptance.by).toBe(userId);
      expect(acceptance.reason).toBe(
        "Marketplace seller charges no VAT; no § 11 invoice obtainable"
      );
      expect(acceptance.fileIds).toEqual(["f-receipt"]);
      expect(acceptance.at).toBeDefined();
    });

    it("never touches documentationState or isComplete", async () => {
      store.setDoc("transactions", "tx-1", receiptOnlyTx({ isComplete: false }));

      await handlers.acceptReceiptOnly(userId, { transactionId: "tx-1", reason: "ruled" });

      const updated = store.getDoc("transactions", "tx-1");
      expect(updated?.documentationState).toBe("receipt-only");
      expect(updated?.isComplete).toBe(false);
    });

    it("refuses a transaction that is not receipt-only", async () => {
      store.setDoc(
        "transactions",
        "tx-1",
        createTestTransaction({ userId, documentationState: "invoice" })
      );

      await expect(
        handlers.acceptReceiptOnly(userId, { transactionId: "tx-1", reason: "x" })
      ).rejects.toThrow(/receipt-only/);
    });

    it("requires a reason - the ruling IS the record", async () => {
      store.setDoc("transactions", "tx-1", receiptOnlyTx());

      await expect(
        handlers.acceptReceiptOnly(userId, { transactionId: "tx-1" })
      ).rejects.toThrow(/reason/);
      await expect(
        handlers.acceptReceiptOnly(userId, { transactionId: "tx-1", reason: "   " })
      ).rejects.toThrow(/reason/);
    });

    it("warns - never blocks - when input VAT is claimed on the bare receipt", async () => {
      store.setDoc("transactions", "tx-1", receiptOnlyTx({ vatRate: 20, vatAmount: 400 }));

      const result = await handlers.acceptReceiptOnly(userId, {
        transactionId: "tx-1",
        reason: "ruled closed",
      });

      expect(result.success).toBe(true);
      expect(result.warning).toMatch(/input VAT|Vorsteuer/i);
      expect(store.getDoc("transactions", "tx-1")?.receiptOnlyAcceptance).toBeDefined();
    });

    it("warns when a connected receipt itself prints a VAT amount", async () => {
      store.setDoc(
        "files",
        "f-receipt",
        createTestFile({ userId, documentType: "receipt", extractedVatAmount: 360 })
      );
      store.setDoc("transactions", "tx-1", receiptOnlyTx());

      const result = await handlers.acceptReceiptOnly(userId, {
        transactionId: "tx-1",
        reason: "ruled closed",
      });

      expect(result.warning).toMatch(/input VAT|Vorsteuer/i);
    });

    it("returns no warning when nothing claims VAT on the line", async () => {
      store.setDoc("files", "f-receipt", createTestFile({ userId, documentType: "receipt" }));
      store.setDoc("transactions", "tx-1", receiptOnlyTx());

      const result = await handlers.acceptReceiptOnly(userId, {
        transactionId: "tx-1",
        reason: "ruled closed",
      });

      expect(result.warning).toBeUndefined();
    });

    it("revokes a recorded ruling", async () => {
      store.setDoc(
        "transactions",
        "tx-1",
        receiptOnlyTx({
          receiptOnlyAcceptance: {
            by: userId,
            at: new Date(),
            reason: "ruled",
            fileIds: ["f-receipt"],
          },
        })
      );

      const result = await handlers.acceptReceiptOnly(userId, {
        transactionId: "tx-1",
        revoke: true,
      });

      expect(result.success).toBe(true);
      expect(store.getDoc("transactions", "tx-1")?.receiptOnlyAcceptance).toBeNull();
    });

    it("refuses to revoke where nothing was recorded", async () => {
      store.setDoc("transactions", "tx-1", receiptOnlyTx());

      await expect(
        handlers.acceptReceiptOnly(userId, { transactionId: "tx-1", revoke: true })
      ).rejects.toThrow(/no Accepted Receipt/i);
    });

    it("never touches another user's transaction", async () => {
      store.setDoc(
        "transactions",
        "tx-theirs",
        createTestTransaction({ userId: otherUserId, documentationState: "receipt-only" })
      );

      await expect(
        handlers.acceptReceiptOnly(userId, { transactionId: "tx-theirs", reason: "x" })
      ).rejects.toThrow("Transaction not found");
    });

    it("is reachable through the dispatcher under its tool name", async () => {
      store.setDoc("transactions", "tx-1", receiptOnlyTx());

      const result = (await handlers.handleTool(userId, "accept_receipt_only", {
        transactionId: "tx-1",
        reason: "ruled closed",
      })) as { success: boolean };

      expect(result.success).toBe(true);
    });
  });

  describe("acceptPartialPayment (#554)", () => {
    /** A split bill: 100,00 + 10,00 tip, 55,00 paid. */
    const seedSplitBill = (txOver: Record<string, unknown> = {}) => {
      store.setDoc(
        "files",
        "f-bill",
        createTestFile({ userId, extractedAmount: 10000, extractedTipAmount: 1000 })
      );
      store.setDoc(
        "transactions",
        "tx-1",
        createTestTransaction({ userId, amount: -5500, fileIds: ["f-bill"], ...txOver })
      );
    };

    it("records the ruling over the figures as they stand", async () => {
      seedSplitBill();

      const result = await handlers.acceptPartialPayment(userId, {
        transactionId: "tx-1",
        reason: "Split the bill, paid my half",
      });

      expect(result).toEqual({ success: true, transactionId: "tx-1" });
      const ruling = store.getDoc("transactions", "tx-1")
        ?.partialPaymentAcceptance as Record<string, unknown>;
      expect(ruling.by).toBe(userId);
      expect(ruling.bankAmount).toBe(-5500);
      expect(ruling.files).toEqual([{ id: "f-bill", total: 10000, tip: 1000 }]);
    });

    it("never touches the files, the tip or isComplete", async () => {
      seedSplitBill({ isComplete: true });

      await handlers.acceptPartialPayment(userId, { transactionId: "tx-1", reason: "split" });

      expect(store.getDoc("files", "f-bill")?.extractedTipAmount).toBe(1000);
      expect(store.getDoc("transactions", "tx-1")?.isComplete).toBe(true);
    });

    it("requires a reason", async () => {
      seedSplitBill();

      await expect(
        handlers.acceptPartialPayment(userId, { transactionId: "tx-1" })
      ).rejects.toThrow(/reason/);
    });

    it("revokes with revoke: true", async () => {
      seedSplitBill();
      await handlers.acceptPartialPayment(userId, { transactionId: "tx-1", reason: "split" });

      await handlers.acceptPartialPayment(userId, { transactionId: "tx-1", revoke: true });

      expect(store.getDoc("transactions", "tx-1")?.partialPaymentAcceptance).toBeNull();
    });

    it("reads another user's transaction as not found", async () => {
      store.setDoc(
        "transactions",
        "tx-theirs",
        createTestTransaction({ userId: otherUserId, amount: -5500 })
      );

      await expect(
        handlers.acceptPartialPayment(userId, { transactionId: "tx-theirs", reason: "x" })
      ).rejects.toThrow("Transaction not found");
      expect(store.getDoc("transactions", "tx-theirs")?.partialPaymentAcceptance).toBeUndefined();
    });

    it("is reachable through the dispatcher under its tool name", async () => {
      seedSplitBill();

      const result = (await handlers.handleTool(userId, "accept_partial_payment", {
        transactionId: "tx-1",
        reason: "split",
      })) as { success: boolean };

      expect(result.success).toBe(true);
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
});
