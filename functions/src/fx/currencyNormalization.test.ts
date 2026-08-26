/**
 * The one currency normalizer (fork #113).
 *
 * Three copies with two behaviours became one. What is pinned here is the
 * decision that replaced the old `CURRENCY_MAP[currency] || "EUR"`: an
 * unrecognised code is preserved, never guessed at.
 */

import { describe, it, expect } from "vitest";
import { normalizeCurrency, normalizeCurrencyForDisplay } from "./currencyNormalization";

describe("normalizeCurrency", () => {
  it("maps the symbols the extraction path emits", () => {
    expect(normalizeCurrency("€")).toBe("EUR");
    expect(normalizeCurrency("$")).toBe("USD");
    expect(normalizeCurrency("£")).toBe("GBP");
    expect(normalizeCurrency("¥")).toBe("JPY");
  });

  it("matches the symbol map case-insensitively", () => {
    // Two of the three old copies keyed on the exact spelling "Fr.", so "FR."
    // and "fr." fell through to the EUR coercion.
    expect(normalizeCurrency("Fr.")).toBe("CHF");
    expect(normalizeCurrency("FR.")).toBe("CHF");
    expect(normalizeCurrency("fr.")).toBe("CHF");
  });

  it("uppercases an ISO code rather than rejecting it", () => {
    expect(normalizeCurrency("usd")).toBe("USD");
    expect(normalizeCurrency(" eur ")).toBe("EUR");
    expect(normalizeCurrency("CHF")).toBe("CHF");
  });

  it("preserves an unrecognised code instead of calling it EUR", () => {
    expect(normalizeCurrency("Kč")).toBe("KČ");
    expect(normalizeCurrency("EURO")).toBe("EURO");
    // Two different unknowns must stay distinguishable, or isSameCurrency
    // reports a match between unrelated currencies.
    expect(normalizeCurrency("Kč")).not.toBe(normalizeCurrency("zł"));
  });

  it("returns null only for nothing at all", () => {
    expect(normalizeCurrency(null)).toBeNull();
    expect(normalizeCurrency(undefined)).toBeNull();
    expect(normalizeCurrency("")).toBeNull();
    expect(normalizeCurrency("   ")).toBeNull();
  });
});

describe("normalizeCurrencyForDisplay", () => {
  it("falls back only for the empty case", () => {
    expect(normalizeCurrencyForDisplay(null)).toBe("EUR");
    expect(normalizeCurrencyForDisplay("")).toBe("EUR");
    expect(normalizeCurrencyForDisplay(null, "USD")).toBe("USD");
  });

  it("still refuses to guess at an unrecognised code", () => {
    expect(normalizeCurrencyForDisplay("Kč")).toBe("KČ");
  });
});
