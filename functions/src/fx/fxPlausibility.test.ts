import { describe, expect, it } from "vitest";
import {
  FX_LOOSE_TOLERANCE,
  FX_TIGHT_TOLERANCE,
  assessImpliedFx,
  isSameCurrency,
  normalizeCurrency,
} from "./fxPlausibility";

describe("normalizeCurrency / isSameCurrency", () => {
  it("defaults null/undefined/empty to EUR and upper-cases", () => {
    expect(normalizeCurrency(null)).toBe("EUR");
    expect(normalizeCurrency(undefined)).toBe("EUR");
    expect(normalizeCurrency("")).toBe("EUR");
    expect(normalizeCurrency(" usd ")).toBe("USD");
  });

  it("isSameCurrency treats missing as EUR", () => {
    expect(isSameCurrency(null, "eur")).toBe(true);
    expect(isSameCurrency("USD", undefined)).toBe(false);
  });
});

describe("assessImpliedFx", () => {
  it("same currency: no assessment", () => {
    const r = assessImpliedFx(2400, "EUR", 2400, "EUR");
    expect(r.mismatch).toBe(false);
    expect(r.band).toBeNull();
    expect(r.impliedRate).toBeNull();
  });

  // Live pair from fork #87: OpenAI USD 24.00 → EUR 20.86 (0.869 EUR/USD)
  it("USD 24.00 vs EUR 20.86 is a tight FX match", () => {
    const r = assessImpliedFx(2400, "USD", -2086, "EUR");
    expect(r.mismatch).toBe(true);
    expect(r.impliedRate).toBeCloseTo(0.869, 3);
    expect(r.band).toBe("tight");
  });

  it("GBP 100 vs EUR 118 is plausible; GBP 100 vs EUR 90 is not", () => {
    expect(assessImpliedFx(10000, "GBP", 11800, "EUR").band).not.toBeNull();
    expect(assessImpliedFx(10000, "GBP", 9000, "EUR").band).toBeNull();
  });

  it("USD 100 vs EUR 101 (2022 parity) is loose, USD 100 vs EUR 110 is out", () => {
    // 1:1 USD/EUR is ~15% off the current-era anchor: real in 2022, so still
    // loosely plausible; 1.10 EUR/USD (25% off) is not.
    expect(assessImpliedFx(10000, "USD", 10100, "EUR").band).toBe("loose");
    expect(assessImpliedFx(10000, "USD", 11000, "EUR").band).toBeNull();
  });

  it("maps legacy currency symbols to ISO codes", () => {
    expect(normalizeCurrency("€")).toBe("EUR");
    expect(normalizeCurrency("$")).toBe("USD");
    expect(isSameCurrency("€", null)).toBe(true);
    expect(assessImpliedFx(2400, "$", 2086, "EUR").band).toBe("tight");
  });

  it("partial payment ratio (USD 120 paid EUR 50) is not plausible FX", () => {
    expect(assessImpliedFx(12000, "USD", 5000, "EUR").band).toBeNull();
  });

  it("loose band: within FX_LOOSE_TOLERANCE but outside FX_TIGHT_TOLERANCE", () => {
    // Build a ratio exactly 8% above the USD reference
    const tight = assessImpliedFx(10000, "USD", 10000 * 0.88, "EUR");
    expect(tight.band).toBe("tight");
    const loose = assessImpliedFx(10000, "USD", 10000 * 0.88 * 1.08, "EUR");
    expect(loose.band).toBe("loose");
    expect(FX_TIGHT_TOLERANCE).toBeLessThan(FX_LOOSE_TOLERANCE);
  });

  it("unknown currency: mismatch reported, no band (never guessed)", () => {
    const r = assessImpliedFx(1000, "XYZ", 900, "EUR");
    expect(r.mismatch).toBe(true);
    expect(r.band).toBeNull();
    expect(r.referenceRate).toBeNull();
  });

  it("works when the transaction side is the foreign currency", () => {
    // EUR document, USD bank line: 1 EUR ≈ 1.136 USD
    const r = assessImpliedFx(2086, "EUR", 2400, "USD");
    expect(r.band).toBe("tight");
  });

  it("zero amounts: no assessment", () => {
    expect(assessImpliedFx(0, "USD", 100, "EUR").band).toBeNull();
    expect(assessImpliedFx(100, "USD", 0, "EUR").impliedRate).toBeNull();
  });
});

describe("date-keyed anchor (#92)", () => {
  // The ECB published 0.9992 USD per EUR on 2022-09-15 — EUR 1.0008 per USD.
  const parity2022 = 1 / 0.9992;

  it("judges a 2022 pair against 2022 instead of against today", () => {
    // USD 100.00 settled at EUR 101.00. Against the current-era anchor that is
    // 15% out and merely "loose"; against the day's own rate it is exact.
    const r = assessImpliedFx(10000, "USD", 10100, "EUR", { referenceRate: parity2022 });

    expect(r.referenceRate).toBe(parity2022);
    expect(r.band).toBe("tight");
  });

  it("rejects what the current-era anchor let through", () => {
    // USD 100.00 settled at EUR 75.00 in a month USD was at parity: three
    // quarters of the document, not a full payment at an unusual rate.
    expect(assessImpliedFx(10000, "USD", 7500, "EUR").band).toBe("loose");
    expect(
      assessImpliedFx(10000, "USD", 7500, "EUR", { referenceRate: parity2022 }).band
    ).toBeNull();
  });

  it("anchors a pair the static table has no entry for", () => {
    const r = assessImpliedFx(10000, "XYZ", 5000, "EUR", { referenceRate: 0.5 });

    expect(r.referenceRate).toBe(0.5);
    expect(r.band).toBe("tight");
  });

  it("keeps the static anchor for a null, zero or absent override", () => {
    const staticBand = assessImpliedFx(2400, "USD", 2086, "EUR").band;

    expect(assessImpliedFx(2400, "USD", 2086, "EUR", {}).band).toBe(staticBand);
    expect(assessImpliedFx(2400, "USD", 2086, "EUR", { referenceRate: null }).band)
      .toBe(staticBand);
    expect(assessImpliedFx(2400, "USD", 2086, "EUR", { referenceRate: 0 }).band)
      .toBe(staticBand);
  });
});
