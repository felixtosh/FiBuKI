/**
 * An impossible Trinkgeld keeps its transaction OUT of the BMD export, and the
 * run says so (#194).
 *
 * #172 books a printed tip as its own 0% row so the document's rates apply to
 * `bankGross - tip`. Its guard was `tip > 0 && tip < bankGross`, and a tip that
 * is not smaller than the payment — a Gesamt transcribed into the Trinkgeld
 * field, or a bank line smaller than the tip — fell straight through to
 * `splitByRate(bankGross, groups)`: the rates stretched over the whole charge,
 * which is precisely the export the guard exists to prevent, and silently.
 *
 * Skip and report. The transaction is withheld, the run COMPLETES, and every
 * refused document comes back by name with the reason, because a run that
 * drops a booking and only logs it is the same failure wearing a log line.
 *
 * The conservative side is deliberately untouched: `0 < tip < bankGross` still
 * books exactly as #172 left it.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as unzipper from "unzipper";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";
import { getStorage, _resetStorageForTests } from "./storage-shim";
import { waitFor } from "./test-helpers";

import {
  generateBuchungenCsv,
  generateBuchungenCsvWithReport,
  type FileForExport,
  type TransactionForExport,
} from "../bmd-export/bmdCsvGenerators";
import { requestBmdExportCallable } from "../bmd-export/requestBmdExport";
import "../bmd-export/processBmdExportQueue";

const db = getFirestore();
const USER = "stefan-test";

const T = (iso: string) => Timestamp.fromDate(new Date(iso));
const DATE = T("2026-03-15T12:00:00Z");

const BUCHUNGEN_HEADER =
  "satzart;konto;gkto;belegnr;buchdat;belegdat;betrag;bucod;steuer;mwst;text;extbelegnr;symbol;uidnr";

/** Summe 50,80 over two rates — the #172 restaurant Beleg, tip left open. */
const mealBeleg = (tipCents: number): FileForExport => ({
  id: "f-meal",
  fileName: "restaurant-beleg.pdf",
  extractedAmount: 5080,
  extractedTipAmount: tipCents,
  extractedRateGroups: [
    { rate: 10, net: 3500, vat: 350, gross: 3850 },
    { rate: 20, net: 1025, vat: 205, gross: 1230 },
  ],
});

const mealTx = (amountCents: number): TransactionForExport => ({
  id: "t-meal",
  date: DATE,
  amount: amountCents,
  fileIds: ["f-meal"],
});

function run(tx: TransactionForExport, file: FileForExport) {
  return generateBuchungenCsvWithReport([tx], new Map([[file.id, file]]), new Map());
}

/** The booking rows, as `{ betrag, mwst }` in cents/percent. */
function bookedRows(csv: string) {
  return csv
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const cols = line.split(";");
      return {
        gross: Math.round(Number(cols[6].replace(",", ".")) * 100),
        vat: Math.round(Number(cols[8].replace(",", ".")) * 100),
        rate: Number(cols[9]),
      };
    });
}

