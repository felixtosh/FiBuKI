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
        data: { description: "Updated description" },
      });

      // Assert
      expect(result.success).toBe(true);
      const updated = store.getDoc("transactions", txId);
      expect(updated?.description).toBe("Updated description");
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
          data: { description: "test" },
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
          data: { description: "test" },
        })
      ).rejects.toThrow("Access denied");
    });

    it("should update partner assignment fields", async () => {
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
        data: {
          partnerId: "partner-789",
          partnerType: "user",
          partnerMatchedBy: "manual",
          partnerMatchConfidence: 1.0,
        },
      });

      const updated = store.getDoc("transactions", txId);
      expect(updated?.partnerId).toBe("partner-789");
      expect(updated?.partnerType).toBe("user");
      expect(updated?.partnerMatchedBy).toBe("manual");
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
});
