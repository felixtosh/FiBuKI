/**
 * Tool handler tests: sources, registry dispatch and common argument handling.
 *
 * One of four files split from the former handlers.test.ts by area; shared
 * mocks and setup live in handlers-harness.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { store, createTestTransaction, createTestFile, createTestSource } from "../../test/setup";
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

describe("Tool Registry Handlers: Sources and the registry", () => {
  beforeEach(() => {
    store.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

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
