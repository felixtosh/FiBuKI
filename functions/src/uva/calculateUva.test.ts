/**
 * Test harness for the UVA calculation module (fork #64).
 *
 * Built BEFORE the arithmetic per the spec's hard rule. Fixtures mirror the
 * anchors taken from real documents plus the
 * constructed cases from spec §9. No characterization test of the old
 * calculateUVAReport — it is wrong by construction.
 */

import { describe, it, expect } from "vitest";
import { calculateUva } from "./calculateUva";
import { periodBoundaries, ratesValidOn } from "./rateSet";
import type {
  UvaTransaction,
  UvaPeriod,
  UvaReportResult,
} from "./types";

const Q1_2026: UvaPeriod = { year: 2026, period: 1, type: "quarterly" };
const Q2_2026: UvaPeriod = { year: 2026, period: 2, type: "quarterly" };
const Q3_2026: UvaPeriod = { year: 2026, period: 3, type: "quarterly" };

function run(
  transactions: UvaTransaction[],
  period: UvaPeriod = Q1_2026
): UvaReportResult {
  return calculateUva({ period, transactions });
}

const kz = (r: UvaReportResult, code: string) => r.kennzahlen[code]?.value ?? 0;

// ---------------------------------------------------------------------------
// Period + rate set (R1, §7)
// ---------------------------------------------------------------------------

describe("periodBoundaries", () => {
  it("computes quarterly boundaries as Vienna calendar days", () => {
    expect(periodBoundaries(Q1_2026)).toEqual({
      start: "2026-01-01",
      end: "2026-03-31",
    });
    expect(periodBoundaries(Q3_2026)).toEqual({
      start: "2026-07-01",
      end: "2026-09-30",
    });
  });

  it("computes monthly boundaries incl. leap February", () => {
    expect(periodBoundaries({ year: 2028, period: 2, type: "monthly" })).toEqual(
      { start: "2028-02-01", end: "2028-02-29" }
    );
  });
});

describe("ratesValidOn (R1)", () => {
  it("has no 4.9% before 2026-07-01", () => {
    expect(ratesValidOn("2026-06-30")).not.toContain(4.9);
    expect(ratesValidOn("2026-03-15")).toEqual(
      expect.arrayContaining([0, 10, 13, 20])
    );
  });

  it("includes 4.9% from 2026-07-01", () => {
    expect(ratesValidOn("2026-07-01")).toContain(4.9);
  });
});

