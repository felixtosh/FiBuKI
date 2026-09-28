/**
 * delete_file / restore_file on the tool surface (#267).
 *
 * Deleting a File here is always the reversible kind (ADR-0006): the row and
 * its stored bytes survive, and restore_file puts it back. A Purge is not
 * reachable from this surface at all.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { store, createMockFirestore, createTestFile, createTestTransaction } from "../../test/setup";

vi.mock("firebase-admin/firestore", () => {
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
      delete: () => ({ constructor: { name: "DeleteTransform" } }),
    },
    Timestamp: MockTimestamp,
  };
});

// Anything reaching for the stored bytes would go through here.
const storage = vi.hoisted(() => ({ deleteFn: vi.fn(), fileFn: vi.fn() }));
vi.mock("firebase-admin/storage", () => ({
  getStorage: () => ({
    bucket: () => ({
      file: (...args: unknown[]) => {
        storage.fileFn(...args);
        return { delete: storage.deleteFn, save: vi.fn(), exists: vi.fn(async () => [true]) };
      },
    }),
  }),
}));

vi.mock("../../utils/createCallable", () => ({
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

vi.mock("firebase-functions/params", () => ({
  defineSecret: (name: string) => ({ value: () => `test-${name}` }),
}));

const handlers = await import("../handlers");
const { TOOL_DEFINITIONS } = await import("../definitions");

const userId = "user-267";
const otherUserId = "someone-else";

function attach(fileId: string, txId: string, tx: Record<string, unknown>) {
  store.setDoc("transactions", txId, createTestTransaction({ userId, ...tx }));
  store.setDoc("fileConnections", `conn-${fileId}-${txId}`, {
    userId,
    fileId,
    transactionId: txId,
    connectionType: "manual",
  });
}

describe("delete_file (#267)", () => {
  beforeEach(() => {
    store.clear();
    storage.deleteFn.mockClear();
    storage.fileFn.mockClear();
  });

  it("refuses without confirm: true and leaves the file alone", async () => {
    store.setDoc("files", "f1", createTestFile({ userId }));

    await expect(handlers.handleTool(userId, "delete_file", { fileId: "f1" })).rejects.toThrow(
      /confirm: true/
    );
    await expect(
      handlers.handleTool(userId, "delete_file", { fileId: "f1", confirm: "yes" })
    ).rejects.toThrow(/confirm: true/);

    expect(store.getDoc("files", "f1")?.deletedAt).toBeFalsy();
  });

  it("hides the file and never touches the stored document, whatever else is passed", async () => {
    store.setDoc(
      "files",
      "f1",
      createTestFile({ userId, storagePath: `files/${userId}/f1.pdf` })
    );

    const result = (await handlers.handleTool(userId, "delete_file", {
      fileId: "f1",
      confirm: true,
      // None of these mean anything to the tool.
      purge: true,
      permanent: true,
      hardDelete: true,
    })) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.reversible).toBe(true);

    const file = store.getDoc("files", "f1");
    expect(file).toBeDefined();
    expect(file?.deletedAt).toBeTruthy();
    expect(file?.storagePath).toBe(`files/${userId}/f1.pdf`);
    expect(file?.downloadUrl).toBe("https://storage.example.com/test.pdf");
    expect(storage.fileFn).not.toHaveBeenCalled();
    expect(storage.deleteFn).not.toHaveBeenCalled();
  });

  it("succeeds on an attached file and separates re-opened from still-complete transactions", async () => {
    store.setDoc(
      "files",
      "f1",
      createTestFile({ userId, transactionIds: ["tx-open", "tx-cat", "tx-other"] })
    );
    // Only document: goes back to incomplete.
    attach("f1", "tx-open", {
      fileIds: ["f1"],
      isComplete: true,
      date: new Date("2025-03-04T00:00:00Z"),
      amount: -4299,
      currency: "EUR",
      name: "AMAZON EU",
      partner: "Amazon EU S.a.r.l.",
    });
    // No-document Category: stays complete.
    attach("f1", "tx-cat", {
      fileIds: ["f1"],
      isComplete: true,
      noReceiptCategoryId: "cat-bank-fees",
      date: new Date("2025-03-05T00:00:00Z"),
      amount: -350,
      name: "Kontoführung",
      partner: "Erste Bank",
    });
    // Another document still attached: stays complete.
    attach("f1", "tx-other", {
      fileIds: ["f1", "f2"],
      isComplete: true,
      date: new Date("2025-03-06T00:00:00Z"),
      amount: -1200,
      name: "A1 Telekom",
      partner: "A1",
    });

    const result = (await handlers.handleTool(userId, "delete_file", {
      fileId: "f1",
      confirm: true,
    })) as {
      reopenedTransactions: Array<Record<string, unknown>>;
      stillCompleteTransactions: Array<Record<string, unknown>>;
    };

    expect(result.reopenedTransactions).toEqual([
      {
        transactionId: "tx-open",
        date: "2025-03-04",
        amount: -4299,
        currency: "EUR",
        name: "AMAZON EU",
        partner: "Amazon EU S.a.r.l.",
      },
    ]);
    expect(result.stillCompleteTransactions.map((t) => t.transactionId).sort()).toEqual([
      "tx-cat",
      "tx-other",
    ]);
    const cat = result.stillCompleteTransactions.find((t) => t.transactionId === "tx-cat")!;
    expect(cat).toMatchObject({ date: "2025-03-05", amount: -350, partner: "Erste Bank" });

    expect(store.getDoc("transactions", "tx-open")?.isComplete).toBe(false);
    expect(store.getDoc("transactions", "tx-cat")?.isComplete).toBe(true);
    expect(store.getDoc("transactions", "tx-other")?.isComplete).toBe(true);
    expect(store.getDoc("transactions", "tx-open")?.fileIds).toEqual([]);
  });

  it("refuses a FiBuKI-generated invoice document, naming the invoice", async () => {
    store.setDoc("invoices", "inv-1", { userId, number: "RE-2025-0007", status: "issued", fileId: "f-inv" });
    store.setDoc(
      "files",
      "f-inv",
      createTestFile({
        userId,
        isFibukiGenerated: true,
        sourceType: "fibuki_invoice",
        invoiceId: "inv-1",
        fileName: "RE-2025-0007.pdf",
      })
    );

    await expect(
      handlers.handleTool(userId, "delete_file", { fileId: "f-inv", confirm: true })
    ).rejects.toThrow(/RE-2025-0007.*cancel_invoice/s);

    expect(store.getDoc("files", "f-inv")?.deletedAt).toBeFalsy();
  });

  it("refuses a generated document even when only the flag marks it", async () => {
    store.setDoc("files", "f-gen", createTestFile({ userId, isFibukiGenerated: true }));

    await expect(
      handlers.handleTool(userId, "delete_file", { fileId: "f-gen", confirm: true })
    ).rejects.toThrow(/GENERATED_INVOICE/);
    expect(store.getDoc("files", "f-gen")?.deletedAt).toBeFalsy();
  });

  it("does not reach another user's file", async () => {
    store.setDoc("files", "f1", createTestFile({ userId: otherUserId }));

    await expect(
      handlers.handleTool(userId, "delete_file", { fileId: "f1", confirm: true })
    ).rejects.toThrow("File not found");
    expect(store.getDoc("files", "f1")?.deletedAt).toBeFalsy();
  });

  it("is a no-op on a file that is already deleted", async () => {
    const deletedAt = new Date("2025-01-01T00:00:00Z");
    store.setDoc("files", "f1", createTestFile({ userId, deletedAt }));

    const result = (await handlers.handleTool(userId, "delete_file", {
      fileId: "f1",
      confirm: true,
    })) as Record<string, unknown>;

    expect(result.alreadyDeleted).toBe(true);
    expect(store.getDoc("files", "f1")?.deletedAt).toEqual(deletedAt);
  });
});

describe("restore_file (#267)", () => {
  beforeEach(() => {
    store.clear();
  });

  it("puts a deleted file back without recreating its transaction attachments", async () => {
    store.setDoc("files", "f1", createTestFile({ userId, transactionIds: ["tx-1"] }));
    attach("f1", "tx-1", { fileIds: ["f1"], isComplete: true });

    await handlers.handleTool(userId, "delete_file", { fileId: "f1", confirm: true });
    const result = (await handlers.handleTool(userId, "restore_file", {
      fileId: "f1",
    })) as Record<string, unknown>;

    expect(result).toMatchObject({ success: true, restored: true });
    const file = store.getDoc("files", "f1");
    expect(file?.deletedAt).toBeFalsy();
    expect(file?.transactionIds).toEqual([]);
    expect(store.getDoc("transactions", "tx-1")?.fileIds).toEqual([]);
    expect(store.getDoc("transactions", "tx-1")?.isComplete).toBe(false);
    expect(store.getDoc("fileConnections", "conn-f1-tx-1")).toBeUndefined();
  });

  it("reports a file that was not deleted", async () => {
    store.setDoc("files", "f1", createTestFile({ userId }));

    const result = (await handlers.handleTool(userId, "restore_file", {
      fileId: "f1",
    })) as Record<string, unknown>;
    expect(result).toMatchObject({ success: true, restored: false });
  });

  it("does not reach another user's file", async () => {
    store.setDoc("files", "f1", createTestFile({ userId: otherUserId, deletedAt: new Date() }));

    await expect(handlers.handleTool(userId, "restore_file", { fileId: "f1" })).rejects.toThrow(
      "File not found"
    );
    expect(store.getDoc("files", "f1")?.deletedAt).toBeTruthy();
  });
});

describe("list_files and deleted files (#267)", () => {
  beforeEach(() => {
    store.clear();
  });

  it("excludes deleted files by default and includes them on request", async () => {
    store.setDoc("files", "live", createTestFile({ userId, uploadedAt: new Date("2025-02-02") }));
    store.setDoc(
      "files",
      "gone",
      createTestFile({ userId, uploadedAt: new Date("2025-02-01"), deletedAt: new Date() })
    );

    const byDefault = (await handlers.listFiles(userId, {})) as { files: Array<{ id: string }> };
    expect(byDefault.files.map((f) => f.id)).toEqual(["live"]);

    const withDeleted = (await handlers.listFiles(userId, { includeDeleted: true })) as {
      files: Array<{ id: string }>;
    };
    expect(withDeleted.files.map((f) => f.id)).toEqual(["live", "gone"]);
  });
});

describe("tool descriptions (#267)", () => {
  it("say the deletion is reversible and name the way back", () => {
    const del = TOOL_DEFINITIONS.find((t) => t.name === "delete_file");
    const restore = TOOL_DEFINITIONS.find((t) => t.name === "restore_file");
    expect(del).toBeDefined();
    expect(restore).toBeDefined();
    expect(del!.description).toMatch(/reversible/i);
    expect(del!.description).toMatch(/restore_file/);
    expect(del!.inputSchema.required).toEqual(["fileId", "confirm"]);
    // No parameter can reach a Purge.
    expect(Object.keys(del!.inputSchema.properties).sort()).toEqual(["confirm", "fileId"]);

    const list = TOOL_DEFINITIONS.find((t) => t.name === "list_files");
    expect(list!.inputSchema.properties).toHaveProperty("includeDeleted");
  });
});
