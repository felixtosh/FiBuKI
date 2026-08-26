/**
 * Regression assertions on the XML/figure-sheet layer (spec §9, fork #64):
 * 10% content must land in KZ029 and 13% in KZ006 (the historic swap), and
 * KZ096 must never be emitted.
 */

import { describe, it, expect } from "vitest";
import { generateUvaXml } from "./generateUvaXml";
import { calculateUva } from "../uva/calculateUva";

function kennzahlValues(result: ReturnType<typeof calculateUva>) {
  return Object.fromEntries(
    Object.entries(result.kennzahlen).map(([code, f]) => [code, f.value])
  );
}

describe("generateUvaXml fed from calculateUva", () => {
  const result = calculateUva({
    period: { year: 2026, period: 1, type: "quarterly" },
    transactions: [
      {
        id: "t-10",
        date: "2026-02-01",
        amount: 11000,
        invoiceRateGroups: [{ rate: 10, net: 10000, vat: 1000, gross: 11000 }],
      },
      {
        id: "t-13",
        date: "2026-02-01",
        amount: 11300,
        invoiceRateGroups: [{ rate: 13, net: 10000, vat: 1300, gross: 11300 }],
      },
    ],
  });
  const xml = generateUvaXml(
    kennzahlValues(result),
    { year: 2026, period: 1, type: "quarterly" },
    "123456789"
  );

  it("puts the 10% base in KZ029 and the 13% base in KZ006", () => {
    expect(xml).toContain("<KZ029>100.00</KZ029>");
    expect(xml).toContain("<KZ006>100.00</KZ006>");
  });

  it("emits the grand total in KZ000 and the netted balance in KZ095", () => {
    expect(xml).toContain("<KZ000>200.00</KZ000>");
    expect(xml).toContain("<KZ095>23.00</KZ095>");
  });

  it("never emits KZ096 or the fabricated per-rate VAT codes", () => {
    expect(xml).not.toContain("KZ096");
    expect(xml).not.toContain("KZ001");
    expect(xml).not.toContain("KZ007");
  });

  it("omits zero-valued Kennzahlen", () => {
    expect(xml).not.toContain("<KZ060>");
  });
});
