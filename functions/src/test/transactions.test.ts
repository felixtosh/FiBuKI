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
