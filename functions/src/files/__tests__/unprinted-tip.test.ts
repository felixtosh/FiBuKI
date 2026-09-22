/**
 * #217: the Trinkgeld the document never printed, end to end.
 *
 * The printed case was settled by #172 — Summe, Trinkgeld, Gesamt, three
 * numbers on the Beleg and three fields on the record. This is the shape that
 * left no way out: the terminal took a tip, the receipt says nothing about it,
 * so the bank line is larger than a § 11-complete invoice and every consumer
 * reads that gap as an unexplained overpay. `extractedTipAmount` had a reader
 * everywhere and a writer only in the extractor, which can transcribe a tip
 * and cannot invent one.
 *
 * The walk below is the acceptance criterion: the same restaurant invoice
 * before and after a person types the tip, through the scorer that puts it on
 * its bank line and the derivation that claims its Vorsteuer.
 *
 * The trap it guards is the quiet one. A tip on a document whose total never
 * included it must NOT come out of `extractedAmount`: that total already is
 * the VAT-bearing figure, and shrinking it by the tip under-claims the return
 * without anything failing.
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
      return new MockTimestamp(new Date("2026-08-26T12:00:00Z"));
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
      serverTimestamp: () => new Date("2026-08-26T12:00:00Z"),
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

// The refusal under test fires before extraction runs, so the model is never
// reached — but the module is loaded, and it must not be the real one.
vi.mock("../../extraction/extractionCore", () => ({ runExtraction: vi.fn() }));

const { updateFileExtractedFieldsCallable } = await import("../updateFileExtractedFields");
const { retryExtractionForFile } = await import("../../extraction/retryExtractionOps");
const { getFirestore } = await import("firebase-admin/firestore");
const { scoreTransaction, toFileMatchingData, toTransactionData } = await import(
  "../../matching/transactionScoring"
);
const { buildUvaTransaction } = await import("../../uva/adapter");
const { calculateUva } = await import("../../uva/calculateUva");

const userId = "user-1";
const ts = (iso: string) => ({ toDate: () => new Date(iso) });

/**
 * Gasthaus Zur Post, 20.02.2026. A Kleinbetragsrechnung that satisfies § 11
 * Abs 6 on its own: issuer, address, date, the goods, and the tax broken out
 * per rate. 35,00 food at 10% and 12,30 drinks at 20% — 50,80 in total, and
 * 5,55 of Vorsteuer. It prints no tip line, because the tip went in on the
 * card terminal after the Beleg was already out of the printer.
 */
const SUMME = 5080;
const TRINKGELD = 320;
const CARD_CHARGE = 5400;
const VORSTEUER = 555;

const RATE_GROUPS = [
  { rate: 10, net: 3500, vat: 350, gross: 3850 },
  { rate: 20, net: 1025, vat: 205, gross: 1230 },
];

const LINE_ITEMS = [
  { description: "Mittagsmenü", vatPercent: 10, vatAmount: 350, amount: 3850 },
  { description: "Getränke", vatPercent: 20, vatAmount: 205, amount: 1230 },
];

function seed() {
  store.setDoc(
    "files",
    "f-1",
    createTestFile({
      userId,
      fileName: "gasthaus-zur-post.pdf",
      extractionComplete: true,
      extractionError: null,
      extractedAmount: SUMME,
      // The document prints none, and the extractor recorded that absence.
      extractedTipAmount: null,
      extractedCurrency: "EUR",
      extractedDate: ts("2026-02-20T00:00:00Z"),
      extractedRateGroups: RATE_GROUPS,
      extractedLineItems: LINE_ITEMS,
      lineItemsUnreconciled: false,
      extractedPartner: "Gasthaus Zur Post",
      extractedIssuer: { name: "Gasthaus Zur Post e.U.", address: "Wien", vatId: null },
      extractedSelfDesignation: "Rechnung",
      extractedInvoiceNumber: "2026-0412",
      invoiceDirection: "incoming",
      documentType: "invoice",
      transactionIds: ["tx-1"],
    })
  );

  store.setDoc("transactions", "tx-1", {
    userId,
    amount: -CARD_CHARGE,
    date: ts("2026-02-20T00:00:00Z"),
    currency: "EUR",
    name: "GASTHAUS ZUR POST WIEN",
    partner: "Gasthaus Zur Post",
    fileIds: ["f-1"],
  });
}

const file = () => store.getDoc("files", "f-1") as Record<string, unknown>;
const transaction = () => store.getDoc("transactions", "tx-1") as Record<string, unknown>;

