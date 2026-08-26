/**
 * #184: the marker a hand correction leaves behind, and the retro-stamp of the
 * corrections that were made before it existed. What matters here is that the
 * marker is per field and cumulative — a second correction must not erase the
 * first one's provenance — and that the retro-stamp resolves the checked-in
 * list without guessing.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin/firestore", () => ({
  Timestamp: {
    fromDate: (d: Date) => ({ _seconds: Math.floor(d.getTime() / 1000), toDate: () => d }),
    now: () => ({ _seconds: 1000 }),
  },
}));

import {
  buildCorrectionProvenance,
  correctedFieldsOf,
  hasHandCorrections,
} from "../extractionProvenanceOps";

const AT = { _seconds: 42 } as never;

describe("buildCorrectionProvenance", () => {
  it("stamps the fields the correction actually set, and nothing else", () => {
    const updates = buildCorrectionProvenance({}, ["vatPercent"], AT);

    expect(updates.extractionCorrectedFields).toEqual({ vatPercent: AT });
    expect(updates.extractionCorrectedAt).toBe(AT);
  });

  it("merges onto the marks earlier corrections left", () => {
    // paperless-ap-698: the total and the split were corrected first, the rate
    // later. The second correction must not make the first one invisible.
    const previous = { extractionCorrectedFields: { amount: AT, lineItems: AT } };
    const later = { _seconds: 99 } as never;

    const updates = buildCorrectionProvenance(previous, ["vatPercent"], later);

    expect(updates.extractionCorrectedFields).toEqual({
      amount: AT,
      lineItems: AT,
      vatPercent: later,
    });
    // The document-level stamp is the newest correction, not the first.
    expect(updates.extractionCorrectedAt).toBe(later);
  });

  it("re-stamps a field a later correction moved again", () => {
    const later = { _seconds: 99 } as never;
    const updates = buildCorrectionProvenance(
      { extractionCorrectedFields: { amount: AT } },
      ["amount"],
      later
    );

    expect(updates.extractionCorrectedFields).toEqual({ amount: later });
  });

  it("survives a record whose marker is missing or the wrong shape", () => {
    expect(buildCorrectionProvenance(undefined, ["date"], AT).extractionCorrectedFields).toEqual({
      date: AT,
    });
    expect(
      buildCorrectionProvenance({ extractionCorrectedFields: ["amount"] }, ["date"], AT)
        .extractionCorrectedFields
    ).toEqual({ date: AT });
  });
});

describe("correctedFieldsOf", () => {
  it("reads nothing off a record written before the marker existed", () => {
    expect(correctedFieldsOf({})).toEqual([]);
    expect(correctedFieldsOf(undefined)).toEqual([]);
    expect(hasHandCorrections({})).toBe(false);
  });

  it("names the fields in a stable order, whatever order they were written in", () => {
    const record = {
      extractionCorrectedFields: { lineItems: AT, amount: AT, vatPercent: AT },
    };

    expect(correctedFieldsOf(record)).toEqual(["amount", "vatPercent", "lineItems"]);
    expect(hasHandCorrections(record)).toBe(true);
  });

  it("keeps a key it does not recognise rather than dropping it", () => {
    // A field name from a future correction shape still means a person ruled
    // on something, and a refusal that hid it would be worse than a strange one.
    expect(
      correctedFieldsOf({ extractionCorrectedFields: { payableAmount: AT, amount: AT } })
    ).toEqual(["amount", "payableAmount"]);
  });
});
