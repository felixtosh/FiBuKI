/**
 * Transaction Cloud Functions Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  setupTestHooks,
  store,
  createTestContext,
  createTestTransaction,
  createMockFirestore,
} from "./setup";

// Mock the createCallable wrapper to extract the handler
vi.mock("../utils/createCallable", () => ({
  createCallable: <TReq, TRes>(
    _config: { name: string },
    handler: (ctx: unknown, data: TReq) => Promise<TRes>
  ) => handler,
  HttpsError: class HttpsError extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
}));

// Import handlers after mocking
const { updateTransactionCallable } = await import("../transactions/updateTransaction");
const { bulkUpdateTransactionsCallable } = await import("../transactions/bulkUpdateTransactions");
const { acceptReceiptOnlyCallable } = await import("../transactions/acceptReceiptOnly");
const { acceptPartialPaymentCallable } = await import("../transactions/acceptPartialPayment");

describe("Transaction Cloud Functions", () => {
  setupTestHooks();

  describe("updateTransaction", () => {
    it("should update a transaction successfully", async () => {
      // Setup
      const userId = "user-123";
      const txId = "tx-456";
      store.setDoc("transactions", txId, createTestTransaction({ userId }));

      const ctx = {
        userId,
        db: createMockFirestore(),
        request: { auth: { uid: userId }, data: {} },
        logAIUsage: vi.fn(),
      };

      // Act
      const result = await updateTransactionCallable(ctx as any, {
        id: txId,
        data: { foreignSupplyKind: "service" },
      });

      // Assert
      expect(result.success).toBe(true);
      const updated = store.getDoc("transactions", txId);
      expect(updated?.foreignSupplyKind).toBe("service");
    });

    it("should reject update for non-existent transaction", async () => {
      const userId = "user-123";
      const ctx = {
        userId,
        db: createMockFirestore(),
        request: { auth: { uid: userId }, data: {} },
        logAIUsage: vi.fn(),
      };

      await expect(
        updateTransactionCallable(ctx as any, {
          id: "non-existent",
          data: { foreignSupplyKind: "goods" },
        })
      ).rejects.toThrow("Transaction not found");
    });

    it("should reject update for transaction owned by another user", async () => {
      const txId = "tx-456";
      store.setDoc("transactions", txId, createTestTransaction({ userId: "other-user" }));

      const ctx = {
        userId: "user-123",
        db: createMockFirestore(),
        request: { auth: { uid: "user-123" }, data: {} },
        logAIUsage: vi.fn(),
      };

      await expect(
        updateTransactionCallable(ctx as any, {
          id: txId,
          data: { foreignSupplyKind: "goods" },
        })
      ).rejects.toThrow("Access denied");
    });

    // #214: the goods/service answer to the foreign-regime review flag.
    it("writes foreignSupplyKind and rejects values outside the set", async () => {
      const userId = "user-123";
      const txId = "tx-456";
      store.setDoc("transactions", txId, createTestTransaction({ userId }));

      const ctx = {
        userId,
        db: createMockFirestore(),
        request: { auth: { uid: userId }, data: {} },
        logAIUsage: vi.fn(),
      };

      await updateTransactionCallable(ctx as any, {
        id: txId,
        data: { foreignSupplyKind: "goods" },
      });
      expect(store.getDoc("transactions", txId)?.foreignSupplyKind).toBe("goods");

      await updateTransactionCallable(ctx as any, {
        id: txId,
        data: { foreignSupplyKind: null },
      });
      expect(store.getDoc("transactions", txId)?.foreignSupplyKind).toBeNull();

      await expect(
        updateTransactionCallable(ctx as any, {
          id: txId,
          data: { foreignSupplyKind: "wares" as never },
        })
      ).rejects.toThrow(/goods.*service/);
    });

    // #565: what a 0% sale is, the income-side mirror.
    it("writes saleSupplyKind, clears it with null, and rejects values outside the set", async () => {
      const userId = "user-123";
      const txId = "tx-456";
      store.setDoc("transactions", txId, createTestTransaction({ userId }));

      const ctx = {
        userId,
        db: createMockFirestore(),
        request: { auth: { uid: userId }, data: {} },
        logAIUsage: vi.fn(),
      };

      await updateTransactionCallable(ctx as any, {
        id: txId,
        data: { saleSupplyKind: "service-non-eu" },
      });
      expect(store.getDoc("transactions", txId)?.saleSupplyKind).toBe("service-non-eu");

      await updateTransactionCallable(ctx as any, { id: txId, data: { saleSupplyKind: null } });
      expect(store.getDoc("transactions", txId)?.saleSupplyKind).toBeNull();

      await expect(
        updateTransactionCallable(ctx as any, {
          id: txId,
          data: { saleSupplyKind: "service" as never },
        })
      ).rejects.toThrow(/service-eu/);
    });
  });

  describe("acceptReceiptOnly (#165)", () => {
    const userId = "user-123";
    const makeCtx = () => ({
      userId,
      db: createMockFirestore(),
      request: { auth: { uid: userId }, data: {} },
      logAIUsage: vi.fn(),
    });

    it("records the ruling on a receipt-only transaction", async () => {
      store.setDoc(
        "transactions",
        "tx-1",
        createTestTransaction({
          userId,
          fileIds: ["f-receipt"],
          documentationState: "receipt-only",
        })
      );

      const result = await acceptReceiptOnlyCallable(makeCtx() as any, {
        id: "tx-1",
        action: "accept",
        reason: "Marketplace seller charges no VAT; no § 11 invoice obtainable",
      });

      expect(result.success).toBe(true);
      const acceptance = store.getDoc("transactions", "tx-1")
        ?.receiptOnlyAcceptance as Record<string, unknown>;
      expect(acceptance.by).toBe(userId);
      expect(acceptance.fileIds).toEqual(["f-receipt"]);
      expect(acceptance.at).toBeDefined();
    });

    it("refuses a transaction that is not receipt-only", async () => {
      store.setDoc(
        "transactions",
        "tx-1",
        createTestTransaction({ userId, documentationState: "invoice" })
      );

      await expect(
        acceptReceiptOnlyCallable(makeCtx() as any, {
          id: "tx-1",
          action: "accept",
          reason: "x",
        })
      ).rejects.toThrow(/receipt-only/);
    });

    it("warns, never blocks, when the line claims input VAT", async () => {
      store.setDoc(
        "transactions",
        "tx-1",
        createTestTransaction({
          userId,
          fileIds: [],
          documentationState: "receipt-only",
          vatRate: 20,
          vatAmount: 400,
        })
      );

      const result = await acceptReceiptOnlyCallable(makeCtx() as any, {
        id: "tx-1",
        action: "accept",
        reason: "ruled closed",
      });

      expect(result.success).toBe(true);
      expect(result.warning).toMatch(/input VAT|Vorsteuer/i);
    });

    it("revokes a recorded ruling", async () => {
      store.setDoc(
        "transactions",
        "tx-1",
        createTestTransaction({
          userId,
          documentationState: "receipt-only",
          receiptOnlyAcceptance: {
            by: userId,
            at: new Date(),
            reason: "ruled",
            fileIds: [],
          },
        })
      );

      const result = await acceptReceiptOnlyCallable(makeCtx() as any, {
        id: "tx-1",
        action: "revoke",
      });

      expect(result.success).toBe(true);
      expect(store.getDoc("transactions", "tx-1")?.receiptOnlyAcceptance).toBeNull();
    });
  });

  describe("acceptPartialPayment (#554)", () => {
    const userId = "user-123";
    const makeCtx = () => ({
      userId,
      db: createMockFirestore(),
      request: { auth: { uid: userId }, data: {} },
      logAIUsage: vi.fn(),
    });

    /** A split bill: 100,00 + 10,00 tip, 55,00 paid. */
    const seedSplitBill = (txOver: Record<string, unknown> = {}, tip: number | null = 1000) => {
      store.setDoc("files", "f-bill", {
        userId,
        extractedAmount: 10000,
        extractedTipAmount: tip,
      });
      store.setDoc(
        "transactions",
        "tx-1",
        createTestTransaction({ userId, amount: -5500, fileIds: ["f-bill"], ...txOver })
      );
    };

    it("records who ruled, why, and over which figures", async () => {
      seedSplitBill();

      const result = await acceptPartialPaymentCallable(makeCtx() as any, {
        id: "tx-1",
        action: "accept",
        reason: "  Split the bill, paid my half  ",
      });

      expect(result.success).toBe(true);
      const ruling = store.getDoc("transactions", "tx-1")
        ?.partialPaymentAcceptance as Record<string, unknown>;
      expect(ruling.by).toBe(userId);
      expect(ruling.reason).toBe("Split the bill, paid my half");
      expect(ruling.bankAmount).toBe(-5500);
      expect(ruling.files).toEqual([{ id: "f-bill", total: 10000, tip: 1000 }]);
      expect(ruling.at).toBeDefined();
    });

    it("requires a reason - the ruling IS the record", async () => {
      seedSplitBill();

      await expect(
        acceptPartialPaymentCallable(makeCtx() as any, { id: "tx-1", action: "accept" })
      ).rejects.toThrow(/reason/);
      await expect(
        acceptPartialPaymentCallable(makeCtx() as any, { id: "tx-1", action: "accept", reason: " " })
      ).rejects.toThrow(/reason/);
    });

    it("refuses a transaction whose files carry no tip", async () => {
      seedSplitBill({}, null);

      await expect(
        acceptPartialPaymentCallable(makeCtx() as any, {
          id: "tx-1",
          action: "accept",
          reason: "x",
        })
      ).rejects.toThrow(/carry a tip/);
    });

    it("does not read another user's file as carrying a tip", async () => {
      seedSplitBill();
      store.setDoc("files", "f-bill", {
        userId: "someone-else",
        extractedAmount: 10000,
        extractedTipAmount: 1000,
      });

      await expect(
        acceptPartialPaymentCallable(makeCtx() as any, {
          id: "tx-1",
          action: "accept",
          reason: "x",
        })
      ).rejects.toThrow(/carry a tip/);
    });

    it("refuses another user's transaction", async () => {
      seedSplitBill({ userId: "someone-else" });

      await expect(
        acceptPartialPaymentCallable(makeCtx() as any, {
          id: "tx-1",
          action: "accept",
          reason: "x",
        })
      ).rejects.toThrow(/Access denied/);
    });

    it("revokes a recorded ruling, and refuses to revoke nothing", async () => {
      seedSplitBill({
        partialPaymentAcceptance: {
          by: userId,
          at: new Date(),
          reason: "ruled",
          bankAmount: -5500,
          files: [{ id: "f-bill", total: 10000, tip: 1000 }],
        },
      });

      const result = await acceptPartialPaymentCallable(makeCtx() as any, {
        id: "tx-1",
        action: "revoke",
      });

      expect(result.success).toBe(true);
      expect(store.getDoc("transactions", "tx-1")?.partialPaymentAcceptance).toBeNull();
      await expect(
        acceptPartialPaymentCallable(makeCtx() as any, { id: "tx-1", action: "revoke" })
      ).rejects.toThrow(/No Accepted Partial Payment/);
    });
  });

  describe("bulkUpdateTransactions", () => {
    it("should update multiple transactions", async () => {
      const userId = "user-123";
      const txIds = ["tx-1", "tx-2", "tx-3"];

      // Create test transactions
      for (const id of txIds) {
        store.setDoc("transactions", id, createTestTransaction({ userId }));
      }

      const ctx = {
        userId,
        db: createMockFirestore(),
        request: { auth: { uid: userId }, data: {} },
        logAIUsage: vi.fn(),
      };

      // Function expects { ids, data } - same data applied to all IDs
      const result = await bulkUpdateTransactionsCallable(ctx as any, {
        ids: txIds,
        data: { isComplete: true },
      });

      expect(result.success).toBe(3);
      expect(result.failed).toBe(0);

      // Verify all transactions were updated
      for (const id of txIds) {
        const tx = store.getDoc("transactions", id);
        expect(tx?.isComplete).toBe(true);
      }
    });

    it("should skip transactions not owned by user", async () => {
      const userId = "user-123";
      store.setDoc("transactions", "tx-owned", createTestTransaction({ userId }));
      store.setDoc("transactions", "tx-other", createTestTransaction({ userId: "other-user" }));

      const ctx = {
        userId,
        db: createMockFirestore(),
        request: { auth: { uid: userId }, data: {} },
        logAIUsage: vi.fn(),
      };

      // Function expects { ids, data } - same data applied to all IDs
      const result = await bulkUpdateTransactionsCallable(ctx as any, {
        ids: ["tx-owned", "tx-other"],
        data: { isComplete: true },
      });

      // tx-other should fail because user doesn't own it
      expect(result.success).toBe(1);
      expect(result.failed).toBe(1);

      // Verify only owned transaction was updated
      expect(store.getDoc("transactions", "tx-owned")?.isComplete).toBe(true);
      expect(store.getDoc("transactions", "tx-other")?.isComplete).toBeFalsy();
    });
  });

  // #621: both callables write a named set of fields and refuse any other key,
  // so a User cannot hand their own Transaction to someone else or rewrite
  // what the bank import wrote.
  describe("field whitelist", () => {
    const userId = "user-123";
    const makeCtx = () => ({
      userId,
      db: createMockFirestore(),
      request: { auth: { uid: userId }, data: {} },
      logAIUsage: vi.fn(),
    });
    const NEVER_WRITABLE: Record<string, unknown> = {
      userId: "other-user",
      sourceId: "other-source",
      amount: 1_000_000,
      date: new Date("2020-01-01"),
      currency: "USD",
      name: "Rewritten",
      dedupeHash: "rewritten",
      _original: { rewritten: true },
      importJobId: "other-import",
      createdAt: new Date("2020-01-01"),
      updatedAt: new Date("2020-01-01"),
    };

    it.each(Object.entries(NEVER_WRITABLE))("updateTransaction refuses %s", async (field, value) => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId }));
      const before = { ...store.getDoc("transactions", "tx-1") };

      await expect(
        updateTransactionCallable(makeCtx() as any, {
          id: "tx-1",
          data: { foreignSupplyKind: "goods", [field]: value } as never,
        })
      ).rejects.toThrow(`updateTransaction does not write ${field}`);
      expect(store.getDoc("transactions", "tx-1")).toEqual(before);
    });

    it.each(Object.entries(NEVER_WRITABLE))("bulkUpdateTransactions refuses %s", async (field, value) => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId }));
      store.setDoc("transactions", "tx-2", createTestTransaction({ userId }));
      const before = [{ ...store.getDoc("transactions", "tx-1") }, { ...store.getDoc("transactions", "tx-2") }];

      await expect(
        bulkUpdateTransactionsCallable(makeCtx() as any, {
          ids: ["tx-1", "tx-2"],
          data: { isComplete: true, [field]: value } as never,
        })
      ).rejects.toThrow(`bulkUpdateTransactions does not write ${field}`);
      expect([store.getDoc("transactions", "tx-1"), store.getDoc("transactions", "tx-2")]).toEqual(before);
    });

    it("refuses what no live caller sends, the File Connection id list included", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId }));
      const before = { ...store.getDoc("transactions", "tx-1") };

      for (const field of ["fileIds", "description", "isComplete", "partnerId", "noReceiptCategoryId", "vatRate"]) {
        await expect(
          updateTransactionCallable(makeCtx() as any, { id: "tx-1", data: { [field]: "x" } as never })
        ).rejects.toThrow(`updateTransaction does not write ${field}`);
      }
      for (const field of ["partnerMatchConfidence", "noReceiptCategoryConfidence", "vatRate", "fileIds"]) {
        await expect(
          bulkUpdateTransactionsCallable(makeCtx() as any, { ids: ["tx-1"], data: { [field]: 1 } as never })
        ).rejects.toThrow(`bulkUpdateTransactions does not write ${field}`);
      }
      await expect(
        updateTransactionCallable(makeCtx() as any, { id: "tx-1", data: undefined as never })
      ).rejects.toThrow("data must be an object");
      expect(store.getDoc("transactions", "tx-1")).toEqual(before);
    });

    it("bulkUpdateTransactions still takes what the chat agent's tool sends", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId }));
      store.setDoc("partners", "partner-1", { userId, name: "Mine" });
      store.setDoc("noReceiptCategories", "cat-1", { userId, name: "Bank fees", templateId: "bank-fees" });

      const result = await bulkUpdateTransactionsCallable(makeCtx() as any, {
        ids: ["tx-1"],
        data: {
          description: "Bank fees",
          isComplete: true,
          partnerId: "partner-1",
          partnerType: "user",
          partnerMatchedBy: "ai",
          noReceiptCategoryId: "cat-1",
          noReceiptCategoryTemplateId: "bank-fees",
          noReceiptCategoryMatchedBy: "manual",
        },
      });

      expect(result).toMatchObject({ success: 1, failed: 0 });
      expect(store.getDoc("transactions", "tx-1")).toMatchObject({
        userId,
        description: "Bank fees",
        partnerId: "partner-1",
        partnerType: "user",
        noReceiptCategoryId: "cat-1",
      });
    });
  });

  // #621: every user shares one database, so a Partner or category id must be
  // the caller's own (or a Global Partner) before a row may point at it.
  describe("bulkUpdateTransactions references", () => {
    const userId = "user-123";
    const makeCtx = () => ({
      userId,
      db: createMockFirestore(),
      request: { auth: { uid: userId }, data: {} },
      logAIUsage: vi.fn(),
    });
    const bulk = (data: Record<string, unknown>) =>
      bulkUpdateTransactionsCallable(makeCtx() as any, { ids: ["tx-1"], data: data as never });

    beforeEach(() => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId }));
      store.setDoc("partners", "mine", { userId, name: "Mine" });
      store.setDoc("partners", "theirs", { userId: "other-user", name: "Theirs" });
      store.setDoc("globalPartners", "global-1", { name: "Global" });
      store.setDoc("noReceiptCategories", "my-cat", { userId, name: "Mine" });
      store.setDoc("noReceiptCategories", "their-cat", { userId: "other-user", name: "Theirs" });
    });

    it("refuses another user's Partner, as not found, and writes nothing", async () => {
      const before = { ...store.getDoc("transactions", "tx-1") };
      await expect(bulk({ partnerId: "theirs", partnerType: "user" })).rejects.toThrow("Partner not found");
      await expect(bulk({ partnerId: "nope", partnerType: "user" })).rejects.toThrow("Partner not found");
      // A user Partner's id named as Global is looked up among Global Partners.
      await expect(bulk({ partnerId: "theirs", partnerType: "global" })).rejects.toThrow("Partner not found");
      expect(store.getDoc("transactions", "tx-1")).toEqual(before);
    });

    it("refuses another user's no-receipt category, as not found, and writes nothing", async () => {
      const before = { ...store.getDoc("transactions", "tx-1") };
      await expect(bulk({ noReceiptCategoryId: "their-cat" })).rejects.toThrow("No-receipt category not found");
      await expect(bulk({ noReceiptCategoryId: "nope" })).rejects.toThrow("No-receipt category not found");
      expect(store.getDoc("transactions", "tx-1")).toEqual(before);
    });

    it("takes the caller's own Partner, a Global Partner, the caller's category, and clears", async () => {
      await bulk({ partnerId: "mine", partnerType: "user" });
      expect(store.getDoc("transactions", "tx-1")).toMatchObject({ partnerId: "mine", partnerType: "user" });
      await bulk({ partnerId: "global-1", partnerType: "global" });
      expect(store.getDoc("transactions", "tx-1")).toMatchObject({ partnerId: "global-1", partnerType: "global" });
      await bulk({ partnerId: null, partnerType: null });
      expect(store.getDoc("transactions", "tx-1")).toMatchObject({ partnerId: null, partnerType: null });
      await bulk({ noReceiptCategoryId: "my-cat" });
      expect(store.getDoc("transactions", "tx-1")?.noReceiptCategoryId).toBe("my-cat");
      await bulk({ noReceiptCategoryId: null });
      expect(store.getDoc("transactions", "tx-1")?.noReceiptCategoryId).toBeNull();
    });

    it("needs a partnerType with a partnerId, and no partnerType without one", async () => {
      await expect(bulk({ partnerId: "mine" })).rejects.toThrow('partnerType must be "user" or "global"');
      await expect(bulk({ partnerType: "user" })).rejects.toThrow("partnerType is only written with a partnerId");
      await expect(bulk({ partnerId: null, partnerType: "user" })).rejects.toThrow(
        "partnerType is only written with a partnerId"
      );
      await expect(bulk({ partnerId: "../partners/mine", partnerType: "user" })).rejects.toThrow(
        "partnerId must be a document id"
      );
    });
  });
});
