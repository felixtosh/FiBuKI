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
  });
});
