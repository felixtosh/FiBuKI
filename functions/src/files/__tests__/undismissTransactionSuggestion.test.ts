/**
 * The undismiss callable (fork #95).
 *
 * The MCP tool of the same name is covered in tools/__tests__/handlers.test.ts.
 * What this file is for is the other half of the acceptance criterion: the two
 * surfaces must land the same field set for the same input, and the only way to
 * show that is to drive them both and compare the documents they leave behind.
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
      return new MockTimestamp(new Date("2026-08-17T12:00:00Z"));
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
      serverTimestamp: () => new Date("2026-08-17T12:00:00Z"),
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

const { undismissTransactionSuggestionCallable } = await import(
  "../undismissTransactionSuggestion"
);
const { dismissTransactionSuggestionCallable } = await import("../dismissTransactionSuggestion");
const handlers = await import("../../tools/handlers");

const userId = "user-1";
const otherUserId = "user-2";

function call(fn: { run: (r: never) => Promise<unknown> }, data: Record<string, unknown>) {
  return fn.run({ data, auth: { uid: userId } } as never);
}

const dismissedFile = () =>
  createTestFile({
    userId,
    transactionSuggestions: [],
    dismissedTransactionIds: ["tx-1"],
    dismissedTransactions: [
      { transactionId: "tx-1", dismissedAt: new Date("2026-08-01"), confidence: 82, reason: "why" },
    ],
  });

beforeEach(() => {
  store.clear();
});

describe("undismissTransactionSuggestionCallable", () => {
  it("clears the enforcement id and keeps the record, stamped", async () => {
    store.setDoc("files", "f-1", dismissedFile());

    const result = await call(undismissTransactionSuggestionCallable, {
      fileId: "f-1",
      transactionId: "tx-1",
    });

    expect(result).toMatchObject({ success: true, wasDismissed: true });

    const file = store.getDoc("files", "f-1");
    expect(file?.dismissedTransactionIds).toEqual([]);
    expect(file?.dismissedTransactions).toEqual([
      expect.objectContaining({
        transactionId: "tx-1",
        confidence: 82,
        reason: "why",
        undismissedAt: expect.anything(),
      }),
    ]);
  });

  it("does not touch the suggestion list", async () => {
    store.setDoc(
      "files",
      "f-1",
      createTestFile({
        userId,
        transactionSuggestions: [{ transactionId: "tx-2", confidence: 61 }],
        dismissedTransactionIds: ["tx-1"],
        dismissedTransactions: [
          { transactionId: "tx-1", dismissedAt: new Date("2026-08-01"), confidence: 82 },
        ],
      })
    );

    await call(undismissTransactionSuggestionCallable, { fileId: "f-1", transactionId: "tx-1" });

    // Undo restores eligibility; it does not invent the suggestion back.
    expect(store.getDoc("files", "f-1")?.transactionSuggestions).toEqual([
      { transactionId: "tx-2", confidence: 61 },
    ]);
  });

  it("writes nothing when the pair was never dismissed", async () => {
    store.setDoc("files", "f-1", createTestFile({ userId }));
    const before = { ...store.getDoc("files", "f-1") };

    const result = await call(undismissTransactionSuggestionCallable, {
      fileId: "f-1",
      transactionId: "tx-1",
    });

    expect(result).toMatchObject({ success: true, wasDismissed: false });
    expect(store.getDoc("files", "f-1")).toEqual(before);
  });

  it("refuses a missing id, an unknown file and another user's file, separately", async () => {
    await expect(
      call(undismissTransactionSuggestionCallable, { transactionId: "tx-1" })
    ).rejects.toThrow(/fileId is required/);
    await expect(
      call(undismissTransactionSuggestionCallable, { fileId: "f-1" })
    ).rejects.toThrow(/transactionId is required/);
    await expect(
      call(undismissTransactionSuggestionCallable, { fileId: "f-nope", transactionId: "tx-1" })
    ).rejects.toThrow(/File not found/);

    store.setDoc("files", "f-2", { ...dismissedFile(), userId: otherUserId });

    await expect(
      call(undismissTransactionSuggestionCallable, { fileId: "f-2", transactionId: "tx-1" })
    ).rejects.toThrow(/Access denied/);
    // The refusal must not have written.
    expect(store.getDoc("files", "f-2")?.dismissedTransactionIds).toEqual(["tx-1"]);
  });

  it("lands the same document as the MCP tool for the same input", async () => {
    store.setDoc("files", "via-callable", dismissedFile());
    store.setDoc("files", "via-tool", dismissedFile());

    await call(undismissTransactionSuggestionCallable, {
      fileId: "via-callable",
      transactionId: "tx-1",
    });
    await handlers.undismissTransactionSuggestion(userId, {
      fileId: "via-tool",
      transactionId: "tx-1",
    });

    const fromCallable = store.getDoc("files", "via-callable");
    const fromTool = store.getDoc("files", "via-tool");

    expect(fromCallable?.dismissedTransactionIds).toEqual(fromTool?.dismissedTransactionIds);
    expect(fromCallable?.dismissedTransactions).toEqual(fromTool?.dismissedTransactions);
  });

  it("round-trips with the dismiss callable, leaving one live id and two log entries", async () => {
    store.setDoc(
      "files",
      "f-1",
      createTestFile({ userId, transactionSuggestions: [{ transactionId: "tx-1", confidence: 82 }] })
    );

    await call(dismissTransactionSuggestionCallable, {
      fileId: "f-1",
      transactionId: "tx-1",
      reason: "first",
    });
    await call(undismissTransactionSuggestionCallable, { fileId: "f-1", transactionId: "tx-1" });
    await call(dismissTransactionSuggestionCallable, {
      fileId: "f-1",
      transactionId: "tx-1",
      reason: "second",
    });

    const file = store.getDoc("files", "f-1");
    const records = file?.dismissedTransactions as Array<Record<string, unknown>>;
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ reason: "first" });
    expect(records[0].undismissedAt).toBeDefined();
    expect(records[1]).toMatchObject({ reason: "second" });
    expect(records[1].undismissedAt).toBeUndefined();
    expect(file?.dismissedTransactionIds).toEqual(["tx-1"]);
  });
});
