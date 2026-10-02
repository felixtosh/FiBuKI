/**
 * The web CSV import goes through bulkCreateTransactions. The server decides
 * what is a duplicate: it derives the hash itself, ignores whatever hash a
 * client sends, and reports how many rows it skipped. The client used to do
 * this check on its own with its own copy of the formula.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { store, createTestContext, createTestSource } from "../test/setup";

vi.mock("firebase-admin/firestore", async () => {
  const { createMockFirestore } = await import("../test/setup");
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
    FieldValue: { serverTimestamp: () => new Date(), increment: (n: number) => n },
    Timestamp: MockTimestamp,
  };
});

vi.mock("../utils/createCallable", () => ({
  createCallable: <TReq, TRes>(_config: unknown, handler: (ctx: unknown, data: TReq) => Promise<TRes>) => handler,
  HttpsError: class HttpsError extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
}));
vi.mock("../billing/checkTransactionQuota", () => ({
  checkTransactionQuota: async () => ({ allowed: true, currentCount: 0, limit: Infinity, remainingSlots: Infinity }),
  incrementTransactionCount: async () => undefined,
}));

const { bulkCreateTransactionsCallable } = await import("./bulkCreateTransactions");
const { computeDedupeHash } = await import("./dedupe");

type Handler = (
  ctx: unknown,
  req: { transactions: unknown[]; sourceId: string }
) => Promise<{ count: number; duplicateCount: number; transactionIds: string[] }>;
const run = bulkCreateTransactionsCallable as unknown as Handler;

const userId = "user-bulk";
const IBAN = "AT611904300234573201";

const tx = (date: string, amount: number, name: string, extra: Record<string, unknown> = {}) => ({
  sourceId: "s1",
  date,
  amount,
  currency: "EUR",
  name,
  importJobId: "job-1",
  _original: { date, amount: String(amount), rawRow: {} },
  ...extra,
});

const send = (transactions: unknown[]) => run(createTestContext(userId), { transactions, sourceId: "s1" });
const stored = () => [...store.getCollection("transactions").values()];

describe("bulkCreateTransactions dedupe", () => {
  beforeEach(() => {
    store.clear();
    store.setDoc("sources", "s1", createTestSource({ userId, iban: IBAN }));
  });

  it("derives the hash on the server and ignores one sent by a client", async () => {
    await send([tx("2026-09-01", -5420, "REWE", { reference: "R1", dedupeHash: "client-made-hash" })]);
    expect(stored()[0].dedupeHash).toBe(
      computeDedupeHash({ date: "2026-09-01", amount: -5420, sourceIdentifier: IBAN, reference: "R1" })
    );
  });

  it("skips rows an earlier import stored and reports the count", async () => {
    await send([tx("2026-09-01", -5420, "REWE"), tx("2026-09-03", -3990, "A1")]);
    const second = await run(createTestContext(userId), {
      sourceId: "s1",
      transactions: [
        tx("2026-09-01", -5420, "REWE", { importJobId: "job-2" }),
        tx("2026-09-20", -980, "Miete", { importJobId: "job-2" }),
      ],
    });
    expect(second.count).toBe(1);
    expect(second.duplicateCount).toBe(1);
    expect(stored()).toHaveLength(3);
  });

  it("keeps identical lines of one import across its chunks", async () => {
    const coffee = tx("2026-09-05", -350, "Cafe Central");
    await send([coffee]);
    const next = await send([coffee]); // same importJobId: the second chunk of the same file
    expect(next.count).toBe(1);
    expect(next.duplicateCount).toBe(0);
    expect(stored()).toHaveLength(2);
  });

  it("an import of nothing but duplicates writes nothing and is not an error", async () => {
    await send([tx("2026-09-01", -5420, "REWE")]);
    const again = await run(createTestContext(userId), {
      sourceId: "s1",
      transactions: [tx("2026-09-01", -5420, "REWE", { importJobId: "job-2" })],
    });
    expect(again).toMatchObject({ count: 0, duplicateCount: 1, transactionIds: [] });
    expect(stored()).toHaveLength(1);
  });
});
