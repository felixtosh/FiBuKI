/**
 * #254: the strip pass runs against the REAL Postgres-backed shim (no mocks),
 * the same way migrate-rewrite-urls.ts's sibling would be tested — proving
 * the write actually lands in the self-host store, not just that the
 * in-memory computation is right.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { getFirestore, __resetFirestoreShim } from "./firestore-shim";
import { stripLineItemFields } from "./migrate-strip-line-item-fields";

const db = getFirestore();

async function tmpBackupDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "strip-line-items-"));
}

beforeEach(async () => {
  await __resetFirestoreShim();
});

describe("stripLineItemFields", () => {
  it("drops quantity/unitPrice from a legacy row and leaves the rest", async () => {
    await db.collection("files").doc("f1").set({
      userId: "u1",
      extractedLineItems: [
        { description: "Kaffee", vatPercent: 20, vatAmount: 100, amount: 600, quantity: 2, unitPrice: 300 },
      ],
    });

    const backupDir = await tmpBackupDir();
    const report = await stripLineItemFields({ backupDir });

    expect(report).toMatchObject({ documentsScanned: 1, documentsTouched: 1, rowsRewritten: 1 });
    expect(report.backupPath).not.toBeNull();

    const after = (await db.collection("files").doc("f1").get()).data()!;
    expect(after.extractedLineItems).toEqual([
      { description: "Kaffee", vatPercent: 20, vatAmount: 100, amount: 600 },
    ]);

    const backupContents = JSON.parse(await fs.readFile(report.backupPath!, "utf8"));
    expect(backupContents).toEqual([
      {
        id: "f1",
        extractedLineItems: [
          { description: "Kaffee", vatPercent: 20, vatAmount: 100, amount: 600, quantity: 2, unitPrice: 300 },
        ],
      },
    ]);
  });

  it("leaves an already-clean row untouched and writes no backup", async () => {
    await db.collection("files").doc("f2").set({
      userId: "u1",
      extractedLineItems: [{ description: "Zimmer", vatPercent: 10, vatAmount: 50, amount: 550 }],
    });

    const backupDir = await tmpBackupDir();
    const report = await stripLineItemFields({ backupDir });

    expect(report).toMatchObject({ documentsScanned: 1, documentsTouched: 0, rowsRewritten: 0 });
    expect(report.backupPath).toBeNull();
    expect(await fs.readdir(backupDir)).toEqual([]);
  });

  it("skips documents with no extractedLineItems", async () => {
    await db.collection("files").doc("f3").set({ userId: "u1" });
    await db.collection("files").doc("f4").set({ userId: "u1", extractedLineItems: null });

    const backupDir = await tmpBackupDir();
    const report = await stripLineItemFields({ backupDir });

    expect(report).toMatchObject({ documentsScanned: 2, documentsTouched: 0, rowsRewritten: 0 });
  });

  it("strips only the affected rows within a multi-row document", async () => {
    await db.collection("files").doc("f5").set({
      userId: "u1",
      extractedLineItems: [
        { description: "Kaffee", vatPercent: 20, vatAmount: 100, amount: 600, quantity: 2, unitPrice: 300 },
        { description: "Zimmer", vatPercent: 10, vatAmount: 50, amount: 550 },
      ],
    });

    const backupDir = await tmpBackupDir();
    const report = await stripLineItemFields({ backupDir });

    expect(report).toMatchObject({ documentsScanned: 1, documentsTouched: 1, rowsRewritten: 1 });
    const after = (await db.collection("files").doc("f5").get()).data()!;
    expect(after.extractedLineItems).toEqual([
      { description: "Kaffee", vatPercent: 20, vatAmount: 100, amount: 600 },
      { description: "Zimmer", vatPercent: 10, vatAmount: 50, amount: 550 },
    ]);
  });

  it("is idempotent: a second run reports zero rows rewritten", async () => {
    await db.collection("files").doc("f6").set({
      userId: "u1",
      extractedLineItems: [
        { description: "Kaffee", vatPercent: 20, vatAmount: 100, amount: 600, quantity: 2, unitPrice: 300 },
      ],
    });

    const backupDir = await tmpBackupDir();
    const first = await stripLineItemFields({ backupDir });
    expect(first.rowsRewritten).toBe(1);

    const second = await stripLineItemFields({ backupDir });
    expect(second).toMatchObject({ documentsTouched: 0, rowsRewritten: 0 });
    expect(second.backupPath).toBeNull();
  });

  it("dry run writes nothing and takes no backup", async () => {
    await db.collection("files").doc("f7").set({
      userId: "u1",
      extractedLineItems: [
        { description: "Kaffee", vatPercent: 20, vatAmount: 100, amount: 600, quantity: 2, unitPrice: 300 },
      ],
    });

    const backupDir = await tmpBackupDir();
    const report = await stripLineItemFields({ backupDir, dryRun: true });

    expect(report).toMatchObject({ documentsTouched: 1, rowsRewritten: 1, backupPath: null });
    expect(await fs.readdir(backupDir)).toEqual([]);

    const after = (await db.collection("files").doc("f7").get()).data()!;
    expect(after.extractedLineItems).toEqual([
      { description: "Kaffee", vatPercent: 20, vatAmount: 100, amount: 600, quantity: 2, unitPrice: 300 },
    ]);
  });

  /**
   * The dominant legacy shape: the pre-#252 normaliser wrote both keys on
   * every row, and left them null when the document printed no quantity or
   * the unit price could not be inferred. A strip that keyed on the VALUE
   * rather than the key's presence would walk past the whole corpus.
   */
  it("strips the two keys when their values are null", async () => {
    await db.collection("files").doc("f8").set({
      userId: "u1",
      extractedLineItems: [
        { description: "Kaffee", vatPercent: 20, vatAmount: 100, amount: 600, quantity: null, unitPrice: null },
      ],
    });

    const backupDir = await tmpBackupDir();
    const report = await stripLineItemFields({ backupDir });

    expect(report).toMatchObject({ documentsTouched: 1, rowsRewritten: 1 });
    const after = (await db.collection("files").doc("f8").get()).data()!;
    expect(after.extractedLineItems).toEqual([
      { description: "Kaffee", vatPercent: 20, vatAmount: 100, amount: 600 },
    ]);
  });

  /** Either key alone is enough to make a row dirty, across several documents. */
  it("strips a row carrying only one of the two keys, in either document", async () => {
    await db.collection("files").doc("f9").set({
      userId: "u1",
      extractedLineItems: [
        { description: "Kaffee", vatPercent: 20, vatAmount: 100, amount: 600, quantity: 2 },
      ],
    });
    await db.collection("files").doc("f10").set({
      userId: "u1",
      extractedLineItems: [
        { description: "Zimmer", vatPercent: 10, vatAmount: 50, amount: 550, unitPrice: 550 },
      ],
    });

    const backupDir = await tmpBackupDir();
    const report = await stripLineItemFields({ backupDir });

    expect(report).toMatchObject({ documentsScanned: 2, documentsTouched: 2, rowsRewritten: 2 });
    expect((await db.collection("files").doc("f9").get()).data()!.extractedLineItems).toEqual([
      { description: "Kaffee", vatPercent: 20, vatAmount: 100, amount: 600 },
    ]);
    expect((await db.collection("files").doc("f10").get()).data()!.extractedLineItems).toEqual([
      { description: "Zimmer", vatPercent: 10, vatAmount: 50, amount: 550 },
    ]);

    const backupContents = JSON.parse(await fs.readFile(report.backupPath!, "utf8"));
    expect(backupContents.map((e: { id: string }) => e.id).sort()).toEqual(["f10", "f9"]);
  });

  /**
   * The strip removes two named keys rather than rebuilding the row from the
   * four surviving ones: a key nobody enumerated here is data, and this pass
   * is not the place it gets dropped.
   */
  it("keeps a key outside the four surviving fields", async () => {
    await db.collection("files").doc("f11").set({
      userId: "u1",
      extractedLineItems: [
        {
          description: "Kaffee",
          vatPercent: 20,
          vatAmount: 100,
          amount: 600,
          quantity: 2,
          unitPrice: 300,
          key: "kaffee",
        },
      ],
    });

    const backupDir = await tmpBackupDir();
    await stripLineItemFields({ backupDir });

    const after = (await db.collection("files").doc("f11").get()).data()!;
    expect(after.extractedLineItems).toEqual([
      { description: "Kaffee", vatPercent: 20, vatAmount: 100, amount: 600, key: "kaffee" },
    ]);
  });
});
