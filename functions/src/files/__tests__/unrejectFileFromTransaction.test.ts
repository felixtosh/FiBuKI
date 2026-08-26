/**
 * The un-reject callable (fork #102).
 *
 * The acceptance criterion is a round trip, not a field write: reject a pair,
 * un-reject it, and the matcher has to be willing to propose it again. Before
 * this fix the callable cleared only `rejectedFileIds`, the `rejectedFiles`
 * record survived, and every reader that consults both kept the pair excluded
 * forever — so the test drives the real reject path rather than hand-seeding
 * one shape, and asserts through the predicate those readers use.
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
      return new MockTimestamp(new Date("2026-08-19T12:00:00Z"));
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
      serverTimestamp: () => new Date("2026-08-19T12:00:00Z"),
      arrayUnion: (...elements: unknown[]) => ({
        elements,
        constructor: { name: "ArrayUnionTransform" },
      }),
      arrayRemove: (...elements: unknown[]) => ({
        elements,
        constructor: { name: "ArrayRemoveTransform" },
      }),
      increment: (n: number) => n,
    },
    Timestamp: MockTimestamp,
  };
});

const { unrejectFileFromTransactionCallable } = await import("../unrejectFileFromTransaction");
const { disconnectFileFromTransactionCallable } = await import("../disconnectFileFromTransaction");
const { isFileRejected, readRejectedFileIds } = await import("../../matching/rejectedFiles");

const userId = "user-1";

function call(fn: { run: (r: never) => Promise<unknown> }, data: Record<string, unknown>) {
  return fn.run({ data, auth: { uid: userId } } as never);
}

function seedConnectedPair() {
  store.setDoc("files", "f-1", createTestFile({ userId, transactionIds: ["tx-1"] }));
  store.setDoc(
    "transactions",
    "tx-1",
    createTestTransaction({ userId, fileIds: ["f-1"], isComplete: true })
  );
  store.setDoc("fileConnections", "c-1", {
    userId,
    fileId: "f-1",
    transactionId: "tx-1",
    matchConfidence: 82,
  });
}

const tx = () => store.getDoc("transactions", "tx-1") as Record<string, unknown>;

beforeEach(() => {
  store.clear();
});

describe("unrejectFileFromTransactionCallable", () => {
  it("lifts a rejection the reject path wrote in both shapes", async () => {
    seedConnectedPair();

    await call(disconnectFileFromTransactionCallable, {
      fileId: "f-1",
      transactionId: "tx-1",
      rejectFile: true,
    });

    // Precondition: the reject path really did write both shapes, or the
    // regression this test guards could not occur.
    expect(tx().rejectedFileIds).toEqual(["f-1"]);
    expect((tx().rejectedFiles as unknown[]).length).toBe(1);
    expect(isFileRejected(tx(), "f-1")).toBe(true);

    const result = await call(unrejectFileFromTransactionCallable, {
      fileId: "f-1",
      transactionId: "tx-1",
    });

    expect(result).toEqual({ success: true, wasRejected: true });
    // The matcher, the precision-search queue, the learning weights and both
    // analytics exports all ask this one question.
    expect(isFileRejected(tx(), "f-1")).toBe(false);
    expect([...readRejectedFileIds(tx())]).toEqual([]);
  });

  it("clears the enforcement id and keeps the record, stamped", async () => {
    seedConnectedPair();
    await call(disconnectFileFromTransactionCallable, {
      fileId: "f-1",
      transactionId: "tx-1",
      rejectFile: true,
    });

    await call(unrejectFileFromTransactionCallable, { fileId: "f-1", transactionId: "tx-1" });

    expect(tx().rejectedFileIds).toEqual([]);
    const records = tx().rejectedFiles as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    // The confidence the matcher had at rejection time is what the learning
    // export is built on, so undo stamps the record instead of deleting it.
    expect(records[0].fileId).toBe("f-1");
    expect(records[0].matchConfidence).toBe(82);
    expect(records[0].unrejectedAt).toBeTruthy();
  });

  it("lifts a rejection recorded only in the legacy id array", async () => {
    store.setDoc(
      "transactions",
      "tx-1",
      createTestTransaction({ userId, rejectedFileIds: ["f-1"] })
    );

    await call(unrejectFileFromTransactionCallable, { fileId: "f-1", transactionId: "tx-1" });

    expect(isFileRejected(tx(), "f-1")).toBe(false);
    expect(tx().rejectedFileIds).toEqual([]);
  });

  it("leaves other rejected files alone", async () => {
    store.setDoc(
      "transactions",
      "tx-1",
      createTestTransaction({
        userId,
        rejectedFileIds: ["f-1", "f-2"],
        rejectedFiles: [{ fileId: "f-1" }, { fileId: "f-2" }],
      })
    );

    await call(unrejectFileFromTransactionCallable, { fileId: "f-1", transactionId: "tx-1" });

    expect(isFileRejected(tx(), "f-1")).toBe(false);
    expect(isFileRejected(tx(), "f-2")).toBe(true);
  });

  it("succeeds and writes nothing when the pair was never rejected", async () => {
    store.setDoc("transactions", "tx-1", createTestTransaction({ userId, updatedAt: "untouched" }));

    const result = await call(unrejectFileFromTransactionCallable, {
      fileId: "f-1",
      transactionId: "tx-1",
    });

    expect(result).toEqual({ success: true, wasRejected: false });
    expect(tx().updatedAt).toBe("untouched");
    expect(tx().rejectedFiles).toBeUndefined();
  });

  it("re-rejecting after an undo suppresses the pair again", async () => {
    seedConnectedPair();
    await call(disconnectFileFromTransactionCallable, {
      fileId: "f-1",
      transactionId: "tx-1",
      rejectFile: true,
    });
    await call(unrejectFileFromTransactionCallable, { fileId: "f-1", transactionId: "tx-1" });

    store.setDoc("files", "f-1", createTestFile({ userId, transactionIds: ["tx-1"] }));
    store.setDoc("fileConnections", "c-2", {
      userId,
      fileId: "f-1",
      transactionId: "tx-1",
      matchConfidence: 91,
    });
    await call(disconnectFileFromTransactionCallable, {
      fileId: "f-1",
      transactionId: "tx-1",
      rejectFile: true,
    });

    expect(isFileRejected(tx(), "f-1")).toBe(true);
    // Three decisions about this pair, not one: the array is the history.
    expect((tx().rejectedFiles as unknown[]).length).toBe(2);
  });

  it("refuses a transaction owned by another user", async () => {
    store.setDoc(
      "transactions",
      "tx-1",
      createTestTransaction({ userId: "user-2", rejectedFileIds: ["f-1"] })
    );

    await expect(
      call(unrejectFileFromTransactionCallable, { fileId: "f-1", transactionId: "tx-1" })
    ).rejects.toThrow(/Access denied/);
    expect(tx().rejectedFileIds).toEqual(["f-1"]);
  });

  it("rejects a missing transaction and missing arguments", async () => {
    await expect(
      call(unrejectFileFromTransactionCallable, { fileId: "f-1", transactionId: "nope" })
    ).rejects.toThrow(/Transaction not found/);
    await expect(
      call(unrejectFileFromTransactionCallable, { transactionId: "tx-1" })
    ).rejects.toThrow(/fileId is required/);
    await expect(call(unrejectFileFromTransactionCallable, { fileId: "f-1" })).rejects.toThrow(
      /transactionId is required/
    );
  });
});
