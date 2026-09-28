/**
 * Purge — the only act in the product that destroys anything (#268, ADR-0006).
 *
 * A Purge takes deleted Files only, destroys the document and its stored
 * bytes (verified, not assumed), and keeps just the identifying keys the next
 * Sync deduplicates against. It refuses a FiBuKI-generated invoice document
 * and a File that is not deleted. There is no automatic sweep anywhere; this
 * callable, owner-only, is the single writer (#296).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { store, createMockFirestore, createTestFile } from "../../test/setup";

vi.mock("firebase-admin/firestore", () => {
  class MockTimestamp {
    constructor(private readonly date: Date) {}
    static fromDate(d: Date) {
      return new MockTimestamp(d);
    }
    static now() {
      return new MockTimestamp(new Date("2026-09-27T12:00:00Z"));
    }
    toDate() {
      return this.date;
    }
  }

  return {
    getFirestore: () => createMockFirestore(),
    FieldValue: {
      serverTimestamp: () => new Date("2026-09-27T12:00:00Z"),
      arrayUnion: (...elements: unknown[]) => ({ elements, constructor: { name: "ArrayUnionTransform" } }),
      arrayRemove: (...elements: unknown[]) => ({ elements, constructor: { name: "ArrayRemoveTransform" } }),
    },
    Timestamp: MockTimestamp,
  };
});

// A stateful bucket: paths that exist, deletes that remove them. `exists()`
// answers from the state, so the purge's own verification is exercised for
// real rather than always told "gone".
const blob = vi.hoisted(() => {
  const state = {
    paths: new Set<string>(),
    deleted: [] as string[],
    /** Paths whose delete silently does nothing (a broken backend). */
    stuck: new Set<string>(),
  };
  return state;
});

vi.mock("firebase-admin/storage", () => ({
  getStorage: () => ({
    bucket: () => ({
      file: (path: string) => ({
        delete: async () => {
          if (!blob.paths.has(path)) {
            const err = new Error("No such object") as Error & { code: number };
            err.code = 404;
            throw err;
          }
          if (!blob.stuck.has(path)) {
            blob.paths.delete(path);
            blob.deleted.push(path);
          }
        },
        exists: async () => [blob.paths.has(path)],
      }),
    }),
  }),
}));

const { purgeFilesCallable } = await import("../purgeFiles");
const { createFileRecord } = await import("../createFileRecord");
const { getFirestore } = await import("firebase-admin/firestore");

const userId = "user-268";

function call(fileIds: string[]) {
  return (purgeFilesCallable as unknown as {
    run: (r: never) => Promise<{
      success: boolean;
      purged: number;
      alreadyPurged: number;
      refused: Array<{ fileId: string; fileName: string | null; reason: string; message: string }>;
    }>;
  }).run({ data: { fileIds }, auth: { uid: userId } } as never);
}

const deletedFile = (overrides: Record<string, unknown> = {}) =>
  createTestFile({
    userId,
    deletedAt: new Date("2026-09-01T00:00:00Z"),
    contentHash: "hash-abc",
    ...overrides,
  });

beforeEach(() => {
  store.clear();
  blob.paths.clear();
  blob.stuck.clear();
  blob.deleted.length = 0;
});