/** What the panel posts: the whole extracted record, plus whatever was typed. */
function save(correction: Record<string, unknown> = {}) {
  return (updateFileExtractedFieldsCallable as unknown as {
    run: (r: never) => Promise<{ changed: string[]; correctedFields: string[] }>;
  }).run({
    data: {
      fileId: "f-1",
      correction: {
        amount: SUMME,
        vatPercent: null,
        date: "2026-02-20",
        lineItems: LINE_ITEMS,
        ...correction,
      },
      details: { partner: "Gasthaus Zur Post" },
    },
    auth: { uid: userId },
  } as never);
}

/** The stored record through the scorer, exactly as the matching sweep sees it. */
function score() {
  return scoreTransaction(toFileMatchingData(file()), toTransactionData("tx-1", transaction()));
}

/** The stored record through the UVA derivation for 2026-Q1. */
function uva() {
  return calculateUva({
    period: { year: 2026, period: 1, type: "quarterly" },
    transactions: [
      buildUvaTransaction(
        { id: "tx-1", date: transaction().date as never, amount: -CARD_CHARGE, fileIds: ["f-1"] },
        {
          filesById: new Map([["f-1", { id: "f-1", ...file() } as never]]),
          categoriesById: new Map(),
        }
      ),
    ],
  });
}

beforeEach(() => {
  store.clear();
  seed();
});

describe("a Trinkgeld the document never printed (#217)", () => {
  it("leaves the invoice unmatchable and its Vorsteuer unclaimed until someone says so", () => {
    // The before state, and the reason this ticket exists: 54,00 left the
    // account against a 50,80 invoice, and nothing on the record explains the
    // 3,20. The scorer will not call that the same amount and the derivation
    // refuses the whole claim rather than guess at an overpay.
    expect(score().matchSources).not.toContain("amount_exact");

    const before = uva();
    expect(before.totalInputVat).toBe(0);
    expect(before.unresolved[0].reason).toBe("amount-mismatch");
  });

  it("records the tip beside the total without taking it out of the total", async () => {
    // THE trap. `extractedAmount` on this document already is the VAT-bearing
    // figure — nothing was ever added to it — so subtracting the hand-set tip
    // would shrink the VAT base by 3,20 and under-claim, silently.
    const result = await save({ tipAmount: TRINKGELD });

    expect(result.changed).toEqual(["tipAmount"]);
    expect(file().extractedTipAmount).toBe(TRINKGELD);
    expect(file().extractedAmount).toBe(SUMME);
    // A tip says nothing about the rates, so the printed block that proves
    // what the total contains is left standing.
    expect(file().extractedRateGroups).toEqual(RATE_GROUPS);
    expect(file().lineItemsUnreconciled).toBe(false);
    // Still a § 11-complete invoice: the correction re-derives the
    // classification and must not have demoted it.
    expect(file().documentType).toBe("invoice");
  });

  it("puts the invoice on its bank line and claims the full Vorsteuer", async () => {
    await save({ tipAmount: TRINKGELD });

    // Matching: the bank was charged Summe + Trinkgeld, and now the record
    // says so.
    expect(score().matchSources).toContain("amount_exact");

    // Derivation: the reconcile compares 54,00 against totalGross + tipAmount
    // and comes out exact, so the claim is the document's own VAT in full —
    // and the tip carries none of it.
    const after = uva();
    expect(after.totalInputVat).toBe(VORSTEUER);
    expect(after.kennzahlen["060"].value).toBe(VORSTEUER);
    expect(after.unresolved).toHaveLength(0);
  });

  it("marks the tip as a correction, so re-extraction refuses the file", async () => {
    const result = await save({ tipAmount: TRINKGELD });

    expect(result.correctedFields).toEqual(["tipAmount"]);
    expect(Object.keys(file().extractionCorrectedFields as object)).toEqual(["tipAmount"]);

    await expect(
      retryExtractionForFile(getFirestore(), { fileId: "f-1", userId, force: true })
    ).rejects.toThrow(/tipAmount/);
  });

  it("is not stamped by a save that never touched the tip box", async () => {
    // The panel posts every field on every save, so an empty tip box on a
    // document with no tip has to read as "still no tip" rather than as a
    // ruling that freezes the file against re-extraction.
    const result = await save({ tipAmount: null });

    expect(result.changed).toEqual([]);
    expect(file().extractionCorrectedFields).toBeUndefined();
  });
});
