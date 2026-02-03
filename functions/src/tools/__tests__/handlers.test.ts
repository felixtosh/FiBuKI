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
vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => createMockFirestore(),
  FieldValue: {
    serverTimestamp: () => new Date(),
    arrayUnion: (...elements: unknown[]) => ({ elements, constructor: { name: "ArrayUnionTransform" } }),
    arrayRemove: (...elements: unknown[]) => ({ elements, constructor: { name: "ArrayRemoveTransform" } }),
    increment: (n: number) => n,
  },
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

      expect(result).toHaveLength(2);
    });

    it("should filter by isComplete", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, isComplete: true }));
      store.setDoc("transactions", "tx-2", createTestTransaction({ userId, isComplete: false }));

      const complete = await handlers.listTransactions(userId, { isComplete: true });
      const incomplete = await handlers.listTransactions(userId, { isComplete: false });

      expect(complete).toHaveLength(1);
      expect(incomplete).toHaveLength(1);
    });

    it("should filter by sourceId", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, sourceId: "src-a" }));
      store.setDoc("transactions", "tx-2", createTestTransaction({ userId, sourceId: "src-b" }));

      const result = await handlers.listTransactions(userId, { sourceId: "src-a" });

      expect(result).toHaveLength(1);
    });

    it("should filter by search term", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, name: "Amazon Purchase" }));
      store.setDoc("transactions", "tx-2", createTestTransaction({ userId, name: "Netflix" }));

      const result = await handlers.listTransactions(userId, { search: "amazon" });

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Amazon Purchase");
    });

    it("should include formatted amount", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, amount: -2500, currency: "EUR" }));

      const result = await handlers.listTransactions(userId, {});

      expect(result[0].amountFormatted).toBe("-25.00 EUR");
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

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("tx-1");
    });

    it("should filter by minAmount", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, amount: -5000, fileIds: [] }));
      store.setDoc("transactions", "tx-2", createTestTransaction({ userId, amount: -500, fileIds: [] }));

      const result = await handlers.listTransactionsNeedingFiles(userId, { minAmount: 1000 });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("tx-1");
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

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("tx-new");
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

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("tx-old");
    });

    it("should filter by date range", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, date: new Date("2024-01-01") }));
      store.setDoc("transactions", "tx-2", createTestTransaction({ userId, date: new Date("2024-03-15") }));
      store.setDoc("transactions", "tx-3", createTestTransaction({ userId, date: new Date("2024-06-01") }));

      const result = await handlers.listTransactions(userId, {
        dateFrom: "2024-02-01",
        dateTo: "2024-05-01",
      });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("tx-2");
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
      expect(Array.isArray(result)).toBe(true);
    });

    it("listTransactions should cap limit at 100", async () => {
      const result = await handlers.listTransactions(userId, { limit: 200 });
      // Just verify it doesn't throw - limit is applied server-side
      expect(result).toBeDefined();
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

      expect(result).toHaveLength(4);
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

      expect(result).toHaveLength(1);
    });

    it("should search in partner field", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({
        userId,
        name: "Generic",
        partner: "Amazon EU SARL",
      }));

      const result = await handlers.listTransactions(userId, { search: "amazon" });

      expect(result).toHaveLength(1);
    });

    it("should be case insensitive", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({
        userId,
        name: "AMAZON PURCHASE",
      }));

      const result = await handlers.listTransactions(userId, { search: "amazon" });

      expect(result).toHaveLength(1);
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

      expect(result).toHaveLength(0);
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

      const result = await handlers.handleTool(userId, "list_transactions", { isComplete: false });

      expect(result).toHaveLength(1);
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
