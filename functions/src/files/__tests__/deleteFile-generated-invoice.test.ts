/**
 * deleteFileCallable carries the generated-invoice guard (#297, ADR-0006).
 *
 * The tool surface refused a FiBuKI-generated invoice document from day one;
 * the callable behind the Files page did not, so the UI could hide the
 * document under an issued invoice with no refusal and no pointer at the
 * right act. Every delete door now behaves identically.
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

const { deleteFileCallable } = await import("../deleteFile");

const userId = "user-297";

function call(fileId: string) {
  return (deleteFileCallable as unknown as {
    run: (r: never) => Promise<{ success: boolean; deletedConnections: number }>;
  }).run({ data: { fileId }, auth: { uid: userId } } as never);
}

beforeEach(() => {
  store.clear();
});

describe("deleteFileCallable and generated invoices (#297)", () => {
  it("refuses the document FiBuKI generated for an invoice, naming it and the way out", async () => {
    store.setDoc("invoices", "inv-1", { userId, number: "RE-2026-0001", status: "issued" });
    store.setDoc(
      "files",
      "f-inv",
      createTestFile({
        userId,
        isFibukiGenerated: true,
        sourceType: "fibuki_invoice",
        invoiceId: "inv-1",
        fileName: "RE-2026-0001.pdf",
      })
    );

    await expect(call("f-inv")).rejects.toThrow(/RE-2026-0001/);
    await expect(call("f-inv")).rejects.toThrow(/cancel_invoice/);
    await expect(call("f-inv")).rejects.toThrow(/ADR-0006/);

    expect(store.getDoc("files", "f-inv")?.deletedAt).toBeFalsy();
  });

  it("refuses on the flag alone, without an invoice record to point at", async () => {
    store.setDoc("files", "f-gen", createTestFile({ userId, isFibukiGenerated: true }));

    await expect(call("f-gen")).rejects.toThrow(/GENERATED_INVOICE/);
    expect(store.getDoc("files", "f-gen")?.deletedAt).toBeFalsy();
  });

  it("still deletes an ordinary File, reversibly", async () => {
    store.setDoc("files", "f-ord", createTestFile({ userId, fileName: "beleg.pdf" }));

    const result = await call("f-ord");

    expect(result.success).toBe(true);
    const doc = store.getDoc("files", "f-ord")!;
    expect(doc.deletedAt).toBeTruthy();
    expect(doc.storagePath).toBeTruthy();
  });

  it("records on the File that it was attached when it was deleted, for the Purge warning (#268)", async () => {
    store.setDoc("files", "f-att", createTestFile({ userId, transactionIds: ["tx-1"] }));
    store.setDoc("transactions", "tx-1", {
      userId,
      fileIds: ["f-att"],
      isComplete: true,
      date: new Date("2026-01-10"),
      amount: -900,
      currency: "EUR",
      name: "REWE",
    });
    store.setDoc("fileConnections", "conn-1", {
      userId,
      fileId: "f-att",
      transactionId: "tx-1",
      connectionType: "manual",
    });

    await call("f-att");

    expect(store.getDoc("files", "f-att")?.hadTransactionConnections).toBe(true);

    // And an unattached File is not stamped.
    store.setDoc("files", "f-solo", createTestFile({ userId }));
    await call("f-solo");
    expect(store.getDoc("files", "f-solo")?.hadTransactionConnections).toBeUndefined();
  });
});
