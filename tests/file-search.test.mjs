import test from "node:test";
import assert from "node:assert/strict";
import { parseAmountQuery, matchesFileSearch } from "../lib/files/file-search.js";

function makeFile(overrides = {}) {
  return {
    fileName: "scan.pdf",
    extractedPartner: null,
    extractedInvoiceNumber: null,
    extractedAmount: null,
    extractedCurrency: "EUR",
    ...overrides,
  };
}

// --- parseAmountQuery -----------------------------------------------------

test("parseAmountQuery: a plain integer has no decimals", () => {
  assert.deepEqual(parseAmountQuery("42"), { euros: 42, cents: null });
});

test("parseAmountQuery: comma and dot both work as the decimal separator", () => {
  assert.deepEqual(parseAmountQuery("42,50"), { euros: 42, cents: 4250 });
  assert.deepEqual(parseAmountQuery("42.50"), { euros: 42, cents: 4250 });
  assert.deepEqual(parseAmountQuery("42,5"), { euros: 42, cents: 4250 });
});

test("parseAmountQuery: thousands separators are dropped", () => {
  assert.deepEqual(parseAmountQuery("1.234,56"), { euros: 1234, cents: 123456 });
  assert.deepEqual(parseAmountQuery("1,234.56"), { euros: 1234, cents: 123456 });
  assert.deepEqual(parseAmountQuery("1.234.567"), { euros: 1234567, cents: null });
  assert.deepEqual(parseAmountQuery("1 234,56"), { euros: 1234, cents: 123456 });
  // One separator followed by three digits is a thousands group: an amount
  // never carries three decimals.
  assert.deepEqual(parseAmountQuery("1.234"), { euros: 1234, cents: null });
  assert.deepEqual(parseAmountQuery("1,234"), { euros: 1234, cents: null });
});

test("parseAmountQuery: leading and trailing currency symbols are stripped", () => {
  assert.deepEqual(parseAmountQuery("€42"), { euros: 42, cents: null });
  assert.deepEqual(parseAmountQuery("42 €"), { euros: 42, cents: null });
  assert.deepEqual(parseAmountQuery("€ 1.234,56"), { euros: 1234, cents: 123456 });
  assert.deepEqual(parseAmountQuery("$42.10"), { euros: 42, cents: 4210 });
  assert.deepEqual(parseAmountQuery("42,10 EUR"), { euros: 42, cents: 4210 });
  assert.deepEqual(parseAmountQuery("usd 42"), { euros: 42, cents: null });
});

test("parseAmountQuery: a trailing separator carries no decimals", () => {
  assert.deepEqual(parseAmountQuery("42,"), { euros: 42, cents: null });
});

test("parseAmountQuery: text is not an amount", () => {
  for (const q of ["", "   ", "rewe", "RE-2026", "12ab", "€", "1.2345", "1,2,3"]) {
    assert.equal(parseAmountQuery(q), null, q);
  }
});

// --- matchesFileSearch ----------------------------------------------------

test("matchesFileSearch: matches the file name, case-insensitive", () => {
  assert.equal(matchesFileSearch(makeFile({ fileName: "Rechnung.PDF" }), "rechnung"), true);
});

test("matchesFileSearch: matches the extracted partner", () => {
  assert.equal(matchesFileSearch(makeFile({ extractedPartner: "REWE Markt" }), "rewe"), true);
});

test("matchesFileSearch: matches the extracted invoice number", () => {
  assert.equal(
    matchesFileSearch(makeFile({ extractedInvoiceNumber: "RE-2026-017" }), "2026-017"),
    true,
  );
});

test("matchesFileSearch: no match on any field is excluded", () => {
  assert.equal(matchesFileSearch(makeFile({ extractedAmount: 4200 }), "rewe"), false);
});

test("matchesFileSearch: a query without decimals matches the euro part", () => {
  assert.equal(matchesFileSearch(makeFile({ extractedAmount: 4200 }), "42"), true);
  assert.equal(matchesFileSearch(makeFile({ extractedAmount: 4299 }), "42"), true);
  assert.equal(matchesFileSearch(makeFile({ extractedAmount: 144200 }), "42"), false);
  assert.equal(matchesFileSearch(makeFile({ extractedAmount: 4300 }), "42"), false);
});

test("matchesFileSearch: a query with decimals matches the exact cent value", () => {
  assert.equal(matchesFileSearch(makeFile({ extractedAmount: 4250 }), "42,50"), true);
  assert.equal(matchesFileSearch(makeFile({ extractedAmount: 4250 }), "42.5"), true);
  assert.equal(matchesFileSearch(makeFile({ extractedAmount: 4200 }), "42,50"), false);
  assert.equal(matchesFileSearch(makeFile({ extractedAmount: 4299 }), "42,00"), false);
});

test("matchesFileSearch: thousands separators and currency symbols in the query", () => {
  const file = makeFile({ extractedAmount: 123456 });
  for (const q of ["1.234,56", "1,234.56", "€1.234,56", "1234,56 €", "1234.56"]) {
    assert.equal(matchesFileSearch(file, q), true, q);
  }
});

test("matchesFileSearch: a currency symbol never restricts the currency", () => {
  const usd = makeFile({ extractedAmount: 4200, extractedCurrency: "USD" });
  assert.equal(matchesFileSearch(usd, "€42"), true);
  assert.equal(matchesFileSearch(usd, "42 EUR"), true);
});

test("matchesFileSearch: digits are never substring-matched against the amount", () => {
  assert.equal(matchesFileSearch(makeFile({ extractedAmount: 14250 }), "425"), false);
  assert.equal(matchesFileSearch(makeFile({ extractedAmount: 14250 }), "42"), false);
});

test("matchesFileSearch: an amount query does not match a file without an amount", () => {
  assert.equal(matchesFileSearch(makeFile({ extractedAmount: null }), "42"), false);
});

test("matchesFileSearch: a credit note matches on its magnitude", () => {
  assert.equal(matchesFileSearch(makeFile({ extractedAmount: -4250 }), "42,50"), true);
});

test("matchesFileSearch: an empty query matches everything", () => {
  assert.equal(matchesFileSearch(makeFile(), ""), true);
  assert.equal(matchesFileSearch(makeFile(), "   "), true);
});
