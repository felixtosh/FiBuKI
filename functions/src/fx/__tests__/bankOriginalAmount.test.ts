/**
 * #112 — the bank's own pre-settlement figure.
 *
 * The header shapes and values here are taken from the two exports this
 * instance actually imports (a Sparkasse-style CSV with Original Amount /
 * Original Currency / Exchange Rate, and a Revolut export with none of them).
 */

import { describe, it, expect } from "vitest";
import {
  parseBankDecimal,
  readBankOriginalAmount,
  comparableAmount,
} from "../bankOriginalAmount";

describe("parseBankDecimal", () => {
  it("reads plain and English-decimal figures", () => {
    expect(parseBankDecimal("24")).toBe(24);
    expect(parseBankDecimal("19.95")).toBe(19.95);
    expect(parseBankDecimal("4.67")).toBe(4.67);
    expect(parseBankDecimal("-3.48")).toBe(-3.48);
    expect(parseBankDecimal("72800")).toBe(72800);
  });

  it("reads the German convention", () => {
    expect(parseBankDecimal("19,95")).toBe(19.95);
    expect(parseBankDecimal("1.234,56")).toBe(1234.56);
    expect(parseBankDecimal("1.234.567,89")).toBe(1234567.89);
  });

  it("reads English thousands separators", () => {
    expect(parseBankDecimal("1,234.56")).toBe(1234.56);
    expect(parseBankDecimal("1,234,567")).toBe(1234567);
  });

  it("strips currency symbols and codes", () => {
    expect(parseBankDecimal("USD 24.00")).toBe(24);
    expect(parseBankDecimal("€ 19,95")).toBe(19.95);
  });

  it("refuses the genuinely ambiguous single-separator-three-digit case", () => {
    // "1.500" is 1500 in German and 1.5 in English. Nothing in the row says
    // which, and guessing wrong attaches a receipt to the wrong payment.
    expect(parseBankDecimal("1.500")).toBeNull();
    expect(parseBankDecimal("1,500")).toBeNull();
  });

  it("returns null for junk and empties", () => {
    expect(parseBankDecimal(null)).toBeNull();
    expect(parseBankDecimal(undefined)).toBeNull();
    expect(parseBankDecimal("")).toBeNull();
    expect(parseBankDecimal("n/a")).toBeNull();
    expect(parseBankDecimal("1.23456")).toBeNull();
  });
});

describe("readBankOriginalAmount", () => {
  const sparkasseRow = {
    "Account Name": "Yazzbert e.U.",
    "Amount (EUR)": "-20.77",
    "Booking Date": "2026-03-27",
    "Exchange Rate": "0.8654166667",
    "Original Amount": "24",
    "Original Currency": "USD",
    "Partner Name": "NOTION LABS, INC.",
  };

  it("reads amount, currency and rate, in cents and absolute", () => {
    expect(readBankOriginalAmount(sparkasseRow)).toEqual({
      amount: 2400,
      currency: "USD",
      rate: 0.8654166667,
    });
  });

  it("matches header spelling variants on the normalized key", () => {
    expect(
      readBankOriginalAmount({ original_amount: "24", ORIGINALCURRENCY: "usd" })
    ).toEqual({ amount: 2400, currency: "USD", rate: null });
    expect(
      readBankOriginalAmount({ "Originalbetrag": "19,95", "Originalwährung": "USD" })
    ).toEqual({ amount: 1995, currency: "USD", rate: null });
  });

  it("returns null when the row states no original — Revolut's export", () => {
    expect(
      readBankOriginalAmount({
        Type: "Card Payment",
        Amount: "-74.00",
        Fee: "0.00",
        Currency: "EUR",
        Description: "Riva Officina",
      })
    ).toBeNull();
  });

  it("returns null when either half is missing", () => {
    expect(readBankOriginalAmount({ "Original Amount": "24" })).toBeNull();
    expect(readBankOriginalAmount({ "Original Currency": "USD" })).toBeNull();
    expect(readBankOriginalAmount(null)).toBeNull();
    expect(readBankOriginalAmount(undefined)).toBeNull();
  });

  it("rejects a currency that is not a 3-letter code", () => {
    expect(readBankOriginalAmount({ "Original Amount": "24", "Original Currency": "$" })).toBeNull();
    expect(
      readBankOriginalAmount({ "Original Amount": "24", "Original Currency": "DOLLARS" })
    ).toBeNull();
  });

  it("rejects a zero or unparseable original amount rather than reporting 0", () => {
    expect(readBankOriginalAmount({ "Original Amount": "0", "Original Currency": "USD" })).toBeNull();
    expect(
      readBankOriginalAmount({ "Original Amount": "1.500", "Original Currency": "USD" })
    ).toBeNull();
  });

  it("drops an unusable rate but keeps the amount", () => {
    expect(
      readBankOriginalAmount({
        "Original Amount": "24",
        "Original Currency": "USD",
        "Exchange Rate": "n/a",
      })
    ).toEqual({ amount: 2400, currency: "USD", rate: null });
  });
});

describe("comparableAmount", () => {
  const original = { amount: 2400, currency: "USD", rate: 0.8654 };

  it("returns the amount unchanged when it is already in the target currency", () => {
    expect(comparableAmount(-2077, "EUR", null, "EUR")).toBe(2077);
  });

  it("bridges to the target currency through the bank's stated original", () => {
    expect(comparableAmount(-2077, "EUR", original, "USD")).toBe(2400);
  });

  it("returns null when nothing bridges the two — no rate is ever invented", () => {
    expect(comparableAmount(-2077, "EUR", null, "USD")).toBeNull();
    expect(comparableAmount(-2077, "EUR", original, "GBP")).toBeNull();
  });

  it("returns null without a target currency", () => {
    expect(comparableAmount(2400, "USD", null, "")).toBeNull();
    expect(comparableAmount(2400, "USD", null, null)).toBeNull();
  });
});
