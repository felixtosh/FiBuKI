/**
 * The one-off pass that restates stored NET line items in gross form, on Files
 * whose printed VAT summary block let the rows reconcile while staying net.
 * Runs against the real Postgres-backed shim, like the strip pass beside it.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { getFirestore, __resetFirestoreShim } from "./firestore-shim";
import { grossUpNetLineItems } from "./migrate-gross-up-net-line-items";

const db = getFirestore();

async function tmpBackupDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "gross-up-line-items-"));
}

// The Google Cloud prepayment invoice that surfaced this.
const googleFile = {
  userId: "u1",
  extractedAmount: 2500,
  extractedVatAmount: 417,
  extractedVatPercent: 20,
  extractedRateGroups: [{ rate: 20, net: 2083, vat: 417, gross: 2500 }],
  extractedLineItems: [
    { description: "Prepayment for Gemini API/AI Studio", vatPercent: 20, vatAmount: 417, amount: 2083 },
  ],
  lineItemsUnreconciled: false,
};

beforeEach(async () => {
  await __resetFirestoreShim();
});

describe("grossUpNetLineItems", () => {
  it("restates net rows as gross and backs up what it replaced", async () => {
    await db.collection("files").doc("f1").set(googleFile);

    const backupDir = await tmpBackupDir();
    const report = await grossUpNetLineItems({ backupDir, log: () => {} });

    expect(report).toMatchObject({ documentsScanned: 1, documentsTouched: 1, skippedHandCorrected: [] });
    const after = (await db.collection("files").doc("f1").get()).data()!;
    expect(after.extractedLineItems).toEqual([
      { description: "Prepayment for Gemini API/AI Studio", vatPercent: 20, vatAmount: 417, amount: 2500 },
    ]);
    expect(after.extractedAmount).toBe(2500);
    expect(after.extractedRateGroups).toEqual(googleFile.extractedRateGroups);
    expect(after.lineItemsUnreconciled).toBe(false);

    const backup = JSON.parse(await fs.readFile(report.backupPath!, "utf8"));
    expect(backup).toEqual([{ id: "f1", extractedLineItems: googleFile.extractedLineItems }]);
  });

  it("writes nothing on a dry run", async () => {
    await db.collection("files").doc("f1").set(googleFile);

    const report = await grossUpNetLineItems({ dryRun: true, backupDir: "", log: () => {} });

    expect(report.documentsTouched).toBe(1);
    expect(report.backupPath).toBeNull();
    const after = (await db.collection("files").doc("f1").get()).data()!;
    expect(after.extractedLineItems).toEqual(googleFile.extractedLineItems);
  });

  it("is idempotent", async () => {
    await db.collection("files").doc("f1").set(googleFile);
    const backupDir = await tmpBackupDir();

    await grossUpNetLineItems({ backupDir, log: () => {} });
    const second = await grossUpNetLineItems({ backupDir, log: () => {} });

    expect(second.documentsTouched).toBe(0);
    expect(second.backupPath).toBeNull();
  });

  it("leaves rows that are already gross alone", async () => {
    await db.collection("files").doc("f1").set({
      ...googleFile,
      extractedLineItems: [{ description: "Prepayment", vatPercent: 20, vatAmount: 417, amount: 2500 }],
    });

    const report = await grossUpNetLineItems({ backupDir: await tmpBackupDir(), log: () => {} });

    expect(report.documentsTouched).toBe(0);
  });

  it("skips a File a person corrected by hand and names it", async () => {
    await db.collection("files").doc("f1").set({
      ...googleFile,
      extractionCorrectedFields: { lineItems: new Date("2026-10-05T00:00:00Z") },
    });

    const report = await grossUpNetLineItems({ backupDir: await tmpBackupDir(), log: () => {} });

    expect(report.documentsTouched).toBe(0);
    expect(report.skippedHandCorrected).toEqual(["f1"]);
    const after = (await db.collection("files").doc("f1").get()).data()!;
    expect(after.extractedLineItems).toEqual(googleFile.extractedLineItems);
  });

  it("leaves a File alone when today's reconciliation would change more than the net rows", async () => {
    // A "Total" row the reconciliation would now drop: not this pass's call.
    await db.collection("files").doc("f1").set({
      ...googleFile,
      extractedLineItems: [
        ...googleFile.extractedLineItems,
        { description: "Total in EUR", vatPercent: 20, vatAmount: 417, amount: 2500 },
      ],
    });

    const report = await grossUpNetLineItems({ backupDir: await tmpBackupDir(), log: () => {} });

    expect(report.documentsTouched).toBe(0);
  });
});
