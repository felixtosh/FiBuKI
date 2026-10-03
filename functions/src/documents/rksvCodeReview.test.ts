import { describe, it, expect } from "vitest";
import { reviewRksvCode, reviewFileRecordRksvCode, rksvCodeReviewFields } from "./rksvCodeReview";

const code = (buckets: string, counter = "x") =>
  `_R1-AT1_K1_42_2026-05-02T10:00:00_${buckets}_${counter}_y_z_sig`;

// The model transposed 10 % and 13 %: the code says 11,60 at 10 % and 11,00 at 13 %.
const TRANSPOSED = [
  { rate: 10, gross: 1100 },
  { rate: 13, gross: 1160 },
];

describe("reviewRksvCode (#166)", () => {
  it("names the rates at which a printed block and the code disagree", () => {
    expect(
      reviewRksvCode({
        qrCodes: [code("0,00_11,60_11,00_0,00_0,00")],
        rateGroups: TRANSPOSED,
        rateGroupsSource: "document",
        documentTotal: 2260,
      })
    ).toEqual({ disagreeingRates: [10, 13], needsReview: true });
  });

  it("is quiet when they agree", () => {
    expect(
      reviewRksvCode({
        qrCodes: [code("0,00_11,00_11,60_0,00_0,00")],
        rateGroups: TRANSPOSED,
        rateGroupsSource: "document",
        documentTotal: 2260,
      }).needsReview
    ).toBe(false);
  });

  it("compares only the buckets that name one rate", () => {
    // A 4.9 % printed row against an amount in Besonders: nothing to compare.
    expect(
      reviewRksvCode({
        qrCodes: [code("12,00_0,00_0,00_0,00_10,49")],
        rateGroups: [
          { rate: 20, gross: 1200 },
          { rate: 4.9, gross: 1049 },
        ],
        rateGroupsSource: "document",
        documentTotal: 2249,
      }).needsReview
    ).toBe(false);
  });

  it("does not judge groups taken from the code, or of unknown source", () => {
    for (const rateGroupsSource of ["rksvCode", null] as const) {
      expect(
        reviewRksvCode({
          qrCodes: [code("0,00_11,60_11,00_0,00_0,00")],
          rateGroups: TRANSPOSED,
          rateGroupsSource,
          documentTotal: 2260,
        }).needsReview
      ).toBe(false);
    }
  });

  it("does not judge a code that is not a full sale", () => {
    const facts = { rateGroups: TRANSPOSED, rateGroupsSource: "document" as const };
    // Partial cash payment: the buckets cover less than the total.
    expect(reviewRksvCode({ ...facts, qrCodes: [code("0,00_11,60_0,00_0,00_0,00")], documentTotal: 2260 }).needsReview).toBe(false);
    // Training and cancellation receipts.
    expect(reviewRksvCode({ ...facts, qrCodes: [code("0,00_11,60_11,00_0,00_0,00", "VFJB")], documentTotal: 2260 }).needsReview).toBe(false);
    expect(reviewRksvCode({ ...facts, qrCodes: [code("0,00_11,60_11,00_0,00_0,00", "U1RP")], documentTotal: 2260 }).needsReview).toBe(false);
  });

  it("re-parses a code stored in the #540 shape instead of trusting it", () => {
    const stored = {
      format: "rksv",
      payload: code("0,00_11,60_11,00_0,00_0,00"),
      grossByRate: [{ rate: 20, gross: 2260 }],
    };
    expect(
      reviewFileRecordRksvCode({
        extractedQrCodes: [stored],
        extractedRateGroups: TRANSPOSED,
        extractedRateGroupsSource: "document",
        extractedAmount: 2260,
      })
    ).toEqual({ disagreeingRates: [10, 13], needsReview: true });
  });

  it("clears on a File that is not an invoice or has no groups left", () => {
    const record = {
      extractedQrCodes: [code("0,00_11,60_11,00_0,00_0,00")],
      extractedRateGroupsSource: "document",
      extractedAmount: 2260,
    };
    expect(reviewFileRecordRksvCode({ ...record, extractedRateGroups: null }).needsReview).toBe(false);
    expect(
      reviewFileRecordRksvCode({ ...record, extractedRateGroups: TRANSPOSED, isNotInvoice: true }).needsReview
    ).toBe(false);
  });

  it("writes the flag and the rates", () => {
    expect(rksvCodeReviewFields({ disagreeingRates: [10], needsReview: true })).toEqual({
      needsRksvCodeReview: true,
      rksvCodeDisagreeingRates: [10],
    });
  });
});
