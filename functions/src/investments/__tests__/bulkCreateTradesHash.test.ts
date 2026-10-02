/**
 * The trade's dedupeHash is computed on the server (imports/dedupe.ts), whatever the client sends.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { store, createMockFirestore, createTestContext, createTestSource } from "../../test/setup";

vi.mock("firebase-admin/firestore", () => {
  class FakeInstant {
    constructor(private readonly d: Date) {}
    static fromDate(d: Date) {
      return new FakeInstant(d);
    }
    static now() {
      return new FakeInstant(new Date());
    }
    toDate() {
      return this.d;
    }
  }
  return { getFirestore: () => createMockFirestore(), FieldValue: { serverTimestamp: () => new Date() }, Timestamp: FakeInstant };
});
vi.mock("../../utils/createCallable", () => ({
  createCallable: <TReq, TRes>(_c: unknown, handler: (ctx: unknown, data: TReq) => Promise<TRes>) => handler,
  HttpsError: class HttpsError extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
}));

const { bulkCreateTradesCallable } = await import("../bulkCreateTrades");
const { computeDedupeHash } = await import("../../imports/dedupe");

const USER = "user-trades";
const run = bulkCreateTradesCallable as unknown as (ctx: unknown, data: unknown) => Promise<{ tradeIds: string[] }>;

const trade = (extra: Record<string, unknown> = {}) => ({
  sourceId: "depot-1",
  date: "2024-01-15T00:00:00.000Z",
  tradeType: "buy",
  assetType: "stock",
  ticker: "AAPL",
  assetName: "Apple Inc.",
  quantity: 10,
  pricePerUnit: 150,
  grossAmount: 1500,
  fees: 1.5,
  netAmount: 1498.5,
  currency: "EUR",
  importJobId: "job-1",
  _original: { date: "", quantity: "", pricePerUnit: "", grossAmount: "", fees: "", rawRow: {} },
  ...extra,
});

beforeEach(() => {
  store.clear();
  store.setDoc("sources", "depot-1", createTestSource({ userId: USER, accountKind: "depot" }));
});

describe("bulkCreateTrades dedupeHash", () => {
  it("is computed from the stored trade, and a hash the client sends is ignored", async () => {
    const { tradeIds } = await run(createTestContext(USER), {
      sourceId: "depot-1",
      trades: [trade({ dedupeHash: "client-made-this-up" })],
    });

    const stored = store.getDoc("investmentTrades", tradeIds[0]) as { dedupeHash: string };
    expect(stored.dedupeHash).not.toBe("client-made-this-up");
    expect(stored.dedupeHash).toBe(
      computeDedupeHash({ date: "2024-01-15T00:00:00.000Z", amount: 1500, sourceIdentifier: "depot-1", reference: "AAPL_buy_10" })
    );
  });

  it("gives different trades different hashes and the same trade the same hash", async () => {
    const { tradeIds } = await run(createTestContext(USER), {
      sourceId: "depot-1",
      trades: [trade(), trade(), trade({ quantity: 11 })],
    });
    const hash = (id: string) => (store.getDoc("investmentTrades", id) as { dedupeHash: string }).dedupeHash;
    expect(hash(tradeIds[0])).toBe(hash(tradeIds[1]));
    expect(hash(tradeIds[2])).not.toBe(hash(tradeIds[0]));
  });
});
