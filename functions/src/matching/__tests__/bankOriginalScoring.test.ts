/**
 * #112 — scoring a foreign-currency pair off the bank's stated original.
 *
 * Figures are real rows from this instance: a USD 24.00 Notion invoice settled
 * as EUR 20.77, and a USD 4.00 GitHub receipt that the pre-#112 scorer attached
 * to a USD 9.03 payment because a 5%/20% FX band could not object to it.
 */

import { describe, it, expect } from "vitest";
import { calculateAmountScore } from "../transactionScoring";

const usd24 = { amount: 2400, currency: "USD", rate: 0.8654166667 };

describe("calculateAmountScore — bank-stated original amount", () => {
  it("scores a cent-exact original as a same-currency exact match", () => {
    const r = calculateAmountScore(2400, -2077, "USD", "EUR", usd24);
    expect(r.score).toBe(40);
    expect(r.source).toBe("amount_exact");
    // False is the point: this pair must qualify for the hard-facts bonus (#78)
    // exactly as the equivalent domestic payment does.
    expect(r.currencyMismatch).toBe(false);
  });

  it("beats what the FX-plausibility path scored for the same pair", () => {
    const withOriginal = calculateAmountScore(2400, -2077, "USD", "EUR", usd24);
    const withoutOriginal = calculateAmountScore(2400, -2077, "USD", "EUR");
    expect(withoutOriginal.score).toBe(30);
    expect(withoutOriginal.source).toBe("amount_close");
    expect(withoutOriginal.currencyMismatch).toBe(true);
    expect(withGreaterScore(withOriginal.score, withoutOriginal.score)).toBe(true);
  });

  it("still runs the tolerance ladder when the original is close but not exact", () => {
    // Document 24.50, bank charged 24.00 — 2.08% apart, within the 5% rung.
    expect(calculateAmountScore(2450, -2077, "USD", "EUR", usd24)).toEqual({
      score: 30,
      source: "amount_close",
      currencyMismatch: false,
    });
  });

  it("rejects the wrong pair the FX band used to admit", () => {
    // USD 4.00 receipt against a USD 9.03 payment. Both figures are in USD, so
    // this is a real disagreement, not an FX artefact — no points, and no
    // fall-through to a rate band that cannot see the difference.
    const r = calculateAmountScore(400, -782, "USD", "EUR", {
      amount: 903,
      currency: "USD",
      rate: 0.8660022148,
    });
    expect(r.score).toBe(0);
    expect(r.source).toBeNull();
  });

  it("ignores an original in a third currency and keeps the old behaviour", () => {
    const gbpOriginal = { amount: 2400, currency: "GBP", rate: 1.17 };
    const r = calculateAmountScore(2400, -2086, "USD", "EUR", gbpOriginal);
    expect(r.currencyMismatch).toBe(true);
    expect(r.source).toBe("amount_close");
  });

  it("ignores the original when the document is already in the bank's currency", () => {
    // A EUR document against a EUR row is decided by the plain ladder; the
    // presence of an original for some other leg must not redirect it.
    expect(calculateAmountScore(2077, -2077, "EUR", "EUR", usd24)).toEqual({
      score: 40,
      source: "amount_exact",
      currencyMismatch: false,
    });
  });

  it("is inert when the row states no original — Revolut and every older import", () => {
    const r = calculateAmountScore(2400, -2086, "USD", "EUR", null);
    expect(r).toEqual(calculateAmountScore(2400, -2086, "USD", "EUR"));
    expect(r.currencyMismatch).toBe(true);
  });
});

function withGreaterScore(a: number, b: number): boolean {
  return a > b;
}