describe("bmd tip refusal (#194): the fall-through", () => {
  it("refuses when the tip EQUALS the bank amount — the case the `>` guard let through", () => {
    // 54,00 charged, 54,00 read as Trinkgeld. Nothing is bookable here.
    const { csv, skipped } = run(mealTx(-5400), mealBeleg(5400));

    expect(csv).toBe(BUCHUNGEN_HEADER);
    expect(bookedRows(csv)).toEqual([]);
    expect(skipped).toEqual([
      {
        transactionId: "t-meal",
        fileId: "f-meal",
        fileName: "restaurant-beleg.pdf",
        reason:
          "tip (54,00) is not less than the bank amount (54,00); " +
          "correct the tip on this document and re-run",
      },
    ]);
  });

  it("refuses when the tip EXCEEDS the bank amount", () => {
    // Partial payment: 20,00 off the card, the document prints a 3,20 tip on a
    // 54,00 meal and the extraction put the Gesamt in the tip field.
    const { csv, skipped } = run(mealTx(-2000), mealBeleg(5400));

    expect(bookedRows(csv)).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe(
      "tip (54,00) is not less than the bank amount (20,00); " +
        "correct the tip on this document and re-run"
    );
  });

  it("never stretches the document's rates across the tip", () => {
    // The regression this pins: the old fall-through booked 54,00 as
    // 10%/20% rows, asserting Vorsteuer on money the document taxes at nothing.
    const { csv } = run(mealTx(-5400), mealBeleg(5400));

    expect(bookedRows(csv).map((r) => r.rate)).not.toContain(20);
    expect(bookedRows(csv).map((r) => r.rate)).not.toContain(10);
    expect(csv.split("\n")).toHaveLength(1);
  });

  it("withholds only the offending transaction — the rest of the run books", () => {
    const clean: TransactionForExport = {
      id: "t-clean",
      date: DATE,
      amount: -12000,
      fileIds: ["f-invoice"],
    };
    const invoice: FileForExport = {
      id: "f-invoice",
      fileName: "hosting-rechnung.pdf",
      extractedAmount: 12000,
      extractedVatAmount: 2000,
      extractedVatPercent: 20,
    };
    const files = new Map([
      ["f-meal", mealBeleg(5400)],
      ["f-invoice", invoice],
    ]);

    const { csv, skipped } = generateBuchungenCsvWithReport(
      [mealTx(-5400), clean],
      files,
      new Map()
    );

    expect(skipped.map((s) => s.fileName)).toEqual(["restaurant-beleg.pdf"]);
    expect(bookedRows(csv)).toEqual([{ gross: 12000, vat: 2000, rate: 20 }]);
    // Belegnummern advance per transaction, refused ones included, so they
    // still line up with generateFileMapping's numbering.
    expect(csv.split("\n")[1].split(";")[3]).toBe("2026000002");
  });

  it("sums the tip across every document on the transaction, and names them all", () => {
    // Two Belege settled on one card payment, 27,00 read as Trinkgeld on each.
    // Neither tip on its own reaches the 54,00 charged; together they are the
    // whole of it, and the figure the guard compares is the SUM.
    const half = (id: string, fileName: string): FileForExport => ({
      id,
      fileName,
      extractedAmount: 2540,
      extractedTipAmount: 2700,
      extractedRateGroups: [
        { rate: 10, net: 1750, vat: 175, gross: 1925 },
        { rate: 20, net: 512, vat: 103, gross: 615 },
      ],
    });
    const files = new Map([
      ["f-a", half("f-a", "beleg-a.pdf")],
      ["f-b", half("f-b", "beleg-b.pdf")],
    ]);
    const tx: TransactionForExport = {
      id: "t-two",
      date: DATE,
      amount: -5400,
      fileIds: ["f-a", "f-b"],
    };

    const { csv, skipped } = generateBuchungenCsvWithReport([tx], files, new Map());

    expect(bookedRows(csv)).toEqual([]);
    // Both documents carry the figure, so both are named — correcting one of
    // them is not enough to get the transaction booked.
    expect(skipped.map((s) => s.fileName)).toEqual(["beleg-a.pdf", "beleg-b.pdf"]);
    expect(skipped[0].reason).toBe(
      "tip (54,00) is not less than the bank amount (54,00); " +
        "correct the tip on this document and re-run"
    );
  });
});

describe("bmd tip refusal (#194): what must not change", () => {
  it("books 0 < tip < bankGross exactly as #172 left it", () => {
    // Summe 50,80 (10% + 20%), Trinkgeld 3,20, Gesamt 54,00.
    const { csv, skipped } = run(mealTx(-5400), mealBeleg(320));

    expect(skipped).toEqual([]);
    expect(bookedRows(csv)).toEqual([
      { gross: 3850, vat: 350, rate: 10 },
      { gross: 1230, vat: 205, rate: 20 },
      { gross: 320, vat: 0, rate: 0 },
    ]);
  });

  it("books a tip one cent under the bank amount — the guard stops at `>=`", () => {
    // The boundary from the safe side. 53,99 of a 54,00 charge read as
    // Trinkgeld is nonsense too, but it is the conservative nonsense this
    // ticket leaves alone: it understates the VAT base instead of stretching
    // the document's rates over money the document taxes at nothing.
    const { csv, skipped } = run(mealTx(-5400), mealBeleg(5399));

    expect(skipped).toEqual([]);
    const rows = bookedRows(csv);
    expect(rows.reduce((s, r) => s + r.gross, 0)).toBe(5400);
    expect(rows[rows.length - 1]).toEqual({ gross: 5399, vat: 0, rate: 0 });
  });

  it("books a document without a tip across the full bank amount", () => {
    const noTip = { ...mealBeleg(0), extractedAmount: 5080 };
    const { csv, skipped } = run(mealTx(-5080), noTip);

    expect(skipped).toEqual([]);
    expect(bookedRows(csv).reduce((s, r) => s + r.gross, 0)).toBe(5080);
  });

  it("generateBuchungenCsv still returns the CSV alone", () => {
    const files = new Map([["f-meal", mealBeleg(320)]]);
    expect(generateBuchungenCsv([mealTx(-5400)], files, new Map())).toBe(
      run(mealTx(-5400), mealBeleg(320)).csv
    );
  });
});

