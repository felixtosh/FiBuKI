/**
 * The repair detector (#275): a value the JSON repair had to guess at gets a
 * queryable flag, so the guess is not invisible on the stored record.
 *
 * The judgement itself is made by `escapeInvalidBackslashes` in the parser and
 * pinned in `__tests__/extraction-characterization.test.ts` — the only place
 * that knows which string literals the pass modified. What this module owns is
 * the flag's shape, and the two states that must never carry one.
 */

import { describe, it, expect } from "vitest";
import { repairReviewFields, retireRepairAmbiguity, reviewRepair } from "./repairReview";

describe("reviewRepair", () => {
  it("is silent when the pass had nothing to guess at", () => {
    for (const fields of [undefined, null, []]) {
      expect(reviewRepair({ ambiguousFields: fields })).toEqual({
        ambiguousFields: [],
        needsReview: false,
      });
    }
  });

  it("flags and names the fields the pass reported", () => {
    expect(reviewRepair({ ambiguousFields: ["address", "invoiceNumber"] })).toEqual({
      ambiguousFields: ["address", "invoiceNumber"],
      needsReview: true,
    });
  });

  it("deduplicates and drops blanks, keeping the order the pass saw", () => {
    expect(
      reviewRepair({ ambiguousFields: ["address", " ", "address", " partner "] }),
    ).toEqual({ ambiguousFields: ["address", "partner"], needsReview: true });
  });

  it("holds no flag for a document that is not a financial document", () => {
    // Its extracted values were cleared, so there is no transcription left to
    // doubt — the same rule the rate and direction reviews follow.
    expect(reviewRepair({ ambiguousFields: ["address"], isNotInvoice: true })).toEqual({
      ambiguousFields: [],
      needsReview: false,
    });
  });
});

describe("repairReviewFields", () => {
  it("writes the queryable flag and the field names", () => {
    expect(repairReviewFields(reviewRepair({ ambiguousFields: ["address"] }))).toEqual({
      needsRepairReview: true,
      repairAmbiguousFields: ["address"],
    });

    expect(repairReviewFields(reviewRepair({}))).toEqual({
      needsRepairReview: false,
      repairAmbiguousFields: [],
    });
  });
});

describe("retireRepairAmbiguity (#301)", () => {
  const flagged = {
    needsRepairReview: true,
    repairAmbiguousFields: ["address", "date_raw", "rawText"],
  };

  it("drops the response keys a corrected field was read from", () => {
    expect(retireRepairAmbiguity(flagged, ["extractedAddress"])).toEqual({
      needsRepairReview: true,
      repairAmbiguousFields: ["date_raw", "rawText"],
    });
  });

  it("clears the flag when the list empties", () => {
    const record = { needsRepairReview: true, repairAmbiguousFields: ["address", "date"] };
    expect(retireRepairAmbiguity(record, ["extractedAddress", "extractedDate"])).toEqual({
      needsRepairReview: false,
      repairAmbiguousFields: [],
    });
  });

  it("writes nothing when the correction touches no flagged field", () => {
    expect(retireRepairAmbiguity(flagged, ["extractedAmount", "extractedIban"])).toEqual({});
    expect(retireRepairAmbiguity(flagged, ["updatedAt", "extractionCorrectedFields"])).toEqual({});
  });

  it("writes nothing for a record that was never flagged", () => {
    expect(retireRepairAmbiguity({}, ["extractedAddress"])).toEqual({});
    expect(
      retireRepairAmbiguity({ needsRepairReview: false, repairAmbiguousFields: [] }, ["extractedAddress"])
    ).toEqual({});
  });

  it("keeps a key no hand correction can reach", () => {
    // `rawText` is not a field the panel edits, so nothing retires it.
    const record = { needsRepairReview: true, repairAmbiguousFields: ["rawText"] };
    expect(
      retireRepairAmbiguity(record, [
        "extractedAmount",
        "extractedVatPercent",
        "extractedDate",
        "extractedTipAmount",
        "extractedLineItems",
        "extractedPartner",
        "extractedVatId",
        "extractedIban",
        "extractedAddress",
      ])
    ).toEqual({});
  });
});
