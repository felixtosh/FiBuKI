/**
 * File Cloud Functions Tests
 */

import { describe, it, expect, vi } from "vitest";
import {
  setupTestHooks,
  store,
  createMockFirestore,
  createTestFile,
  createTestTransaction,
} from "./setup";

// Mock the createCallable wrapper
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

// Silence async cancellation side-effects in unit tests.
vi.mock("../utils/cancelWorkers", () => ({
  cancelFileWorkersForTransaction: vi.fn(async () => 0),
  cancelTransactionWorkersForFile: vi.fn(async () => 0),
  cancelPrecisionSearchForTransaction: vi.fn(async () => 0),
}));

// Import handlers after mocking
const { updateFileCallable } = await import("../files/updateFile");
const { deleteFileCallable } = await import("../files/deleteFile");
const { connectFileToTransactionCallable } = await import("../files/connectFileToTransaction");
const { disconnectFileFromTransactionCallable } = await import("../files/disconnectFileFromTransaction");
const { markFileAsNotInvoiceCallable } = await import("../files/markFileAsNotInvoice");
const { dismissTransactionSuggestionCallable } = await import("../files/dismissTransactionSuggestion");

describe("File Cloud Functions", () => {
  setupTestHooks();

  describe("updateFile", () => {
    it("should update file metadata", async () => {
      const userId = "user-123";
      const fileId = "file-456";
      store.setDoc("files", fileId, createTestFile({ userId }));

      const ctx = {
        userId,
        db: createMockFirestore(),
        request: { auth: { uid: userId }, data: {} },
        logAIUsage: vi.fn(),
      };

      const result = await updateFileCallable(ctx as any, {
        fileId,
        data: { fileName: "renamed-invoice.pdf" },
      });

      expect(result.success).toBe(true);
      const updated = store.getDoc("files", fileId);
      expect(updated?.fileName).toBe("renamed-invoice.pdf");
    });

    it("should update extraction data", async () => {
      const userId = "user-123";
      const fileId = "file-456";
      store.setDoc("files", fileId, createTestFile({ userId }));

      const ctx = {
        userId,
        db: createMockFirestore(),
        request: { auth: { uid: userId }, data: {} },
        logAIUsage: vi.fn(),
      };

      await updateFileCallable(ctx as any, {
        fileId,
        data: {
          extractedAmount: 1998,
          extractedVatAmount: 333,
          extractedLineItems: [
            {
              description: "USB-C Cable",
              quantity: 2,
              unitPrice: 833,
              vatPercent: 20,
              vatAmount: 333,
              amount: 1998,
            },
          ],
          extractedPartner: "Amazon",
          extractedDate: "2024-01-15T00:00:00.000Z",
        },
      });

      const updated = store.getDoc("files", fileId);
      expect(updated?.extractedAmount).toBe(1998);
      expect(updated?.extractedVatAmount).toBe(333);
      expect(updated?.extractedLineItems).toHaveLength(1);
      expect(updated?.extractedPartner).toBe("Amazon");
    });

    it("should consolidate net line-item amounts to gross extractedAmount", async () => {
      const userId = "user-123";
      const fileId = "file-457";
      store.setDoc("files", fileId, createTestFile({ userId }));

      const ctx = {
        userId,
        db: createMockFirestore(),
        request: { auth: { uid: userId }, data: {} },
        logAIUsage: vi.fn(),
      };

      await updateFileCallable(ctx as any, {
        fileId,
        data: {
          extractedLineItems: [
            {
              description: "Consulting",
              quantity: 1,
              unitPrice: 50000,
              vatPercent: 20,
              vatAmount: 10000,
              amount: 50000,
            },
          ],
        },
      });

      const updated = store.getDoc("files", fileId);
      expect(updated?.extractedAmount).toBe(60000);
      expect(updated?.extractedVatAmount).toBe(10000);
      expect(updated?.extractedVatPercent).toBe(20);
    });

    it("should reject update for file owned by another user", async () => {
      const fileId = "file-456";
      store.setDoc("files", fileId, createTestFile({ userId: "other-user" }));

      const ctx = {
        userId: "user-123",
        db: createMockFirestore(),
        request: { auth: { uid: "user-123" }, data: {} },
        logAIUsage: vi.fn(),
      };

      await expect(
        updateFileCallable(ctx as any, {
          fileId,
          data: { fileName: "test.pdf" },
        })
      ).rejects.toThrow("Access denied");
    });
  });

  describe("deleteFile", () => {
    it("should soft delete a file by default", async () => {
      const userId = "user-123";
      const fileId = "file-456";
      store.setDoc("files", fileId, createTestFile({ userId }));

      const ctx = {
        userId,
        db: createMockFirestore(),
        request: { auth: { uid: userId }, data: {} },
        logAIUsage: vi.fn(),
      };

      const result = await deleteFileCallable(ctx as any, {
        fileId,
        hardDelete: false,
      });

      expect(result.success).toBe(true);
      const file = store.getDoc("files", fileId);
      expect(file).toBeDefined(); // Still exists
      expect(file?.deletedAt).toBeDefined(); // But marked as deleted
    });

    it("should hard delete a file when specified", async () => {
      const userId = "user-123";
      const fileId = "file-456";
      store.setDoc("files", fileId, createTestFile({ userId }));

      const ctx = {
        userId,
        db: createMockFirestore(),
        request: { auth: { uid: userId }, data: {} },
        logAIUsage: vi.fn(),
      };

      const result = await deleteFileCallable(ctx as any, {
        fileId,
        hardDelete: true,
      });

      expect(result.success).toBe(true);
      expect(store.getDoc("files", fileId)).toBeUndefined();
    });
  });

  describe("connectFileToTransaction", () => {
    it("should connect a file to a transaction", async () => {
      const userId = "user-123";
      const fileId = "file-456";
      const txId = "tx-789";

      store.setDoc("files", fileId, createTestFile({ userId, transactionIds: [] }));
      store.setDoc("transactions", txId, createTestTransaction({ userId, fileIds: [] }));

      const ctx = {
        userId,
        db: createMockFirestore(),
        request: { auth: { uid: userId }, data: {} },
        logAIUsage: vi.fn(),
      };

      const result = await connectFileToTransactionCallable(ctx as any, {
        fileId,
        transactionId: txId,
        connectionType: "manual",
      });

      expect(result.success).toBe(true);
      expect(result.connectionId).toBeDefined();

      // Verify file was updated
      const file = store.getDoc("files", fileId);
      expect(file?.transactionIds).toContain(txId);

      // Verify transaction was updated
      const tx = store.getDoc("transactions", txId);
      expect(tx?.fileIds).toContain(fileId);

      // Verify connection record was created
      const connections = store.queryDocs("fileConnections", [
        { field: "fileId", op: "==", value: fileId },
        { field: "transactionId", op: "==", value: txId },
      ]);
      expect(connections.length).toBe(1);
    });

    it("should not create duplicate connections", async () => {
      const userId = "user-123";
      const fileId = "file-456";
      const txId = "tx-789";

      store.setDoc("files", fileId, createTestFile({ userId, transactionIds: [txId] }));
      store.setDoc("transactions", txId, createTestTransaction({ userId, fileIds: [fileId] }));
      store.setDoc("fileConnections", "conn-1", {
        userId,
        fileId,
        transactionId: txId,
        connectionType: "manual",
      });

      const ctx = {
        userId,
        db: createMockFirestore(),
        request: { auth: { uid: userId }, data: {} },
        logAIUsage: vi.fn(),
      };

      // Should return existing connection
      const result = await connectFileToTransactionCallable(ctx as any, {
        fileId,
        transactionId: txId,
        connectionType: "manual",
      });

      expect(result.success).toBe(true);
    });

    it("should reassign existing auto/ai matches when allowAutoReassign=true", async () => {
      const userId = "user-123";
      const fileA = "file-a";
      const fileB = "file-b";
      const tx1 = "tx-1";
      const tx2 = "tx-2";

      store.setDoc("files", fileA, createTestFile({ userId, transactionIds: [tx1] }));
      store.setDoc("files", fileB, createTestFile({ userId, transactionIds: [tx2] }));
      store.setDoc("transactions", tx1, createTestTransaction({ userId, fileIds: [fileA], isComplete: true }));
      store.setDoc("transactions", tx2, createTestTransaction({ userId, fileIds: [fileB], isComplete: true }));
      store.setDoc("fileConnections", "conn-auto-tx", {
        userId,
        fileId: fileA,
        transactionId: tx1,
        connectionType: "auto_matched",
      });
      store.setDoc("fileConnections", "conn-ai-file", {
        userId,
        fileId: fileB,
        transactionId: tx2,
        connectionType: "ai_matched",
      });

      const ctx = {
        userId,
        db: createMockFirestore(),
        request: { auth: { uid: userId }, data: {} },
        logAIUsage: vi.fn(),
      };

      const result = await connectFileToTransactionCallable(ctx as any, {
        fileId: fileB,
        transactionId: tx1,
        connectionType: "auto_matched",
        allowAutoReassign: true,
      });

      expect(result.success).toBe(true);
      expect(result.reassignedConnections).toBe(2);

      // Old auto/ai links removed
      expect(store.getDoc("fileConnections", "conn-auto-tx")).toBeUndefined();
      expect(store.getDoc("fileConnections", "conn-ai-file")).toBeUndefined();

      // New link exists
      const newConnection = store.queryDocs("fileConnections", [
        { field: "fileId", op: "==", value: fileB },
        { field: "transactionId", op: "==", value: tx1 },
      ]);
      expect(newConnection).toHaveLength(1);

      // Arrays updated on both sides
      expect((store.getDoc("files", fileA)?.transactionIds as string[]) || []).not.toContain(tx1);
      expect((store.getDoc("files", fileB)?.transactionIds as string[]) || []).toContain(tx1);
      expect((store.getDoc("files", fileB)?.transactionIds as string[]) || []).not.toContain(tx2);
      expect((store.getDoc("transactions", tx1)?.fileIds as string[]) || []).toContain(fileB);
      expect((store.getDoc("transactions", tx1)?.fileIds as string[]) || []).not.toContain(fileA);
      expect((store.getDoc("transactions", tx2)?.fileIds as string[]) || []).not.toContain(fileB);
      expect(store.getDoc("transactions", tx2)?.isComplete).toBe(false);
    });

    it("should reject auto reassignment when transaction has manual/user-confirmed connection", async () => {
      const userId = "user-123";
      const fileA = "file-a";
      const fileB = "file-b";
      const tx1 = "tx-1";

      store.setDoc("files", fileA, createTestFile({ userId, transactionIds: [tx1] }));
      store.setDoc("files", fileB, createTestFile({ userId, transactionIds: [] }));
      store.setDoc("transactions", tx1, createTestTransaction({ userId, fileIds: [fileA], isComplete: true }));
      store.setDoc("fileConnections", "conn-manual", {
        userId,
        fileId: fileA,
        transactionId: tx1,
        connectionType: "manual",
      });

      const ctx = {
        userId,
        db: createMockFirestore(),
        request: { auth: { uid: userId }, data: {} },
        logAIUsage: vi.fn(),
      };

      await expect(
        connectFileToTransactionCallable(ctx as any, {
          fileId: fileB,
          transactionId: tx1,
          connectionType: "auto_matched",
          allowAutoReassign: true,
        })
      ).rejects.toThrow("Transaction has manual/user-confirmed file matches");
    });

    it("should reject auto reassignment when file has manual/user-confirmed connection", async () => {
      const userId = "user-123";
      const fileB = "file-b";
      const tx1 = "tx-1";
      const tx2 = "tx-2";

      store.setDoc("files", fileB, createTestFile({ userId, transactionIds: [tx2] }));
      store.setDoc("transactions", tx1, createTestTransaction({ userId, fileIds: [], isComplete: false }));
      store.setDoc("transactions", tx2, createTestTransaction({ userId, fileIds: [fileB], isComplete: true }));
      store.setDoc("fileConnections", "conn-suggestion", {
        userId,
        fileId: fileB,
        transactionId: tx2,
        connectionType: "suggestion_accepted",
      });

      const ctx = {
        userId,
        db: createMockFirestore(),
        request: { auth: { uid: userId }, data: {} },
        logAIUsage: vi.fn(),
      };

      await expect(
        connectFileToTransactionCallable(ctx as any, {
          fileId: fileB,
          transactionId: tx1,
          connectionType: "auto_matched",
          allowAutoReassign: true,
        })
      ).rejects.toThrow("File has manual/user-confirmed transaction matches");
    });
  });

  describe("disconnectFileFromTransaction", () => {
    it("should disconnect a file from a transaction", async () => {
      const userId = "user-123";
      const fileId = "file-456";
      const txId = "tx-789";

      store.setDoc("files", fileId, createTestFile({ userId, transactionIds: [txId] }));
      store.setDoc("transactions", txId, createTestTransaction({ userId, fileIds: [fileId] }));
      store.setDoc("fileConnections", "conn-1", {
        userId,
        fileId,
        transactionId: txId,
        connectionType: "manual",
      });

      const ctx = {
        userId,
        db: createMockFirestore(),
        request: { auth: { uid: userId }, data: {} },
        logAIUsage: vi.fn(),
      };

      const result = await disconnectFileFromTransactionCallable(ctx as any, {
        fileId,
        transactionId: txId,
      });

      expect(result.success).toBe(true);
    });
  });

  describe("markFileAsNotInvoice", () => {
    it("should mark a file as not an invoice and clear extracted data", async () => {
      const userId = "user-123";
      const fileId = "file-456";
      store.setDoc("files", fileId, createTestFile({
        userId,
        extractedAmount: 100,
        extractedVatAmount: 20,
        extractedLineItems: [
          {
            description: "Line item",
            vatPercent: 20,
            vatAmount: 20,
            amount: 100,
          },
        ],
        extractedPartner: "Amazon",
        partnerId: "partner-123",
        partnerMatchedBy: "auto",
      }));

      const ctx = {
        userId,
        db: createMockFirestore(),
        request: { auth: { uid: userId }, data: {} },
        logAIUsage: vi.fn(),
      };

      const result = await markFileAsNotInvoiceCallable(ctx as any, {
        fileId,
        reason: "This is a bank statement",
      });

      expect(result.success).toBe(true);

      const file = store.getDoc("files", fileId);
      expect(file?.isNotInvoice).toBe(true);
      expect(file?.notInvoiceReason).toBe("This is a bank statement");
      expect(file?.extractedAmount).toBeNull();
      expect(file?.extractedVatAmount).toBeNull();
      expect(file?.extractedLineItems).toBeNull();
      expect(file?.extractedPartner).toBeNull();
      // Partner should be cleared because it wasn't manual
      expect(file?.partnerId).toBeNull();
    });

    it("should preserve manually assigned partner", async () => {
      const userId = "user-123";
      const fileId = "file-456";
      store.setDoc("files", fileId, createTestFile({
        userId,
        extractedAmount: 100,
        partnerId: "partner-123",
        partnerMatchedBy: "manual", // Manual assignment should be preserved
      }));

      const ctx = {
        userId,
        db: createMockFirestore(),
        request: { auth: { uid: userId }, data: {} },
        logAIUsage: vi.fn(),
      };

      await markFileAsNotInvoiceCallable(ctx as any, {
        fileId,
        reason: "Test",
      });

      const file = store.getDoc("files", fileId);
      expect(file?.isNotInvoice).toBe(true);
      // Manual partner assignment should be preserved
      expect(file?.partnerId).toBe("partner-123");
    });
  });

  describe("dismissTransactionSuggestion", () => {
    const userId = "user-123";
    const fileId = "file-456";

    const ctx = () => ({
      userId,
      db: createMockFirestore(),
      request: { auth: { uid: userId }, data: {} },
      logAIUsage: vi.fn(),
    });

    const suggestion = (transactionId: string, confidence: number) => ({
      transactionId,
      confidence,
      matchSources: [{ type: "amount", weight: 40 }],
    });

    it("should write the same field set the MCP tool writes", async () => {
      store.setDoc(
        "files",
        fileId,
        createTestFile({
          userId,
          transactionSuggestions: [suggestion("tx-1", 82), suggestion("tx-2", 61)],
        })
      );

      const result = await dismissTransactionSuggestionCallable(ctx() as any, {
        fileId,
        transactionId: "tx-1",
        reason: "own-side document",
      });

      expect(result).toEqual({ success: true, dismissedConfidence: 82 });

      const file = store.getDoc("files", fileId);
      expect(file?.transactionSuggestions).toEqual([suggestion("tx-2", 61)]);
      expect(file?.dismissedTransactionIds).toEqual(["tx-1"]);
      expect(file?.dismissedTransactions).toEqual([
        expect.objectContaining({ transactionId: "tx-1", confidence: 82, reason: "own-side document" }),
      ]);
    });

    it("should keep the UI's reason-less dismiss working", async () => {
      store.setDoc(
        "files",
        fileId,
        createTestFile({ userId, transactionSuggestions: [suggestion("tx-1", 70)] })
      );

      const result = await dismissTransactionSuggestionCallable(ctx() as any, {
        fileId,
        transactionId: "tx-1",
      });

      expect(result).toEqual({ success: true, dismissedConfidence: 70 });
      expect(store.getDoc("files", fileId)?.dismissedTransactions).toEqual([
        expect.objectContaining({ transactionId: "tx-1", reason: null }),
      ]);
    });

    it("should reject missing ids, an over-long reason and another user's file", async () => {
      await expect(
        dismissTransactionSuggestionCallable(ctx() as any, { transactionId: "tx-1" } as any)
      ).rejects.toThrow("fileId is required");
      await expect(
        dismissTransactionSuggestionCallable(ctx() as any, { fileId } as any)
      ).rejects.toThrow("transactionId is required");

      store.setDoc("files", fileId, createTestFile({ userId }));
      await expect(
        dismissTransactionSuggestionCallable(ctx() as any, {
          fileId,
          transactionId: "tx-1",
          reason: "x".repeat(501),
        })
      ).rejects.toThrow(/at most 500 characters/);

      store.setDoc("files", "file-other", createTestFile({ userId: "someone-else" }));
      await expect(
        dismissTransactionSuggestionCallable(ctx() as any, {
          fileId: "file-other",
          transactionId: "tx-1",
        })
      ).rejects.toThrow("Access denied");

      await expect(
        dismissTransactionSuggestionCallable(ctx() as any, {
          fileId: "file-missing",
          transactionId: "tx-1",
        })
      ).rejects.toThrow("File not found");
    });
  });
});
