/**
 * § 20 Abs 6 UStG method 2 in the derivation (#92).
 *
 * The statute permits three conversions and the module used to have one. What
 * is pinned here is which of them a run picks, what it records about the pick,
 * and — the part that is easy to lose — that preferring a published rate does
 * not change which documents are trusted enough to book at all.
 */

import { describe, expect, it } from "vitest";
import { calculateUva } from "./calculateUva";
import { buildUvaFiling, deriveFxRateDeltas } from "./filing";
import { buildEcbRateTable } from "../fx/ecbRates";
import type { UvaPeriod, UvaTransaction } from "./types";

const Q3: UvaPeriod = { year: 2026, period: 3, type: "quarterly" };
const Q3_2022: UvaPeriod = { year: 2022, period: 3, type: "quarterly" };

/**
 * Real ECB quotes (USD per 1 EUR). 2026-07-31 and 2026-08-21 are publication
 * days; 2026-08-22/23 are the weekend the ECB skipped.
 */
const RATES = buildEcbRateTable([
  { date: "2026-07-31", rates: { USD: 1.1507 } },
  { date: "2026-08-21", rates: { USD: 1.1699 } },
  { date: "2022-09-15", rates: { USD: 0.9992 } },
]);

/**
 * The ticket's worked example: a USD 24.00 receipt at 20%, settled by card at
 * EUR 21.28. The ECB published 1.1507 USD/EUR that day — EUR 0.8690 per USD.
 */
const OPENAI: UvaTransaction = {
  id: "t-openai",
  date: "2026-07-31",
  amount: -2128,
  partnerName: "OpenAI",
  files: [
    {
      id: "f-openai",
      currency: "USD",
      totalGross: 2400,
      rateGroups: [{ rate: 20, net: 2000, vat: 400, gross: 2400 }],
      supplierVatId: "ATU12345678",
    },
  ],
};

const run = (transactions: UvaTransaction[], rates = RATES, period = Q3) =>
  calculateUva({ period, transactions, ecbRates: rates });

describe("which rate converts a foreign-currency document", () => {
  it("prefers the ECB rate published for the payment date", () => {
    const result = run([OPENAI]);

    // 4.00 USD of VAT at 0.8690 EUR/USD, not at the 0.8867 the card charged.
    expect(result.totalInputVat).toBe(348);
    expect(result.fxConversions[0]).toMatchObject({
      fileId: "f-openai",
      documentCurrency: "USD",
      documentGross: 2400,
      documentVat: 400,
      bankAmount: 2128,
      method: "ecb-reference",
      reason: "ecb-published",
      rateDate: "2026-07-31",
      band: "tight",
    });
    expect(result.fxConversions[0].appliedRate).toBeCloseTo(1 / 1.1507, 10);
    expect(result.fxConversions[0].impliedRate).toBeCloseTo(2128 / 2400, 10);
  });

  it("falls back to the effective bank rate when the run has no rates at all", () => {
    // The pre-#92 figure, to the cent: 3.55 rather than 3.48.
    const result = calculateUva({ period: Q3, transactions: [OPENAI] });

    expect(result.totalInputVat).toBe(355);
    expect(result.fxConversions[0]).toMatchObject({
      method: "effective-bank-rate",
      reason: "no-ecb-table",
      rateDate: null,
    });
  });

  it("falls back when the table cannot reach the payment date", () => {
    const stale = buildEcbRateTable([{ date: "2026-01-14", rates: { USD: 1.1651 } }]);

    const result = run([OPENAI], stale);

    expect(result.totalInputVat).toBe(355);
    expect(result.fxConversions[0]).toMatchObject({
      method: "effective-bank-rate",
      reason: "no-ecb-rate",
      rateDate: null,
    });
  });

  it("falls back when the feed carries no rate for the currency", () => {
    const gbp: UvaTransaction = {
      ...OPENAI,
      id: "t-gbp",
      files: [{ ...OPENAI.files![0], id: "f-gbp", currency: "GBP" }],
      amount: -2800,
    };

    const result = run([gbp]);

    expect(result.fxConversions[0]).toMatchObject({
      documentCurrency: "GBP",
      method: "effective-bank-rate",
      reason: "no-ecb-rate",
    });
  });

  it("uses the last rate published before a weekend payment", () => {
    // § 20 Abs 6: "den LETZTEN, von der EZB veröffentlichten" rate. 2026-08-23
    // is a Sunday; the ECB published on the Friday.
    const sunday: UvaTransaction = { ...OPENAI, id: "t-sunday", date: "2026-08-23" };

    expect(run([sunday]).fxConversions[0]).toMatchObject({
      method: "ecb-reference",
      rateDate: "2026-08-21",
    });
  });
});

