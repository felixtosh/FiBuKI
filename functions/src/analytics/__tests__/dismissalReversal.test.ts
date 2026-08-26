/**
 * The analytics half of fork #95.
 *
 * A rejection the user took back is kept on the file as history, so both
 * consumers of that history have to know to skip it. Otherwise undo clears the
 * suppression while the reversed rejection goes on feeding the learning export
 * and the accuracy report — the matcher keeps being taught a decision that was
 * reversed, which is worse than never having recorded it.
 *
 * These also pin the compatibility half: records written before fork #95 carry
 * no `undismissedAt` at all and must still read as live rejections.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { store, createMockFirestore } from "../../test/setup";

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
      increment: (n: number) => n,
    },
    Timestamp: MockTimestamp,
  };
});

const { analyzeMatchAccuracyCallable } = await import("../analyzeMatchAccuracy");
const { exportMatchIntelligenceCallable } = await import("../exportMatchIntelligence");
const { Timestamp } = await import("firebase-admin/firestore");

const userId = "user-1";

function call(fn: { run: (r: never) => Promise<unknown> }, data: Record<string, unknown> = {}) {
  return fn.run({ data, auth: { uid: userId } } as never);
}

// Stored timestamps, not raw Dates: the export serialises them via toDate().
const dismissedAt = Timestamp.fromDate(new Date("2026-08-01T00:00:00Z"));
const undismissedAt = Timestamp.fromDate(new Date("2026-08-10T00:00:00Z"));

/** A file carrying one rejection of tx-1, reversed or not. */
function fileWithDismissal(reversed: boolean) {
  return {
    userId,
    fileName: "invoice.pdf",
    dismissedTransactionIds: reversed ? [] : ["tx-1"],
    dismissedTransactions: [
      {
        transactionId: "tx-1",
        dismissedAt,
        confidence: 82,
        reason: "coincidental amount",
        ...(reversed ? { undismissedAt } : {}),
      },
    ],
  };
}

/** exportMatchIntelligence only loads files that appear in a connection. */
function seedConnection() {
  store.setDoc("fileConnections", "c-1", {
    userId,
    fileId: "f-1",
    transactionId: "tx-2",
    connectionType: "manual",
    matchConfidence: null,
    createdAt: dismissedAt,
  });
  store.setDoc("transactions", "tx-2", { userId, name: "Hetzner", amount: -11900 });
}

beforeEach(() => {
  store.clear();
});

describe("analyzeMatchAccuracy: reversed rejections", () => {
  it("counts a rejection that still stands", async () => {
    store.setDoc("files", "f-1", fileWithDismissal(false));

    const result = (await call(analyzeMatchAccuracyCallable)) as {
      analytics: { totalDismissals: number };
    };

    expect(result.analytics.totalDismissals).toBe(1);
  });

  it("does not count a rejection that was taken back", async () => {
    store.setDoc("files", "f-1", fileWithDismissal(true));

    const result = (await call(analyzeMatchAccuracyCallable)) as {
      analytics: { totalDismissals: number };
    };

    expect(result.analytics.totalDismissals).toBe(0);
  });

  it("counts a re-rejection recorded after an undo", async () => {
    store.setDoc("files", "f-1", {
      userId,
      dismissedTransactionIds: ["tx-1"],
      dismissedTransactions: [
        { transactionId: "tx-1", dismissedAt, confidence: 70, undismissedAt: dismissedAt },
        { transactionId: "tx-1", dismissedAt, confidence: 82 },
      ],
    });

    const result = (await call(analyzeMatchAccuracyCallable)) as {
      analytics: { totalDismissals: number };
    };

    // One pair, rejected again — counted once, not twice and not zero.
    expect(result.analytics.totalDismissals).toBe(1);
  });

  it("still reads a pre-#95 record that has no undismissedAt field", async () => {
    store.setDoc("files", "f-1", {
      userId,
      dismissedTransactionIds: ["tx-1"],
      dismissedTransactions: [{ transactionId: "tx-1", dismissedAt, confidence: 82 }],
    });

    const result = (await call(analyzeMatchAccuracyCallable)) as {
      analytics: { totalDismissals: number };
    };

    expect(result.analytics.totalDismissals).toBe(1);
  });
});

describe("exportMatchIntelligence: reversed rejections", () => {
  it("exports a rejection that still stands", async () => {
    seedConnection();
    store.setDoc("files", "f-1", fileWithDismissal(false));

    const result = (await call(exportMatchIntelligenceCallable)) as {
      report: { dismissals: Array<{ fileId: string; transactionId: string }> };
    };

    expect(result.report.dismissals).toEqual([
      expect.objectContaining({ fileId: "f-1", transactionId: "tx-1", confidence: 82 }),
    ]);
  });

  it("omits a rejection that was taken back", async () => {
    seedConnection();
    store.setDoc("files", "f-1", fileWithDismissal(true));

    const result = (await call(exportMatchIntelligenceCallable)) as {
      report: { dismissals: unknown[] };
    };

    // Undo removed the legacy id too, so the legacy pass cannot smuggle it back
    // in with a null confidence — which would be the quiet failure here.
    expect(result.report.dismissals).toEqual([]);
  });

  it("still exports a pre-#95 record that has no undismissedAt field", async () => {
    seedConnection();
    store.setDoc("files", "f-1", {
      userId,
      dismissedTransactionIds: ["tx-1"],
      dismissedTransactions: [{ transactionId: "tx-1", dismissedAt, confidence: 82 }],
    });

    const result = (await call(exportMatchIntelligenceCallable)) as {
      report: { dismissals: unknown[] };
    };

    expect(result.report.dismissals).toHaveLength(1);
  });
});