describe("purgeFiles (#268)", () => {
  it("destroys the stored bytes and reduces the record to its identifying keys", async () => {
    blob.paths.add("files/user-268/a.pdf");
    store.setDoc(
      "files",
      "f-a",
      deletedFile({
        storagePath: "files/user-268/a.pdf",
        gmailMessageId: "msg-1",
        gmailAttachmentId: "att-1",
        extractedPartner: "REWE",
        extractedAmount: 1234,
        fileName: "a.pdf",
        downloadUrl: "https://storage.example.com/a.pdf",
      })
    );

    const result = await call(["f-a"]);

    expect(result.success).toBe(true);
    expect(result.purged).toBe(1);
    expect(result.refused).toEqual([]);

    // Bytes gone, verified against the bucket.
    expect(blob.deleted).toContain("files/user-268/a.pdf");
    expect(blob.paths.has("files/user-268/a.pdf")).toBe(false);

    // The record keeps only what deduplication needs.
    const doc = store.getDoc("files", "f-a")!;
    expect(doc.purgedAt).toBeTruthy();
    expect(doc.userId).toBe(userId);
    expect(doc.contentHash).toBe("hash-abc");
    expect(doc.gmailMessageId).toBe("msg-1");
    expect(doc.gmailAttachmentId).toBe("att-1");
    expect(doc.deletedAt).toBeTruthy();
    expect(doc.transactionIds).toEqual([]);
    // The document's content is gone from the record.
    expect(doc.fileName).toBeUndefined();
    expect(doc.downloadUrl).toBeUndefined();
    expect(doc.storagePath).toBeUndefined();
    expect(doc.extractedPartner).toBeUndefined();
    expect(doc.extractedAmount).toBeUndefined();
  });

  it("a purged File's bytes arriving again from a Sync are recognised, not re-imported", async () => {
    blob.paths.add("files/user-268/a.pdf");
    store.setDoc("files", "f-a", deletedFile({ storagePath: "files/user-268/a.pdf" }));

    await call(["f-a"]);

    // The write point every ingestion path goes through (#182).
    const result = await createFileRecord(getFirestore() as never, {
      userId,
      contentHash: "hash-abc",
      fileName: "a-again.pdf",
    });
    expect(result.duplicate).toBe(true);
    expect(result.fileId).toBe("f-a");
  });

  it("refuses a File that is not deleted — Purge is only reachable through the deleted-files view", async () => {
    blob.paths.add("files/user-268/live.pdf");
    store.setDoc(
      "files",
      "f-live",
      createTestFile({ userId, storagePath: "files/user-268/live.pdf", fileName: "live.pdf" })
    );

    const result = await call(["f-live"]);

    expect(result.purged).toBe(0);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]).toMatchObject({ fileId: "f-live", reason: "not-deleted" });
    expect(blob.paths.has("files/user-268/live.pdf")).toBe(true);
    expect(store.getDoc("files", "f-live")?.fileName).toBe("live.pdf");
  });

  it("refuses a FiBuKI-generated invoice document and says which one", async () => {
    store.setDoc("invoices", "inv-9", { userId, number: "RE-2026-0009", status: "issued" });
    blob.paths.add("files/user-268/re9.pdf");
    store.setDoc(
      "files",
      "f-inv",
      deletedFile({
        storagePath: "files/user-268/re9.pdf",
        isFibukiGenerated: true,
        sourceType: "fibuki_invoice",
        invoiceId: "inv-9",
        fileName: "RE-2026-0009.pdf",
      })
    );

    const result = await call(["f-inv"]);

    expect(result.purged).toBe(0);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0].reason).toBe("generated-invoice");
    expect(result.refused[0].fileName).toBe("RE-2026-0009.pdf");
    expect(result.refused[0].message).toMatch(/RE-2026-0009/);
    expect(blob.paths.has("files/user-268/re9.pdf")).toBe(true);
    expect(store.getDoc("files", "f-inv")?.purgedAt).toBeUndefined();
  });

  it("does not reach another user's File and reports an unknown id", async () => {
    store.setDoc("files", "f-theirs", createTestFile({ userId: "someone-else", deletedAt: new Date() }));

    const result = await call(["f-theirs", "f-none"]);

    expect(result.purged).toBe(0);
    expect(result.refused.map((r) => r.reason)).toEqual(["not-found", "not-found"]);
    expect(store.getDoc("files", "f-theirs")?.fileName).toBeTruthy();
  });

  it("keeps the record intact when the bytes cannot be shown to be gone", async () => {
    blob.paths.add("files/user-268/stuck.pdf");
    blob.stuck.add("files/user-268/stuck.pdf");
    store.setDoc(
      "files",
      "f-stuck",
      deletedFile({ storagePath: "files/user-268/stuck.pdf", fileName: "stuck.pdf" })
    );

    const result = await call(["f-stuck"]);

    expect(result.purged).toBe(0);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0].reason).toBe("storage");
    // The record must not claim a purge the bucket did not perform.
    expect(store.getDoc("files", "f-stuck")?.fileName).toBe("stuck.pdf");
    expect(store.getDoc("files", "f-stuck")?.purgedAt).toBeUndefined();
  });

  it("treats an already-purged File as done rather than refusing or repeating", async () => {
    store.setDoc("files", "f-done", {
      userId,
      deletedAt: new Date("2026-08-01T00:00:00Z"),
      purgedAt: new Date("2026-08-02T00:00:00Z"),
      contentHash: "hash-old",
      transactionIds: [],
    });

    const result = await call(["f-done"]);

    expect(result.purged).toBe(0);
    expect(result.alreadyPurged).toBe(1);
    expect(result.refused).toEqual([]);
  });

  it("purges several Files in one call, mixing outcomes per File", async () => {
    blob.paths.add("files/user-268/a.pdf");
    blob.paths.add("files/user-268/b.pdf");
    store.setDoc("files", "f-a", deletedFile({ storagePath: "files/user-268/a.pdf", contentHash: "h-a" }));
    store.setDoc("files", "f-b", deletedFile({ storagePath: "files/user-268/b.pdf", contentHash: "h-b" }));
    store.setDoc("files", "f-live", createTestFile({ userId, fileName: "live.pdf" }));

    const result = await call(["f-a", "f-b", "f-live"]);

    expect(result.purged).toBe(2);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0].fileId).toBe("f-live");
    expect(blob.deleted.sort()).toEqual(["files/user-268/a.pdf", "files/user-268/b.pdf"]);
  });

  it("survives bytes that are already gone from storage", async () => {
    // No blob for this path: the delete throws 404, which is the state a
    // purge wants anyway.
    store.setDoc("files", "f-gone", deletedFile({ storagePath: "files/user-268/gone.pdf" }));

    const result = await call(["f-gone"]);

    expect(result.purged).toBe(1);
    expect(store.getDoc("files", "f-gone")?.purgedAt).toBeTruthy();
  });

  it("requires fileIds", async () => {
    await expect(call([])).rejects.toThrow(/fileIds/);
  });
});