describe("period membership (§7 timezone fix)", () => {
  it("assigns quarter-boundary dates by Vienna calendar day, not browser tz", () => {
    const mar31: UvaTransaction = {
      id: "t-mar31",
      date: "2026-03-31",
      amount: -12000,
      files: [{ id: "f1", totalGross: 12000, vatPercent: 20, vatAmount: 2000 }],
    };
    const apr01: UvaTransaction = { ...mar31, id: "t-apr01", date: "2026-04-01" };

    const q1 = run([mar31, apr01], Q1_2026);
    const q2 = run([mar31, apr01], Q2_2026);
    expect(q1.totalInputVat).toBe(2000);
    expect(q2.totalInputVat).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// Step 0 — class gate (R9)
// ---------------------------------------------------------------------------

describe("step 0: zero-VAT classes", () => {
  it("bank fees claim zero input VAT and are not unresolved", () => {
    const r = run([
      {
        id: "t-fee",
        date: "2026-02-01",
        amount: -500,
        noReceiptCategory: {
          id: "c1",
          templateId: "bank-fees",
          vatTreatment: "exempt-class",
        },
      },
    ]);
    expect(r.totalInputVat).toBe(0);
    expect(r.unresolved).toHaveLength(0);
  });

  it("payroll claims zero input VAT via the same class gate", () => {
    const r = run([
      {
        id: "t-payroll",
        date: "2026-02-28",
        amount: -250000,
        noReceiptCategory: {
          id: "cp",
          templateId: "payroll",
          vatTreatment: "exempt-class",
        },
      },
    ]);
    expect(r.totalInputVat).toBe(0);
    expect(r.unresolved).toHaveLength(0);
  });

  it("needs-receipt categories land in the unresolved bucket", () => {
    const r = run([
      {
        id: "t-lost",
        date: "2026-02-01",
        amount: -3000,
        noReceiptCategory: {
          id: "c2",
          templateId: "receipt-lost",
          vatTreatment: "needs-receipt",
        },
      },
    ]);
    expect(r.totalInputVat).toBe(0);
    expect(r.unresolved).toHaveLength(1);
    expect(r.unresolved[0].reason).toBe("needs-receipt");
    expect(r.unresolved[0].foregoneVat).toBe(500);
  });

  it("#129: a needs-receipt INCOME line still books 20% output VAT", () => {
    // The class gate is direction-aware. For an expense an Eigenbeleg claims
    // nothing (the test above); for income the same silence would drop a sale
    // out of the report, which is the understating direction. It defaults to
    // 20% and stays flagged, exactly as an underivable sale does at step 4.
    const r = run([
      {
        id: "t-lost-income",
        date: "2026-02-01",
        amount: 11000,
        noReceiptCategory: {
          id: "c2",
          templateId: "receipt-lost",
          vatTreatment: "needs-receipt",
        },
      },
    ]);
    expect(r.totalOutputVat).toBe(1833);
    expect(kz(r, "000")).toBe(9167);
    expect(kz(r, "022")).toBe(9167);
    expect(r.unresolved).toHaveLength(1);
    expect(r.unresolved[0].reason).toBe("needs-receipt");
    // Output VAT owed, not input VAT a receipt could still recover.
    expect(r.unresolved[0].defaultedOutputVat).toBe(1833);
    expect(r.unresolved[0].foregoneVat).toBeNull();
  });

  it("categories without vatTreatment fall through to step 4", () => {
    const r = run([
      {
        id: "t-unknown-cat",
        date: "2026-02-01",
        amount: -3000,
        noReceiptCategory: { id: "c3", templateId: "bank-fees" },
      },
    ]);
    expect(r.unresolved).toHaveLength(1);
    expect(r.totalInputVat).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Step 1 — line items, multi-rate (a restaurant bill: food at 10%, drinks at 20%)
// ---------------------------------------------------------------------------

describe("step 1: line items with per-rate groups", () => {
  it("claims per-rate VAT from a multi-rate restaurant bill (10% food + 20% drinks)", () => {
    // gross 4750: food 3850 @10% (vat 350), drinks 900 @20% (vat 150)
    const r = run([
      {
        id: "t-sapori",
        date: "2026-02-10",
        amount: -4750,
        files: [
          {
            id: "f-sapori",
            totalGross: 4750,
            lineItems: [
              { vatPercent: 10, vatAmount: 350, amount: 3850 },
              { vatPercent: 20, vatAmount: 150, amount: 900 },
            ],
          },
        ],
      },
    ]);
    expect(r.totalInputVat).toBe(500);
    expect(r.unresolved).toHaveLength(0);
    expect(r.kennzahlen["060"].value).toBe(500);
    expect(r.kennzahlen["060"].contributions["line-items"]).toBe(1);
  });

  it("sends an unreconciled-flagged file to the review bucket as amount-mismatch", () => {
    const r = run([
      {
        id: "t-unrec",
        date: "2026-02-10",
        amount: -4750,
        files: [
          {
            id: "f-unrec",
            totalGross: 4750,
            lineItemsUnreconciled: true,
            lineItems: [{ vatPercent: 20, vatAmount: 792, amount: 4750 }],
          },
        ],
      },
    ]);
    expect(r.totalInputVat).toBe(0);
    expect(r.unresolved[0].reason).toBe("amount-mismatch");
  });

  it("derives from the receipt's printed rate groups in preference to line items (#67)", () => {
    const r = run([
      {
        id: "t-printed",
        date: "2026-02-10",
        amount: -4750,
        files: [
          {
            id: "f-printed",
            totalGross: 4750,
            rateGroups: [
              { rate: 10, net: 3500, vat: 350, gross: 3850 },
              { rate: 20, net: 750, vat: 150, gross: 900 },
            ],
            lineItems: [
              { vatPercent: 10, vatAmount: 350, amount: 3850 },
              { vatPercent: 20, vatAmount: 150, amount: 900 },
            ],
          },
        ],
      },
    ]);
    expect(r.totalInputVat).toBe(500);
    expect(r.kennzahlen["060"].contributions["rate-groups"]).toBe(1);
    expect(r.kennzahlen["060"].contributions["line-items"]).toBeUndefined();
  });

  it("a printed rate-group block clears a file whose line items are flagged (#67)", () => {
    // Spec §6 item 2/3: the printed per-rate totals are an independent,
    // §11-sufficient reading — broken itemisation no longer condemns the file.
    const r = run([
      {
        id: "t-unrec-printed",
        date: "2026-02-10",
        amount: -4750,
        files: [
          {
            id: "f-unrec-printed",
            totalGross: 4750,
            lineItemsUnreconciled: true,
            lineItemsUnreconciledRates: [20],
            rateGroups: [
              { rate: 10, net: 3500, vat: 350, gross: 3850 },
              { rate: 20, net: 750, vat: 150, gross: 900 },
            ],
            lineItems: [
              { vatPercent: 10, vatAmount: 350, amount: 3850 },
              { vatPercent: 20, vatAmount: 150, amount: 9000 },
            ],
          },
        ],
      },
    ]);
    expect(r.totalInputVat).toBe(500);
    expect(r.unresolved).toHaveLength(0);
    expect(r.kennzahlen["060"].contributions["rate-groups"]).toBe(1);
  });

  it("rejects a rate outside the period-valid set (11% live case)", () => {
    const r = run([
      {
        id: "t-11pct",
        date: "2026-02-10",
        amount: -1100,
        files: [
          {
            id: "f-11",
            totalGross: 1100,
            lineItems: [{ vatPercent: 11, vatAmount: 109, amount: 1100 }],
          },
        ],
      },
    ]);
    expect(r.totalInputVat).toBe(0);
    expect(r.unresolved[0].reason).toBe("foreign-or-invalid-rate");
  });

  it("gates 4.9% by period: valid in Q3 2026, invalid in Q1 2026", () => {
    const tx = (id: string, date: string): UvaTransaction => ({
      id,
      date,
      amount: -1049,
      files: [
        {
          id: `f-${id}`,
          totalGross: 1049,
          lineItems: [{ vatPercent: 4.9, vatAmount: 49, amount: 1049 }],
        },
      ],
    });
    const q1 = run([tx("t-49-q1", "2026-02-01")], Q1_2026);
    expect(q1.totalInputVat).toBe(0);
    expect(q1.unresolved[0].reason).toBe("foreign-or-invalid-rate");

    const q3 = run([tx("t-49-q3", "2026-07-05")], Q3_2026);
    expect(q3.totalInputVat).toBe(49);
    expect(q3.unresolved).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// D2 — foreign VAT (19% DE vs 19% ATU Jungholz)
// ---------------------------------------------------------------------------

describe("D2: foreign VAT", () => {
  it("19% with a DE UID is excluded and tagged as refund candidate", () => {
    const r = run([
      {
        id: "t-de19",
        date: "2026-02-15",
        amount: -11900,
        files: [
          {
            id: "f-de",
            totalGross: 11900,
            supplierVatId: "DE123456789",
            lineItems: [{ vatPercent: 19, vatAmount: 1900, amount: 11900 }],
          },
        ],
      },
    ]);
    expect(r.totalInputVat).toBe(0);
    expect(r.foreignVat).toHaveLength(1);
    expect(r.foreignVat[0].supplierVatId).toBe("DE123456789");
    expect(r.foreignVat[0].refundCandidate).toBe(true);
    expect(r.unresolved[0].reason).toBe("foreign-or-invalid-rate");
  });

  it("19% with an ATU UID (Jungholz/Mittelberg) is deductible Austrian VAT", () => {
    const r = run([
      {
        id: "t-atu19",
        date: "2026-02-15",
        amount: -11900,
        files: [
          {
            id: "f-atu",
            totalGross: 11900,
            supplierVatId: "ATU12345678",
            lineItems: [{ vatPercent: 19, vatAmount: 1900, amount: 11900 }],
          },
        ],
      },
    ]);
    expect(r.totalInputVat).toBe(1900);
    expect(r.foreignVat).toHaveLength(0);
    expect(r.unresolved).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Step 2 — top-level extraction (corpus: ÖBB Fahrausweis)
// ---------------------------------------------------------------------------

describe("step 2: top-level extraction", () => {
  it("derives 10% Fahrausweis VAT as gross x 10/110 (Kleinbetragsrechnung, R4/R10)", () => {
    // ÖBB ticket 2331 gross @10% → vat = round(2331*10/110) = 212
    const r = run([
      {
        id: "t-oebb",
        date: "2026-01-20",
        amount: -2331,
        files: [{ id: "f-oebb", totalGross: 2331, vatPercent: 10 }],
      },
    ]);
    expect(r.totalInputVat).toBe(212);
    expect(r.kennzahlen["060"].contributions["top-level"]).toBe(1);
  });

  it("uses extractedVatAmount when present", () => {
    const r = run([
      {
        id: "t-toplevel",
        date: "2026-01-20",
        amount: -12000,
        files: [{ id: "f-tl", totalGross: 12000, vatAmount: 2000, vatPercent: 20 }],
      },
    ]);
    expect(r.totalInputVat).toBe(2000);
  });

  it("derives the implied rate from vatAmount alone and validates it", () => {
    // gross 12000, vat 2000 → net 10000 → implied 20%
    const ok = run([
      {
        id: "t-implied",
        date: "2026-01-20",
        amount: -12000,
        files: [{ id: "f-imp", totalGross: 12000, vatAmount: 2000 }],
      },
    ]);
    expect(ok.totalInputVat).toBe(2000);

    // implied rate ~35% — not Austrian, review bucket
    const bad = run([
      {
        id: "t-implied-bad",
        date: "2026-01-20",
        amount: -13500,
        files: [{ id: "f-impb", totalGross: 13500, vatAmount: 3500 }],
      },
    ]);
    expect(bad.totalInputVat).toBe(0);
    expect(bad.unresolved[0].reason).toBe("foreign-or-invalid-rate");
  });

  it("file with no VAT data at all goes to the review bucket", () => {
    const r = run([
      {
        id: "t-novat",
        date: "2026-01-20",
        amount: -5000,
        files: [{ id: "f-nv", totalGross: 5000 }],
      },
    ]);
    expect(r.totalInputVat).toBe(0);
    expect(r.unresolved[0].reason).toBe("no-vat-data");
  });
});

// ---------------------------------------------------------------------------
// Amount reconciliation (R2/R5/R6): partial, tip, mismatch, multi-file
// ---------------------------------------------------------------------------

describe("amount reconciliation", () => {
  const w4yFile = {
    id: "f-w4y",
    totalGross: 8400,
    vatPercent: 20,
    vatAmount: 1400,
  };

  it("claims proportionally on partial payment (World4You card portion)", () => {
    // bank 5294 of invoice 8400 → fraction 0.63024 → vat 1400*f = 882
    const r = run([
      { id: "t-w4y-card", date: "2026-02-03", amount: -5294, files: [w4yFile] },
    ]);
    expect(r.totalInputVat).toBe(Math.round((5294 / 8400) * 1400));
  });

  it("caps the claim by priorClaimedFraction (instalments, cumulative <= 1)", () => {
    // second payment 3106 after 5294 already claimed → remaining fraction claimed fully
    const r = run(
      [
        {
          id: "t-w4y-credit",
          date: "2026-04-10",
          amount: -3106,
          files: [w4yFile],
          priorClaimedFraction: 5294 / 8400,
        },
      ],
      Q2_2026
    );
    const first = Math.round((5294 / 8400) * 1400);
    expect(r.totalInputVat).toBe(1400 - first);
  });

  it("reconciles a Beleg against Summe + printed Trinkgeld exactly (#172)", () => {
    // Restaurant Beleg: Summe 50,80 (10% food + 20% drinks), Trinkgeld 3,20,
    // Gesamt 54,00 — the figure the card charged and the bank line carries.
    const r = run([
      {
        id: "t-trinkgeld",
        date: "2026-02-20",
        amount: -5400,
        files: [
          {
            id: "f-beleg",
            totalGross: 5080,
            tipAmount: 320,
            rateGroups: [
              { rate: 10, net: 3500, vat: 350, gross: 3850 },
              { rate: 20, net: 1025, vat: 205, gross: 1230 },
            ],
          },
        ],
      },
    ]);
    // Vorsteuer on the Summe only; nothing is scaled and nothing is foregone.
    expect(r.totalInputVat).toBe(555);
    expect(r.unresolved).toHaveLength(0);
  });

  it("keeps the Trinkgeld out of every Kennzahl (#172)", () => {
    const beleg = {
      id: "f-beleg-kz",
      totalGross: 5080,
      rateGroups: [{ rate: 20, net: 4233, vat: 847, gross: 5080 }],
    };
    // The same document, once with a 3,20 tip charged on top and once without
    // one at all. The tip moves what the bank paid, and nothing else: every
    // Kennzahl has to come out identical.
    const withTip = run([
      {
        id: "t-kz",
        date: "2026-02-20",
        amount: -5400,
        files: [{ ...beleg, tipAmount: 320 }],
      },
    ]);
    const withoutTip = run([
      { id: "t-kz", date: "2026-02-20", amount: -5080, files: [beleg] },
    ]);
    expect(kz(withTip, "060")).toBe(847);
    expect(withTip.kennzahlen).toEqual(withoutTip.kennzahlen);
  });

  it("sends an overpay the documents do not account for to the review bucket", () => {
    // No tip line on the Beleg: a cash tip nobody wrote down is a mismatch,
    // not a claim. R5 used to guess here off a partnerClass nothing set.
    const r = run([
      {
        id: "t-over",
        date: "2026-02-20",
        amount: -11000,
        files: [
          { id: "f-x", totalGross: 10500, vatPercent: 20, vatAmount: 1750 },
        ],
      },
    ]);
    expect(r.totalInputVat).toBe(0);
    expect(r.unresolved[0].reason).toBe("amount-mismatch");
  });

  it("reconciles one payment against the SUM of two connected invoices", () => {
    const r = run([
      {
        id: "t-two-inv",
        date: "2026-02-21",
        amount: -18000,
        files: [
          { id: "f-a", totalGross: 12000, vatPercent: 20, vatAmount: 2000 },
          { id: "f-b", totalGross: 6000, vatPercent: 10, vatAmount: 545 },
        ],
      },
    ]);
    expect(r.totalInputVat).toBe(2545);
    expect(r.unresolved).toHaveLength(0);
  });

  it("tolerates a 2-cent rounding delta", () => {
    const r = run([
      {
        id: "t-2cent",
        date: "2026-02-21",
        amount: -11998,
        files: [
          { id: "f-r", totalGross: 12000, vatPercent: 20, vatAmount: 2000 },
        ],
      },
    ]);
    expect(r.totalInputVat).toBe(2000);
    expect(r.unresolved).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Step 3 — manual override
// ---------------------------------------------------------------------------

describe("foreign-currency documents (fork #87)", () => {
  // Live shape: Invoice-SJJFNBF4-0004.pdf USD 36.00 incl. USD 6.00 VAT (20%),
  // paid as EUR 31.32 (0.87 EUR/USD). Before #87 the USD figures were read
  // as EUR and the pair reconciled as a "partial payment" of 3132/3600.
  const usdFile = {
    id: "f-usd",
    currency: "USD",
    totalGross: 3600,
    vatAmount: 600,
    vatPercent: 20,
  };

  it("converts a single foreign-currency file at the effective rate actually paid", () => {
    const r = run([
      { id: "t-usd", date: "2026-02-10", amount: -3132, currency: "EUR", files: [usdFile] },
    ]);
    // 600 USD-cents * (3132/3600) = 522 EUR-cents of input VAT, not 600 and not 516
    expect(r.unresolved).toHaveLength(0);
    expect(r.totalInputVat).toBe(522);
    // net + vat = gross = bank
    expect(kz(r, "060")).toBe(522);
  });

  it("treats a missing transaction currency as EUR", () => {
    const r = run([{ id: "t-usd", date: "2026-02-10", amount: -3132, files: [usdFile] }]);
    expect(r.totalInputVat).toBe(522);
  });

  it("converts printed rate groups and line items too", () => {
    const r = run([
      {
        id: "t-usd-rg",
        date: "2026-02-10",
        amount: -3132,
        files: [
          {
            id: "f-usd-rg",
            currency: "USD",
            totalGross: 3600,
            rateGroups: [{ rate: 20, net: 3000, vat: 600, gross: 3600 }],
          },
        ],
      },
    ]);
    expect(r.unresolved).toHaveLength(0);
    expect(r.totalInputVat).toBe(522);
    expect(r.kennzahlen["060"].contributions["rate-groups"]).toBe(1);
  });

  it("does not convert when the implied rate is not a plausible FX rate (partial payment shape)", () => {
    // USD 120 invoice, EUR 50 paid: 0.417 EUR/USD is no exchange rate — surface it
    const r = run([
      {
        id: "t-usd-partial",
        date: "2026-02-10",
        amount: -5000,
        files: [{ ...usdFile, totalGross: 12000, vatAmount: 2000 }],
      },
    ]);
    expect(r.totalInputVat).toBe(0);
    expect(r.unresolved).toEqual([
      expect.objectContaining({ transactionId: "t-usd-partial", reason: "foreign-currency" }),
    ]);
    expect(r.unresolved[0].foregoneVat).toBe(Math.round((5000 * 20) / 120));
  });

  it("does not convert when several files are connected and any is foreign", () => {
    const r = run([
      {
        id: "t-two",
        date: "2026-02-10",
        amount: -4332,
        files: [usdFile, { id: "f-eur", totalGross: 1200, vatAmount: 200, vatPercent: 20 }],
      },
    ]);
    expect(r.totalInputVat).toBe(0);
    expect(r.unresolved[0]).toMatchObject({ transactionId: "t-two", reason: "foreign-currency" });
  });

  it("a bank line that is not in EUR cannot feed the EUR report in any lane", () => {
    const r = run([
      { id: "t-usd-acct", date: "2026-02-10", amount: -3600, currency: "USD", files: [usdFile] },
      { id: "t-usd-income", date: "2026-02-11", amount: 5000, currency: "USD" },
    ]);
    expect(r.totalInputVat).toBe(0);
    expect(r.totalOutputVat).toBe(0);
    expect(r.unresolved.map((u) => [u.transactionId, u.reason])).toEqual([
      ["t-usd-acct", "foreign-currency"],
      ["t-usd-income", "foreign-currency"],
    ]);
  });

  it("does not convert an unknown currency", () => {
    const r = run([
      { id: "t-xyz", date: "2026-02-10", amount: -3132, files: [{ ...usdFile, currency: "XYZ" }] },
    ]);
    expect(r.totalInputVat).toBe(0);
    expect(r.unresolved[0].reason).toBe("foreign-currency");
  });

  it("a foreign-currency file without a document total cannot derive a rate", () => {
    const r = run([
      {
        id: "t-nogross",
        date: "2026-02-10",
        amount: -3132,
        files: [{ id: "f-ng", currency: "USD", vatAmount: 600, vatPercent: 20 }],
      },
    ]);
    expect(r.totalInputVat).toBe(0);
    expect(r.unresolved[0].reason).toBe("foreign-currency");
  });

  it("a foreign-currency file with no VAT data still reports no-vat-data", () => {
    const r = run([
      {
        id: "t-novat",
        date: "2026-02-10",
        amount: -3132,
        files: [{ id: "f-nv", currency: "USD", totalGross: 3600 }],
      },
    ]);
    expect(r.unresolved[0].reason).toBe("no-vat-data");
  });

  it("the D2 foreign-VAT lane still fires on a converted document", () => {
    // GBP invoice with 20% UK VAT and a GB UID: 20 is a valid AT rate, so this
    // stays deductible-looking today (D2 only catches invalid rates); assert
    // the conversion does not change that classification path.
    const r = run([
      {
        id: "t-gbp",
        date: "2026-02-10",
        amount: -11700,
        files: [
          { id: "f-gbp", currency: "GBP", totalGross: 10000, vatAmount: 1900, vatPercent: 19, supplierVatId: "GB123456789" },
        ],
      },
    ]);
    expect(r.unresolved[0].reason).toBe("foreign-or-invalid-rate");
    expect(r.foreignVat[0]).toMatchObject({ transactionId: "t-gbp", rate: 19, refundCandidate: true });
  });
});

describe("step 3: manual vatRate override", () => {
  it("applies the override when no file resolves", () => {
    const r = run([
      { id: "t-ovr", date: "2026-02-01", amount: -1200, vatRateOverride: 20 },
    ]);
    expect(r.totalInputVat).toBe(200);
    expect(r.kennzahlen["060"].contributions["override"]).toBe(1);
  });

  it("validates the override against the period rate set", () => {
    const r = run([
      { id: "t-ovr-bad", date: "2026-02-01", amount: -1200, vatRateOverride: 19 },
    ]);
    expect(r.totalInputVat).toBe(0);
    expect(r.unresolved[0].reason).toBe("foreign-or-invalid-rate");
  });
});

// ---------------------------------------------------------------------------
// Step 4 — unresolved asymmetry (D1)
// ---------------------------------------------------------------------------

describe("step 4: unresolved bucket asymmetry", () => {
  it("expense without file claims ZERO input VAT and lists foregone VAT at 20% guess", () => {
    const r = run([
      { id: "t-nofile", date: "2026-02-01", amount: -6000, partnerName: "X" },
    ]);
    expect(r.totalInputVat).toBe(0);
    expect(r.unresolved).toHaveLength(1);
    const u = r.unresolved[0];
    expect(u.reason).toBe("no-file");
    expect(u.side).toBe("expense");
    expect(u.foregoneVat).toBe(1000); // 6000 * 20/120
  });

  it("income without document defaults to 20% output VAT, flagged", () => {
    const r = run([
      { id: "t-income-bare", date: "2026-02-01", amount: 12000 },
    ]);
    // 12000 gross → net 10000, vat 2000 in KZ022 base and output VAT
    expect(kz(r, "022")).toBe(10000);
    expect(r.totalOutputVat).toBe(2000);
    expect(r.kennzahlen["022"].contributions["defaulted-20"]).toBe(1);
    expect(r.unresolved).toHaveLength(1);
    expect(r.unresolved[0].defaultedOutputVat).toBe(2000);
  });

  it("income resolves via linked outgoing invoice rate groups before defaulting", () => {
    const r = run([
      {
        id: "t-income-inv",
        date: "2026-02-01",
        amount: 12000,
        invoiceRateGroups: [{ rate: 20, net: 10000, vat: 2000, gross: 12000 }],
      },
    ]);
    expect(kz(r, "022")).toBe(10000);
    expect(r.kennzahlen["022"].contributions["invoice"]).toBe(1);
    expect(r.unresolved).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// D3 — the three foreign regimes never share a bucket
// ---------------------------------------------------------------------------

describe("D3: foreign regimes", () => {
  it("reverse-charges a third-country B2B service (Anthropic): KZ057 = KZ066, a wash", () => {
    const r = run([
      {
        id: "t-anthropic",
        date: "2026-01-15",
        amount: -2160,
        foreignRegime: { kind: "service", origin: "third-country", basis: "heuristic" },
      },
    ]);
    const vat = Math.round(2160 * 0.2);
    expect(kz(r, "057")).toBe(vat);
    expect(kz(r, "066")).toBe(vat);
    expect(r.balance).toBe(0);
    expect(r.reverseCharge).toHaveLength(1);
    expect(r.unresolved).toHaveLength(0);
    // never in the domestic input VAT line
    expect(kz(r, "060")).toBe(0);
  });

  it("self-assesses a reduced-rate service at its domestic rate, not 20%", () => {
    const r = run([
      {
        id: "t-svc-10",
        date: "2026-01-15",
        amount: -1000,
        foreignRegime: {
          kind: "service",
          origin: "third-country",
          basis: "override",
          domesticRate: 10,
        },
      },
    ]);
    expect(kz(r, "057")).toBe(100);
    expect(kz(r, "066")).toBe(100);
  });

  it("books deferred EUSt (§26) in KZ083 instead of KZ061", () => {
    const r = run([
      {
        id: "t-import-deferred",
        date: "2026-01-15",
        amount: -8000,
        foreignRegime: {
          kind: "goods",
          origin: "third-country",
          basis: "override",
          importVatPaid: 1600,
          importVatScheme: "deferred",
        },
      },
    ]);
    expect(kz(r, "083")).toBe(1600);
    expect(kz(r, "061")).toBe(0);
  });

  it("reverse-charges an EU B2B service identically (not EU-only)", () => {
    const r = run([
      {
        id: "t-eu-svc",
        date: "2026-01-15",
        amount: -1000,
        foreignRegime: { kind: "service", origin: "eu", basis: "override" },
      },
    ]);
    expect(kz(r, "057")).toBe(200);
    expect(kz(r, "066")).toBe(200);
  });

  it("books EU goods as ig. Erwerb: KZ070 base + KZ072 (20%) + KZ065 input VAT", () => {
    const r = run([
      {
        id: "t-eu-goods",
        date: "2026-01-15",
        amount: -5000,
        foreignRegime: {
          kind: "goods",
          origin: "eu",
          basis: "override",
          domesticRate: 20,
        },
      },
    ]);
    expect(kz(r, "070")).toBe(5000);
    expect(kz(r, "072")).toBe(5000);
    expect(kz(r, "065")).toBe(1000);
    // wash for a fully-deduction-entitled business
    expect(r.balance).toBe(0);
    // never in reverse-charge or import buckets
    expect(kz(r, "057")).toBe(0);
    expect(kz(r, "061")).toBe(0);
  });

  it("books third-country goods as import: KZ061 only with documented EUSt", () => {
    const withEust = run([
      {
        id: "t-import",
        date: "2026-01-15",
        amount: -8000,
        foreignRegime: {
          kind: "goods",
          origin: "third-country",
          basis: "override",
          importVatPaid: 1600,
        },
      },
    ]);
    expect(kz(withEust, "061")).toBe(1600);
    expect(kz(withEust, "057")).toBe(0);
    expect(kz(withEust, "070")).toBe(0);

    const withoutEust = run([
      {
        id: "t-import-undoc",
        date: "2026-01-15",
        amount: -8000,
        foreignRegime: { kind: "goods", origin: "third-country", basis: "heuristic" },
      },
    ]);
    expect(kz(withoutEust, "061")).toBe(0);
    expect(withoutEust.unresolved).toHaveLength(1);
    expect(withoutEust.unresolved[0].reason).toBe("no-vat-data");
  });
});

// ---------------------------------------------------------------------------
// Output side + KZ mapping regression (§4)
// ---------------------------------------------------------------------------

describe("KZ mapping (the 12-of-16-wrong regression)", () => {
  it("puts 10% output in KZ029 and 13% in KZ006 (the swap)", () => {
    const r = run([
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
    ]);
    expect(kz(r, "029")).toBe(10000); // 10% base
    expect(kz(r, "006")).toBe(10000); // 13% base
  });

  it("never emits KZ096 and nets the balance into KZ095", () => {
    const r = run([
      {
        id: "t-out",
        date: "2026-02-01",
        amount: 12000,
        invoiceRateGroups: [{ rate: 20, net: 10000, vat: 2000, gross: 12000 }],
      },
      {
        id: "t-in",
        date: "2026-02-02",
        amount: -6000,
        files: [{ id: "f", totalGross: 6000, vatPercent: 20, vatAmount: 1000 }],
      },
    ]);
    expect(r.kennzahlen["096"]).toBeUndefined();
    expect(kz(r, "095")).toBe(1000);
    expect(r.balance).toBe(1000);
  });

  it("KZ000 is the grand total of supplies incl. exempt, not the 20% line", () => {
    const r = run([
      {
        id: "t-20",
        date: "2026-02-01",
        amount: 12000,
        invoiceRateGroups: [{ rate: 20, net: 10000, vat: 2000, gross: 12000 }],
      },
      {
        id: "t-export",
        date: "2026-02-01",
        amount: 5000,
        invoiceRateGroups: [{ rate: 0, net: 5000, vat: 0, gross: 5000 }],
        foreignRegime: null,
      },
    ]);
    expect(kz(r, "000")).toBe(15000);
    expect(kz(r, "022")).toBe(10000);
    expect(kz(r, "011")).toBe(5000); // export (0% without EU marker)
  });

  it("marks EU Kennzahlen as not-implemented, not measured zero", () => {
    const r = run([]);
    expect(r.euKennzahlen.basis).toBe("not-implemented");
  });
});

// ---------------------------------------------------------------------------
// Output contract (§5)
// ---------------------------------------------------------------------------

describe("output contract", () => {
  it("carries period metadata with the rate set in force", () => {
    const r = run([], Q1_2026);
    expect(r.period.start).toBe("2026-01-01");
    expect(r.period.end).toBe("2026-03-31");
    expect(r.period.timezone).toBe("Europe/Vienna");
    expect(r.period.rateSet).not.toContain(4.9);

    const q3 = run([], Q3_2026);
    expect(q3.period.rateSet).toContain(4.9);
  });

  it("counts contributions by derivation step per Kennzahl", () => {
    const r = run([
      {
        id: "a",
        date: "2026-02-01",
        amount: -1200,
        files: [{ id: "fa", totalGross: 1200, vatPercent: 20, vatAmount: 200 }],
      },
      { id: "b", date: "2026-02-01", amount: -2400, vatRateOverride: 20 },
    ]);
    expect(r.kennzahlen["060"].contributions["top-level"]).toBe(1);
    expect(r.kennzahlen["060"].contributions["override"]).toBe(1);
    expect(r.kennzahlen["060"].value).toBe(600);
  });
});
