/**
 * types/transaction.ts cannot be imported here (functions rootDir is src), so
 * its TransactionType union is hand-kept. A drift would let the UI filter on a
 * value the importer never writes, so the two are compared as text.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TRANSACTION_TYPES } from "./transactionType";

describe("TransactionType sync", () => {
  it("matches the frontend union", () => {
    const source = readFileSync(join(__dirname, "..", "..", "..", "types", "transaction.ts"), "utf8");
    const match = source.match(/export type TransactionType =([^;]+);/);
    expect(match).not.toBeNull();
    const frontend = [...match![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(frontend).toEqual([...TRANSACTION_TYPES]);
  });
});