describe("the plausibility gate", () => {
  it("still refuses a bank line that is not a believable payment of the document", () => {
    // Half of a USD 24.00 document paid on a day the ECB published: the rate
    // choice is irrelevant, because a partial payment must not be rescaled by
    // any rate at all.
    const partial: UvaTransaction = { ...OPENAI, id: "t-partial", amount: -1064 };

    const result = run([partial]);

    expect(result.fxConversions).toEqual([]);
    expect(result.totalInputVat).toBe(0);
    expect(result.unresolved[0].reason).toBe("foreign-currency");
  });

  it("date-keys the anchor, so a 2022 pair is judged against 2022", () => {
    // USD sat at parity with EUR in September 2022 (0.9992 USD/EUR). A USD
    // 100.00 document settled at EUR 75.00 is therefore not a plausible full
    // payment — but the static anchor is current-era (0.88 EUR/USD), which put
    // it inside the loose band and rescaled a three-quarter payment.
    const parityEra: UvaTransaction = {
      id: "t-2022",
      date: "2022-09-15",
      amount: -7500,
      files: [
        {
          id: "f-2022",
          currency: "USD",
          totalGross: 10000,
          rateGroups: [{ rate: 20, net: 8333, vat: 1667, gross: 10000 }],
        },
      ],
    };

    expect(calculateUva({ period: Q3_2022, transactions: [parityEra] }).totalInputVat)
      .toBeGreaterThan(0);
    expect(run([parityEra], RATES, Q3_2022).unresolved[0].reason).toBe("foreign-currency");
  });
});

describe("reconciliation against the bank line (R6)", () => {
  it("does not read the markup the ECB rate strips as an over-payment", () => {
    // The converted document totals 20.86 while the card debited 21.28. Read
    // as a payment difference that is a 42-cent overpay on a non-restaurant,
    // i.e. amount-mismatch — the claim would be refused for being MORE
    // correct. The residual is the issuer's markup, and the plausibility gate
    // already decided, in USD, that this line is the whole payment.
    const result = run([OPENAI]);

    expect(result.unresolved).toEqual([]);
    expect(result.derivations[0]).toMatchObject({ step: "rate-groups", inputVat: 348 });
  });

  it("still refuses a genuine mismatch on a converted document", () => {
    // Same document, but the card debited nearly double. No rate makes that
    // a payment of this receipt.
    const overpaid: UvaTransaction = { ...OPENAI, id: "t-overpaid", amount: -4100 };

    expect(run([overpaid]).unresolved[0].reason).toBe("foreign-currency");
  });
});

describe("what the filing says about the rate", () => {
  it("names method 2 and bounds nothing, because there is nothing to bound", () => {
    const filing = buildUvaFiling({ report: run([OPENAI]) });
    const fx = filing.exceptions.find((e) => e.kind === "fx-ecb-reference")!;

    expect(fx.basis).toContain("§ 20 Abs 6 UStG method 2");
    expect(fx.basis).toContain("Europäischen Zentralbank");
    expect(fx.exposure).toBeNull();
    expect(fx.fileIds).toEqual(["f-openai"]);
    expect(fx.amount).toBe(348);
    expect(filing.exceptions.some((e) => e.kind === "fx-effective-rate")).toBe(false);
  });

  it("carries both methods when a quarter used both", () => {
    const noRate: UvaTransaction = { ...OPENAI, id: "t-no-rate", date: "2026-09-30" };

    const filing = buildUvaFiling({ report: run([OPENAI, noRate]) });

    expect(filing.exceptions.map((e) => e.kind).sort()).toEqual([
      "fx-ecb-reference",
      "fx-effective-rate",
    ]);
    const fallback = filing.exceptions.find((e) => e.kind === "fx-effective-rate")!;
    expect(fallback.fileIds).toEqual(["f-openai"]);
    expect(fallback.exposure).toEqual({ low: 4, high: 11 });
  });

  it("reports the delta per document, both rates on the record", () => {
    const filing = buildUvaFiling({ report: run([OPENAI]) });

    expect(filing.fxRateDeltas).toEqual(deriveFxRateDeltas(filing.report));
    expect(filing.fxRateDeltas[0]).toMatchObject({
      fileId: "f-openai",
      documentCurrency: "USD",
      documentGross: 2400,
      documentVat: 400,
      method: "ecb-reference",
      rateDate: "2026-07-31",
      vatAtEffectiveRate: 355,
      vatAtAppliedRate: 348,
      vatDelta: -7,
    });
    expect(filing.exceptions.find((e) => e.kind === "fx-ecb-reference")!.statement)
      .toContain("-7 cent(s)");
  });

  it("reports a zero delta on the fallback rather than omitting the document", () => {
    const filing = buildUvaFiling({ report: calculateUva({ period: Q3, transactions: [OPENAI] }) });

    expect(filing.fxRateDeltas[0]).toMatchObject({
      method: "effective-bank-rate",
      vatAtEffectiveRate: 355,
      vatAtAppliedRate: 355,
      vatDelta: 0,
    });
  });
});
