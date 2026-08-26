/**
 * The UI dismiss path writes the dismissal list (fork #100).
 *
 * Both dismiss buttons a human can click — components/files/file-detail-panel
 * and components/invoicing/InvoiceDetailPanel — call
 * `dismissTransactionSuggestion` in lib/operations/file-transaction-matching-ops.
 * That operation used to trim `transactionSuggestions` on the file document and
 * stop there, writing neither `dismissedTransactionIds` nor
 * `dismissedTransactions`. Since fork #94 those two fields are what matching
 * reads to keep a rejected pair from being re-proposed, so a rejection made by
 * an agent stuck and a rejection made by a click did not.
 *
 * What is asserted here is the shape of the fix rather than its effect: the
 * operation delegates to the callable and writes nothing itself. The effect —
 * which fields the callable writes, and that re-scoring then skips the pair —
 * is already covered by functions/src/files/__tests__/dismissSuggestionOps and
 * functions/src/matching/__tests__/findTransactionMatches-dismissed. A second
 * client-side writer is exactly what this test exists to catch.
 *
 * Covers repo-root lib/, so it runs under vitest.api-smoke.config.ts ONLY
 * (needs root node_modules for the browser Firebase SDK).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted: vi.mock factories run before module-level consts are initialised,
// and lib/firebase/callable calls httpsCallable at import time for its
// pre-typed callables.
const { httpsCallableMock, callableInvoke } = vi.hoisted(() => ({
  httpsCallableMock: vi.fn(),
  callableInvoke: vi.fn(async () => ({ data: { success: true, dismissedConfidence: 88 } })),
}));

vi.mock("firebase/functions", () => ({
  httpsCallable: (...args: unknown[]) => {
    httpsCallableMock(...args);
    return callableInvoke;
  },
}));

vi.mock("@/lib/firebase/config", () => ({ functions: {}, db: {}, auth: {} }));

// Every Firestore primitive the module imports. The write primitives are the
// point: this test fails the moment the operation reaches for one of them again.
const { updateDoc, writeBatch, getDoc, getDocs } = vi.hoisted(() => ({
  updateDoc: vi.fn(),
  writeBatch: vi.fn(() => ({ update: vi.fn(), set: vi.fn(), commit: vi.fn() })),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
}));

vi.mock("firebase/firestore", () => ({
  collection: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  orderBy: vi.fn(),
  doc: vi.fn(() => ({ id: "file-doc-ref" })),
  arrayUnion: vi.fn(),
  getDoc: (...args: unknown[]) => getDoc(...args),
  getDocs: (...args: unknown[]) => getDocs(...args),
  updateDoc: (...args: unknown[]) => updateDoc(...args),
  writeBatch: (...args: unknown[]) => writeBatch(...args),
  Timestamp: {
    now: () => ({ toDate: () => new Date(0) }),
    fromDate: (d: Date) => ({ toDate: () => d }),
  },
}));

import { dismissTransactionSuggestion } from "@/lib/operations/file-transaction-matching-ops";

// The operation keeps taking an OperationsContext for symmetry with its
// siblings and ignores it; the callable resolves the caller from the auth token.
const ctx = { db: {}, userId: "user-1" } as unknown as Parameters<
  typeof dismissTransactionSuggestion
>[0];

describe("dismissTransactionSuggestion (client operation)", () => {
  beforeEach(() => {
    httpsCallableMock.mockClear();
    callableInvoke.mockClear();
    updateDoc.mockClear();
    writeBatch.mockClear();
    getDoc.mockClear();
  });

  it("calls the dismissTransactionSuggestion callable with the pair", async () => {
    await dismissTransactionSuggestion(ctx, "file-1", "tx-1");

    expect(httpsCallableMock).toHaveBeenCalledTimes(1);
    expect(httpsCallableMock.mock.calls[0][1]).toBe("dismissTransactionSuggestion");
    expect(callableInvoke).toHaveBeenCalledWith({
      fileId: "file-1",
      transactionId: "tx-1",
      reason: undefined,
    });
  });

  it("passes a rejection reason through when one is given", async () => {
    await dismissTransactionSuggestion(ctx, "file-1", "tx-1", "coincidental amount");

    expect(callableInvoke).toHaveBeenCalledWith({
      fileId: "file-1",
      transactionId: "tx-1",
      reason: "coincidental amount",
    });
  });

  it("writes nothing to Firestore from the client", async () => {
    await dismissTransactionSuggestion(ctx, "file-1", "tx-1");

    expect(updateDoc).not.toHaveBeenCalled();
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it("does not read the file document either — the callable owns the check", async () => {
    await dismissTransactionSuggestion(ctx, "file-1", "tx-1");

    // The old implementation read the file to enforce ownership client-side,
    // which the callable does server-side against the auth token. A read here
    // would mean the client is deciding something again.
    expect(getDoc).not.toHaveBeenCalled();
  });

  it("propagates a callable failure instead of swallowing it", async () => {
    callableInvoke.mockRejectedValueOnce(new Error("permission-denied"));

    await expect(dismissTransactionSuggestion(ctx, "file-1", "tx-1")).rejects.toThrow(
      "permission-denied"
    );
  });
});
