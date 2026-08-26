/**
 * The rate detector (#203): a document printing a VAT rate Austria does not
 * have goes into a queryable review queue instead of waiting for the next
 * hand sweep of the corpus.
 */

import { describe, it, expect } from "vitest";
import {
  reviewFileRecordVatRates,
  reviewVatRates,
  toVatRateFacts,
  vatRateReviewFields,
} from "./vatRateReview";

const T = (iso: string) => ({ toDate: () => new Date(iso) });

describe("reviewVatRates", () => {
  it("passes the Austrian set 0/10/13/20", () => {
    for (const rate of [0, 10, 13, 20]) {
      expect(reviewVatRates({ date: "2026-02-18", vatPercent: rate })).toEqual({
        ratesOutsideSet: [],
        needsReview: false,
      });
    }
  });

  it("flags 11% — the Versicherungssteuer case this exists for", () => {
    // paperless-ap-1004: Filmproduktionshaftpflicht, printed rate-group block.
    const result = reviewVatRates({
      date: "2026-02-18",
      supplierVatId: "ATU12345678",
      rateGroups: [{ rate: 11 }],
    });

    expect(result).toEqual({ ratesOutsideSet: [11], needsReview: true });
  });

  it("reads every place a rate can be printed", () => {
    const result = reviewVatRates({
      date: "2026-02-18",
      vatPercent: 7,
      rateGroups: [{ rate: 20 }, { rate: 11 }],
      lineItems: [{ vatPercent: 10 }, { vatPercent: 5.5 }],
    });

    expect(result.ratesOutsideSet).toEqual([5.5, 7, 11]);
  });

  it("reports each offending rate once", () => {
    const result = reviewVatRates({
      date: "2026-02-18",
      lineItems: [{ vatPercent: 11 }, { vatPercent: 11 }],
    });

    expect(result.ratesOutsideSet).toEqual([11]);
  });

  it("follows the period rate set: 4.9% is a defect before it exists and fine after", () => {
    expect(reviewVatRates({ date: "2026-06-30", vatPercent: 4.9 }).needsReview).toBe(true);
    expect(reviewVatRates({ date: "2026-07-01", vatPercent: 4.9 }).needsReview).toBe(false);
  });

  it("accepts 19% only on an Austrian UID (Jungholz/Mittelberg, §10 Abs 4)", () => {
    expect(
      reviewVatRates({ date: "2026-02-18", vatPercent: 19, supplierVatId: "ATU12345678" })
        .needsReview
    ).toBe(false);
    expect(
      reviewVatRates({ date: "2026-02-18", vatPercent: 19, supplierVatId: "DE123456789" })
        .ratesOutsideSet
    ).toEqual([19]);
  });

  it("widens to every ever-Austrian rate when the document date is unknown", () => {
    // A missing date must never manufacture a flag — but 11% is outside the
    // set on every date there has ever been.
    expect(reviewVatRates({ vatPercent: 4.9 }).needsReview).toBe(false);
    expect(reviewVatRates({ vatPercent: 11 }).needsReview).toBe(true);
  });

  it("says nothing about a file already ruled out as a financial document", () => {
    expect(
      reviewVatRates({ date: "2026-02-18", vatPercent: 11, isNotInvoice: true }).needsReview
    ).toBe(false);
  });

  it("ignores rates that are not numbers", () => {
    expect(
      reviewVatRates({
        date: "2026-02-18",
        vatPercent: null,
        lineItems: [{ vatPercent: null }, {}],
      }).needsReview
    ).toBe(false);
  });
});

describe("toVatRateFacts", () => {
  it("reads the calendar day off a stored Timestamp", () => {
    expect(toVatRateFacts({ extractedDate: T("2026-02-18T00:00:00Z") }).date).toBe(
      "2026-02-18"
    );
  });

  it("prefers the issuer UID over the flat legacy field", () => {
    const facts = toVatRateFacts({
      extractedIssuer: { vatId: "ATU99999999" },
      extractedVatId: "DE123456789",
    });
    expect(facts.supplierVatId).toBe("ATU99999999");
  });
});

describe("reviewFileRecordVatRates", () => {
  it("flags the stored paperless-ap-1004 record", () => {
    const result = reviewFileRecordVatRates({
      extractedDate: T("2026-02-18T00:00:00Z"),
      extractedAmount: 22200,
      extractedIssuer: { vatId: "ATU12345678" },
      extractedRateGroups: [{ rate: 11, net: 20000, vat: 2200, gross: 22200 }],
    });

    expect(vatRateReviewFields(result)).toEqual({
      needsVatRateReview: true,
      vatRatesOutsideSet: [11],
    });
  });

  it("writes the flag as false rather than omitting it, so the queue can be queried", () => {
    const result = reviewFileRecordVatRates({ extractedVatPercent: 20 });
    expect(vatRateReviewFields(result)).toEqual({
      needsVatRateReview: false,
      vatRatesOutsideSet: [],
    });
  });
});
