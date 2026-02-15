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

// Import handlers after mocking
const { updateFileCallable } = await import("../files/updateFile");
const { deleteFileCallable } = await import("../files/deleteFile");
const { connectFileToTransactionCallable } = await import("../files/connectFileToTransaction");
const { disconnectFileFromTransactionCallable } = await import("../files/disconnectFileFromTransaction");
const { markFileAsNotInvoiceCallable } = await import("../files/markFileAsNotInvoice");

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
});
