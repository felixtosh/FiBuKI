/**
 * #172: a Trinkgeld printed on a restaurant Beleg is its own figure.
 *
 * The Beleg prints three numbers — Summe (the VAT-bearing total the rate
 * groups add up to), Trinkgeld, Gesamt (what the card charged) — and only
 * one field used to hold them. Whichever the extractor picked, the whole
 * Vorsteuer was lost: the Gesamt broke the printed block's reconciliation,
 * the Summe broke the bank reconcile.
 *
 * Pinned here: the tip is transcribed into its own field, and the printed
 * block is what decides which of the two totals the model actually handed
 * back.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const gemini = vi.hoisted(() => ({ queue: [] as string[] }));

vi.mock("@google-cloud/vertexai", () => ({
  VertexAI: class {
    getGenerativeModel() {
      return {
        generateContent: async () => ({
          response: {
            candidates: [
              { content: { role: "model", parts: [{ text: gemini.queue.shift() ?? "{}" }] } },
            ],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          },
        }),
      };
    }
  },
}));

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({ collection: () => ({}) }),
  Timestamp: { fromDate: (d: Date) => d, now: () => new Date() },
}));
vi.mock("firebase-admin/storage", () => ({ getStorage: () => ({}) }));

import { parseWithGemini } from "../geminiParser";
import { totalWithoutPrintedTip, validateRateGroups } from "../extractionCore";

// The Beleg from the ticket: Summe 50,80 (10% food + 20% drinks),
// Trinkgeld 3,20, Gesamt 54,00.
const PRINTED_BLOCK = [
  { rate: 10, net: 3500, vat: 350, gross: 3850 },
  { rate: 20, net: 1025, vat: 205, gross: 1230 },
];
const SUMME = 5080;
const TRINKGELD = 320;
const GESAMT = 5400;

beforeEach(() => {
  process.env.GCLOUD_PROJECT = "tip-test-project";
  gemini.queue.length = 0;
});

describe("parseWithGemini: tipAmount", () => {
  it("transcribes the printed tip into its own field", async () => {
    gemini.queue.push(
      JSON.stringify({ extracted: { amount: SUMME, tipAmount: TRINKGELD, currency: "EUR" } })
    );
    const res = await parseWithGemini(Buffer.from("x"), "application/pdf");
    expect(res.extracted.amount).toBe(SUMME);
    expect(res.extracted.tipAmount).toBe(TRINKGELD);
  });

  it("accepts the tip at the response top level as a fallback", async () => {
    gemini.queue.push(JSON.stringify({ tipAmount: TRINKGELD, extracted: { amount: SUMME } }));
    const res = await parseWithGemini(Buffer.from("x"), "application/pdf");
    expect(res.extracted.tipAmount).toBe(TRINKGELD);
  });

  it("keeps a document with no tip line at null, and refuses non-numbers", async () => {
    for (const tipAmount of [undefined, null, 0, -320, "3,20"]) {
      gemini.queue.push(JSON.stringify({ extracted: { amount: SUMME, tipAmount } }));
      const res = await parseWithGemini(Buffer.from("x"), "application/pdf");
      expect(res.extracted.tipAmount).toBeNull();
    }
  });
});

describe("totalWithoutPrintedTip", () => {
  it("leaves the Summe alone — the printed block already agrees with it", () => {
    expect(totalWithoutPrintedTip(SUMME, TRINKGELD, PRINTED_BLOCK)).toBe(SUMME);
  });

  it("reads a Gesamt handed back as the total down to the Summe", () => {
    expect(totalWithoutPrintedTip(GESAMT, TRINKGELD, PRINTED_BLOCK)).toBe(SUMME);
  });

  it("does not move the total without a printed block to arbitrate", () => {
    expect(totalWithoutPrintedTip(GESAMT, TRINKGELD, null)).toBe(GESAMT);
    expect(totalWithoutPrintedTip(GESAMT, TRINKGELD, [])).toBe(GESAMT);
  });

  it("does not move the total when the block fits neither reading", () => {
    // OCR damage, not a tip: subtracting here would hide it.
    const damaged = [{ rate: 20, net: 8000, vat: 1600, gross: 9600 }];
    expect(totalWithoutPrintedTip(GESAMT, TRINKGELD, damaged)).toBe(GESAMT);
  });

  it("ignores a tip that is absent, zero or larger than the total", () => {
    expect(totalWithoutPrintedTip(SUMME, null, PRINTED_BLOCK)).toBe(SUMME);
    expect(totalWithoutPrintedTip(SUMME, 0, PRINTED_BLOCK)).toBe(SUMME);
    expect(totalWithoutPrintedTip(TRINKGELD, SUMME, PRINTED_BLOCK)).toBe(TRINKGELD);
  });

  it("leaves the printed block standing, which is the whole point", () => {
    // Against the Gesamt the block sums 320 short and is discarded whole —
    // the branch that used to cost the entire Vorsteuer.
    expect(validateRateGroups(PRINTED_BLOCK, GESAMT)).toBeNull();
    expect(
      validateRateGroups(PRINTED_BLOCK, totalWithoutPrintedTip(GESAMT, TRINKGELD, PRINTED_BLOCK))
    ).toEqual(PRINTED_BLOCK);
  });

  it("passes a missing total through untouched", () => {
    expect(totalWithoutPrintedTip(null, TRINKGELD, PRINTED_BLOCK)).toBeNull();
    expect(totalWithoutPrintedTip(undefined, TRINKGELD, PRINTED_BLOCK)).toBeUndefined();
  });
});