/* ------------------------------------------------------------------ */
/* The run report, end to end                                          */
/* ------------------------------------------------------------------ */

beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 20));
  await __resetFirestoreShim();
  __resetTriggerShim();
  process.env.FIBUKI_STORAGE = "memory";
  _resetStorageForTests();
});

async function openZip(storagePath: string) {
  const [buf] = await getStorage().bucket().file(storagePath).download();
  const dir = await unzipper.Open.buffer(buf);
  const entry = async (name: string) => {
    const f = dir.files.find((f) => f.path === name);
    expect(f, `zip entry ${name}`).toBeDefined();
    return (await f!.buffer()).toString("utf8");
  };
  return { dir, entry };
}

describe("bmd tip refusal (#194): the export run reports it", () => {
  it("completes, and names the refused document and the reason on the run", async () => {
    await db.collection("files").doc("f-meal").set({
      userId: USER,
      fileName: "restaurant-beleg.pdf",
      extractedDate: T("2026-03-15T12:00:00Z"),
      extractedAmount: 5080,
      extractedTipAmount: 5400,
      extractedRateGroups: [
        { rate: 10, net: 3500, vat: 350, gross: 3850 },
        { rate: 20, net: 1025, vat: 205, gross: 1230 },
      ],
    });
    await db.collection("files").doc("f-invoice").set({
      userId: USER,
      fileName: "hosting-rechnung.pdf",
      extractedDate: T("2026-03-10T12:00:00Z"),
      extractedAmount: 12000,
      extractedVatAmount: 2000,
      extractedVatPercent: 20,
    });
    await db.collection("transactions").doc("t-meal").set({
      userId: USER,
      date: T("2026-03-15T12:00:00Z"),
      amount: -5400,
      name: "RESTAURANT",
      fileIds: ["f-meal"],
    });
    await db.collection("transactions").doc("t-clean").set({
      userId: USER,
      date: T("2026-03-16T12:00:00Z"),
      amount: -12000,
      name: "HOSTING",
      fileIds: ["f-invoice"],
    });

    const res = await requestBmdExportCallable.run({
      data: { dateFrom: "2026-01-01", dateTo: "2026-12-31", onlyWithFiles: true, includeFiles: false },
      auth: { uid: USER },
    } as never);
    const exportRef = db.collection("bmdExports").doc(res.exportId);
    await waitFor(async () => {
      const status = (await exportRef.get()).data()!.status;
      return status === "completed" || status === "failed";
    });

    const doc = (await exportRef.get()).data()!;
    // Non-blocking: one misextraction must not hold a filing hostage.
    expect(doc.status).toBe("completed");
    expect(doc.skipped).toEqual([
      {
        transactionId: "t-meal",
        fileId: "f-meal",
        fileName: "restaurant-beleg.pdf",
        reason:
          "tip (54,00) is not less than the bank amount (54,00); " +
          "correct the tip on this document and re-run",
      },
    ]);

    const zip = await openZip(doc.storagePath);
    const buchungen = await zip.entry("buchungen.csv");
    expect(buchungen).not.toContain("RESTAURANT");
    expect(buchungen).toContain("HOSTING");

    const manifest = JSON.parse(await zip.entry("manifest.json"));
    expect(manifest.skipped).toEqual(doc.skipped);
  });

  it("reports nothing on a clean run", async () => {
    await db.collection("files").doc("f-invoice").set({
      userId: USER,
      fileName: "hosting-rechnung.pdf",
      extractedAmount: 12000,
      extractedVatAmount: 2000,
      extractedVatPercent: 20,
    });
    await db.collection("transactions").doc("t-clean").set({
      userId: USER,
      date: T("2026-03-16T12:00:00Z"),
      amount: -12000,
      fileIds: ["f-invoice"],
    });

    const res = await requestBmdExportCallable.run({
      data: { dateFrom: "2026-01-01", dateTo: "2026-12-31", onlyWithFiles: true, includeFiles: false },
      auth: { uid: USER },
    } as never);
    const exportRef = db.collection("bmdExports").doc(res.exportId);
    await waitFor(async () => (await exportRef.get()).data()!.status === "completed");

    expect((await exportRef.get()).data()!.skipped).toEqual([]);
  });
});
