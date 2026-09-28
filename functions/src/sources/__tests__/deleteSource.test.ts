/**
 * deleteSource and the source's own Partner (#410)
 *
 * Deleting a source removes what came from it. Its Partner is only the
 * source's to remove while nothing outside the source points at it: a bank
 * Transaction that card-to-bank reconciliation assigned it, a File, an Invoice
 * or a Merged Partner from an earlier merge (before #410 refused one) are
 * records from elsewhere, and a hard delete would leave them pointing at
 * nothing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { store, createMockFirestore, createTestTransaction, createTestFile } from "../../test/setup";

vi.mock("firebase-admin/firestore", () => ({
  FieldValue: {
    serverTimestamp: () => new Date(),
    arrayRemove: (...elements: unknown[]) => ({
      elements,
      constructor: { name: "ArrayRemoveTransform" },
    }),
    delete: () => ({ constructor: { name: "DeleteTransform" } }),
  },
  Timestamp: { now: () => new Date() },
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

import { deleteSourceInternal } from "../deleteSource";

const USER = "user-1";

function seedCardSource(): void {
  store.setDoc("sources", "card-1", {
    userId: USER,
    name: "Amex Gold",
    accountKind: "credit_card",
    sourcePartnerId: "card-partner",
    isActive: true,
  });
  store.setDoc("partners", "card-partner", {
    userId: USER,
    name: "American Express",
    identitySourceField: "source:card-1",
    isActive: true,
  });
  store.setDoc(
    "transactions",
    "tx-card",
    createTestTransaction({ userId: USER, sourceId: "card-1", partnerId: "card-partner" })
  );
}

describe("deleteSource and the source's Partner", () => {
  beforeEach(() => {
    store.clear();
  });

  it("deletes the Partner when only the source's own records pointed at it", async () => {
    seedCardSource();

    await deleteSourceInternal(createMockFirestore() as never, USER, "card-1");

    expect(store.getDoc("transactions", "tx-card")).toBeUndefined();
    expect(store.getDoc("partners", "card-partner")).toBeUndefined();
    expect(store.getDoc("sources", "card-1")).toBeUndefined();
  });

  it("keeps the Partner, without its source marker, while another source's Transaction points at it", async () => {
    seedCardSource();
    store.setDoc(
      "transactions",
      "tx-bank",
      createTestTransaction({ userId: USER, sourceId: "bank-1", partnerId: "card-partner" })
    );

    await deleteSourceInternal(createMockFirestore() as never, USER, "card-1");

    expect(store.getDoc("transactions", "tx-card")).toBeUndefined();
    expect(store.getDoc("transactions", "tx-bank")!.partnerId).toBe("card-partner");
    const partner = store.getDoc("partners", "card-partner");
    expect(partner).toBeDefined();
    expect(partner!.name).toBe("American Express");
    expect(partner!.identitySourceField).toBeUndefined();
  });

  it("keeps the Partner while a File points at it", async () => {
    seedCardSource();
    store.setDoc("files", "file-1", createTestFile({ userId: USER, partnerId: "card-partner" }));

    await deleteSourceInternal(createMockFirestore() as never, USER, "card-1");

    expect(store.getDoc("partners", "card-partner")).toBeDefined();
    expect(store.getDoc("files", "file-1")!.partnerId).toBe("card-partner");
  });

  it("keeps the Partner while an Invoice or a Merged Partner points at it", async () => {
    seedCardSource();
    store.setDoc("invoices", "inv-1", {
      userId: USER,
      recipient: { partnerId: "card-partner", name: "American Express" },
    });

    await deleteSourceInternal(createMockFirestore() as never, USER, "card-1");
    expect(store.getDoc("partners", "card-partner")).toBeDefined();

    store.clear();
    seedCardSource();
    store.setDoc("partners", "old", {
      userId: USER,
      name: "Amex Card",
      isActive: false,
      mergedInto: "card-partner",
    });

    await deleteSourceInternal(createMockFirestore() as never, USER, "card-1");
    expect(store.getDoc("partners", "card-partner")).toBeDefined();
  });

  it("ignores another user's records pointing at the same id", async () => {
    seedCardSource();
    store.setDoc(
      "transactions",
      "tx-foreign",
      createTestTransaction({ userId: "user-2", sourceId: "x", partnerId: "card-partner" })
    );

    await deleteSourceInternal(createMockFirestore() as never, USER, "card-1");

    expect(store.getDoc("partners", "card-partner")).toBeUndefined();
  });
});
