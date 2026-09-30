/**
 * #136: Transactions imported before transactionType existed get it from the
 * raw row, through the column their Source mapped to the bank's type.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { getFirestore, __resetFirestoreShim } from "./firestore-shim";
import { migrateTransactionType } from "./migrate-transaction-type";

const db = getFirestore();
const silent = () => {};

async function tx(id: string) {
  return (await db.collection("transactions").doc(id).get()).data()!;
}

async function apply(extra: { userId?: string } = {}) {
  const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "tx-type-"));
  return migrateTransactionType({ apply: true, backupDir, log: silent, ...extra });
}

beforeEach(async () => {
  await __resetFirestoreShim();
  await db.collection("sources").doc("s1").set({
    userId: "u1",
    fieldMappings: { mappings: { Buchungsdatum: "date", Buchungsart: "category", Betrag: "amount" } },
  });
  await db.collection("sources").doc("s2").set({ userId: "u1" });
});

describe("migrateTransactionType", () => {
  it("derives the type through the source's mapped column", async () => {
    await db.collection("transactions").doc("t1").set({
      userId: "u1",
      sourceId: "s1",
      _original: { rawRow: { Buchungsart: "SEPA-Lastschrift" } },
    });
    await db.collection("transactions").doc("t2").set({
      userId: "u1",
      sourceId: "s1",
      _original: { rawRow: { Buchungsart: "Sonstiges" } },
    });

    const report = await apply();

    expect(report.typed).toEqual([{ id: "t1", transactionType: "direct_debit" }]);
    expect(report.unknown).toEqual(["t2"]);
    expect((await tx("t1")).transactionType).toBe("direct_debit");
    expect((await tx("t2")).transactionType).toBeNull();
  });

  it("is a dry run by default", async () => {
    await db.collection("transactions").doc("t1").set({
      userId: "u1",
      sourceId: "s1",
      _original: { rawRow: { Buchungsart: "Lastschrift" } },
    });

    const report = await migrateTransactionType({ log: silent });

    expect(report.typed).toHaveLength(1);
    expect((await tx("t1")).transactionType).toBeUndefined();
  });

  it("reads a known type header when the source mapped none (bank APIs, unmapped CSVs)", async () => {
    await db.collection("transactions").doc("t1").set({
      userId: "u1",
      sourceId: "s2",
      _original: { rawRow: { transaction_category: "DIRECT_DEBIT", transaction_type: "DEBIT" } },
    });

    const report = await apply();

    expect(report.typed).toEqual([{ id: "t1", transactionType: "direct_debit" }]);
  });

  it("leaves a Transaction with no type column at all untouched", async () => {
    await db.collection("transactions").doc("t1").set({
      userId: "u1",
      sourceId: "s2",
      _original: { rawRow: { Betrag: "-10,00" } },
    });

    const report = await apply();

    expect(report.noTypeColumn).toBe(1);
    expect("transactionType" in (await tx("t1"))).toBe(false);
  });

  it("never overwrites a type already set, so a second run writes nothing", async () => {
    await db.collection("transactions").doc("t1").set({
      userId: "u1",
      sourceId: "s1",
      transactionType: "card",
      _original: { rawRow: { Buchungsart: "Lastschrift" } },
    });

    const report = await apply();

    expect(report.typed).toEqual([]);
    expect((await tx("t1")).transactionType).toBe("card");
  });

  it("refuses to apply without a backup directory", async () => {
    await expect(migrateTransactionType({ apply: true, log: silent })).rejects.toThrow(/backupDir/);
  });
});
