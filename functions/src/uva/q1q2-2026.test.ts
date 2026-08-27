/**
 * Q1 / Q2 2026 — the filing itself (#85).
 *
 * Both quarters are overdue (Q2/2026 was due 2026-08-17, Q1/2026 roughly three
 * months earlier), and both are derived on the cash basis against the corpus as
 * it stands after the D6 extraction sweep. The sandbox has no access to that
 * corpus, so — as in the #203 anchors — the records that decide a figure are
 * here as the figures they actually carry, at the pure seam, where the rule can
 * be proved without a database or a network.
 *
 * What this file pins is the filing's SHAPE against the live numbers: the three
 * exceptions it carries and their reasoning, the open items and what each one
 * moves, the trace from every claimed cent to a document, and the fact that the
 * artefact leaving here is prepared for a human and never submitted.
 */

import { describe, it, expect } from "vitest";
import { calculateUva } from "./calculateUva";
import {
  buildUvaFiling,
  FX_MARKUP_HIGH,
  FX_MARKUP_LOW,
  type UvaOpenItem,
} from "./filing";
import { buildEcbRateTable } from "../fx/ecbRates";
import { reconcileDerivations, snapshotDerivations } from "./reconcile";
import type { UvaPeriod, UvaTransaction } from "./types";

const Q1: UvaPeriod = { year: 2026, period: 1, type: "quarterly" };
const Q2: UvaPeriod = { year: 2026, period: 2, type: "quarterly" };

const run = (period: UvaPeriod, transactions: UvaTransaction[]) =>
  calculateUva({ period, transactions });

/**
 * The ECB reference rates for the eight payment dates below (#92), read off
 * the published `eurofxref` history as USD per 1 EUR. 2026-05-01 is a TARGET
 * holiday and 2026-05-03 a Sunday, so the 3 May payment reads 30 April — the
 * "letzter veröffentlichter Kurs" the statute names, not a gap.
 */
const ECB_RATES = buildEcbRateTable([
  { date: "2026-01-14", rates: { USD: 1.1651 } },
  { date: "2026-02-03", rates: { USD: 1.1801 } },
  { date: "2026-02-19", rates: { USD: 1.1753 } },
  { date: "2026-03-11", rates: { USD: 1.1581 } },
  { date: "2026-04-14", rates: { USD: 1.1793 } },
  { date: "2026-04-30", rates: { USD: 1.1702 } },
  { date: "2026-05-19", rates: { USD: 1.1620 } },
  { date: "2026-06-11", rates: { USD: 1.1537 } },
]);

const runAtEcbRates = (period: UvaPeriod, transactions: UvaTransaction[]) =>
  calculateUva({ period, transactions, ecbRates: ECB_RATES });

// ---------------------------------------------------------------------------
// Exception 2 — an 11% Filmproduktionshaftpflicht­versicherung
// ---------------------------------------------------------------------------

const INSURANCE: UvaTransaction = {
  id: "t-insurance-11pct",
  date: "2026-02-18",
  amount: -22200,
  partnerName: "Filmproduktionshaftpflicht",
  files: [
    {
      id: "f-insurance-11pct",
      totalGross: 22200,
      supplierVatId: "ATU12345678",
      rateGroups: [{ rate: 11, net: 20000, vat: 2200, gross: 22200 }],
      nonClaimableVatReason: "insurance-tax",
    },
  ],
};

// ---------------------------------------------------------------------------
// Exception 3 — a 100% discount leaving EUR 0 due
// ---------------------------------------------------------------------------

const DISCOUNTED: UvaTransaction = {
  id: "t-discount-to-zero",
  date: "2026-01-09",
  amount: -12000,
  partnerName: "Discounted Supplier",
  files: [
    {
      id: "f-discount-to-zero",
      totalGross: 12000,
      vatPercent: 20,
      vatAmount: 2000,
      nonClaimableVatReason: "discount-to-zero",
    },
  ],
};

// ---------------------------------------------------------------------------
// Exception 1 — the eight foreign-currency documents carrying Austrian VAT
//
// USD 51.00 of Vorsteuer across the two quarters, each document settled by the
// card at its own effective rate. Four fall in Q1 and four in Q2, which is why
// the ticket's exposure figure is stated across both and not per quarter.
// ---------------------------------------------------------------------------

/** One USD document paid by card: `vatUsd` at 20%, settled at `bank` EUR. */
function usdDocument(
  id: string,
  date: string,
  vatUsd: number,
  bank: number
): UvaTransaction {
  const net = vatUsd * 5;
  return {
    id: `t-${id}`,
    date,
    amount: -bank,
    partnerName: "USD supplier",
    files: [
      {
        id,
        currency: "USD",
        totalGross: net + vatUsd,
        rateGroups: [{ rate: 20, net, vat: vatUsd, gross: net + vatUsd }],
      },
    ],
  };
}

const FX_Q1 = [
  usdDocument("usd-1", "2026-01-14", 637, 3325),
  usdDocument("usd-2", "2026-02-03", 637, 3325),
  usdDocument("usd-3", "2026-02-19", 637, 3325),
  usdDocument("usd-4", "2026-03-11", 637, 3325),
];
const FX_Q2 = [
  usdDocument("usd-5", "2026-04-14", 637, 3325),
  usdDocument("usd-6", "2026-05-03", 637, 3325),
  usdDocument("usd-7", "2026-05-19", 637, 3325),
  usdDocument("usd-8", "2026-06-11", 641, 3346),
];

// ---------------------------------------------------------------------------
// The open items, each disposed of with a stated effect on the figures
// ---------------------------------------------------------------------------

const OPEN_ITEMS: UvaOpenItem[] = [
  {
    ref: "OEBBTicket",
    summary: "Fare total 73.80 present, but the document carries no VAT rate",
    disposition: "deferred",
    rationale:
      "Austrian passenger rail is 10% (§ 10 Abs 2 UStG), so the deduction is " +
      "very likely 6.71 on 73.80 — but the rate is not printed on the document " +
      "and the original ruling did not cover this class, so claiming it is an " +
      "operator decision rather than a derivation. Nothing is claimed until it " +
      "is made; the effect below is what making it adds.",
    effect: { inputVat: 671, outputVat: 0 },
  },
  {
    ref: "f-multi-rate-meal",
    summary: "Parsley POS receipt, 175.00, OCR failed twice",
    disposition: "deferred",
    rationale:
      "A POS receipt with a mixed 10/20 basket. Two re-extractions failed, so " +
      "the split has to be read off the paper. The effect below is the floor " +
      "(everything at 10%); the ceiling is 29.17 (everything at 20%), and the " +
      "true figure is between them. Nothing is claimed on a guess.",
    effect: { inputVat: 1591, outputVat: 0 },
  },
  {
    ref: "invoice-ninja-income-rows",
    summary:
      "SEMRUSH 2160.00, Tassadar 719.93, Tamer Aslan 3360.00, Schweighofer 390.00 " +
      "(now zero-value) — outgoing invoices still in Invoice Ninja",
    disposition: "deferred",
    rationale:
      "Income with no connected document defaults to 20% output VAT (D1: " +
      "understating an output liability is the worse error), so these rows are " +
      "already IN the figures at the highest plausible rate. The PDFs can only " +
      "confirm 20% or lower it, so the filing is not understated by their " +
      "absence and the effect of producing them is zero unless a row turns out " +
      "not to be 20%.",
    effect: { inputVat: 0, outputVat: 0 },
  },
  {
    ref: "VS_1011462062M",
    summary: "ORF-Beitrag 183.60, orphaned document",
    disposition: "resolved",
    rationale:
      "A private household document. It has no business bank line and never " +
      "will, so it cannot reach a transaction and cannot reach a Kennzahl. " +
      "Resolved as out of scope rather than left on a worklist.",
    effect: { inputVat: 0, outputVat: 0 },
  },
];

// ---------------------------------------------------------------------------

describe("Q1/Q2 2026 derived on the cash basis", () => {
  it("puts a payment in the quarter the money moved, not the quarter it was invoiced", () => {
    // Ist-Besteuerung (R3) is not a switch here — the derivation has no invoice
    // date to read at all. A January invoice settled in April is a Q2 figure
    // because the only date in the input is the bank movement.
    const januaryInvoicePaidInApril: UvaTransaction = {
      ...DISCOUNTED,
      id: "t-jan-invoice-apr-payment",
      date: "2026-04-02",
      files: [{ id: "f-jan", totalGross: 12000, vatPercent: 20, vatAmount: 2000 }],
    };

    expect(run(Q1, [januaryInvoicePaidInApril]).derivations).toHaveLength(0);
    const q2 = run(Q2, [januaryInvoicePaidInApril]);
    expect(q2.derivations).toHaveLength(1);
    expect(q2.totalInputVat).toBe(2000);
  });

  it("bounds each quarter by its own calendar days", () => {
    expect(run(Q1, []).period).toMatchObject({ start: "2026-01-01", end: "2026-03-31" });
    expect(run(Q2, []).period).toMatchObject({ start: "2026-04-01", end: "2026-06-30" });
  });
});

describe("the three exceptions, on the filing rather than in a session note", () => {
  const filing = buildUvaFiling({
    report: run(Q1, [INSURANCE, DISCOUNTED, ...FX_Q1]),
    openItems: OPEN_ITEMS,
  });

  it("records the Versicherungssteuer with the statute that excludes it", () => {
    const e = filing.exceptions.find((x) => x.reason === "insurance-tax");

    expect(e).toBeDefined();
    expect(e!.fileIds).toEqual(["f-insurance-11pct"]);
    expect(e!.amount).toBe(2200);
    expect(e!.basis).toContain("§ 6 Abs 1 Z 9 lit. c UStG");
    // The damage #203 fixed: 22.00 stops reading as recoverable input VAT.
    expect(filing.report.unresolved.some((u) => u.transactionId === "t-insurance-11pct")).toBe(false);
  });

  it("records the 100% discount, and the 20.00 it keeps out of KZ 060", () => {
    const e = filing.exceptions.find((x) => x.reason === "discount-to-zero");

    expect(e).toBeDefined();
    expect(e!.fileIds).toEqual(["f-discount-to-zero"]);
    expect(e!.amount).toBe(2000);
    expect(e!.basis).toContain("§ 12 Abs 1 Z 1");
  });

  it("records the foreign-currency method and what it costs, both quarters", () => {
    const q2 = buildUvaFiling({ report: run(Q2, FX_Q2) });
    const fxQ1 = filing.exceptions.find((x) => x.kind === "fx-effective-rate")!;
    const fxQ2 = q2.exceptions.find((x) => x.kind === "fx-effective-rate")!;

    expect(fxQ1.fileIds).toHaveLength(4);
    expect(fxQ2.fileIds).toHaveLength(4);
    expect(fxQ1.basis).toContain("§ 20 Abs 6 UStG method 3");
    expect(fxQ1.basis).toContain("Bankmitteilung");

    // USD 51.00 of Vorsteuer reads as EUR 44.36 at the rates the card charged.
    const converted = fxQ1.amount + fxQ2.amount;
    expect(converted).toBe(4436);
    // The alternative method (a published Tageskurs) differs by the issuer's
    // 1-3% markup: EUR 0.44 to EUR 1.33 across both quarters. That is the whole
    // measured exposure of deferring #92 until after the filing.
    expect(Math.round(converted * FX_MARKUP_LOW)).toBe(44);
    expect(Math.round(converted * FX_MARKUP_HIGH)).toBe(133);
    expect(fxQ1.exposure).toEqual({
      low: Math.round(fxQ1.amount * FX_MARKUP_LOW),
      high: Math.round(fxQ1.amount * FX_MARKUP_HIGH),
    });
  });

  it("derives all three from the data, so next quarter cannot lose them", () => {
    // None of the three is typed onto the filing: two are non-claimable markers
    // on the file records, the third is the conversion the derivation performed.
    // Re-running the quarter reproduces them without anyone remembering.
    const again = buildUvaFiling({ report: run(Q1, [INSURANCE, DISCOUNTED, ...FX_Q1]) });

    expect(again.exceptions.map((e) => e.kind).sort()).toEqual([
      "fx-effective-rate",
      "non-claimable-vat",
      "non-claimable-vat",
    ]);
  });
});

describe("every claimed Vorsteuer traces to a document", () => {
  const filing = buildUvaFiling({
    report: run(Q1, [INSURANCE, DISCOUNTED, ...FX_Q1]),
    openItems: OPEN_ITEMS,
  });

  it("accounts for the whole of KZ 060", () => {
    expect(filing.vorsteuer.reconciles).toBe(true);
    expect(filing.vorsteuer.tracedVat).toBe(filing.report.totalInputVat);
    expect(filing.vorsteuer.untraced).toHaveLength(0);
  });

  it("names the file behind each claimed cent", () => {
    expect(filing.vorsteuer.traced.map((t) => t.fileIds).flat().sort()).toEqual([
      "usd-1", "usd-2", "usd-3", "usd-4",
    ]);
    // The two excluded documents claim nothing, so they are on the exception
    // list rather than in the trace — a decision, not a gap.
    expect(filing.report.totalInputVat).toBe(4 * 554);
  });

  it("would list, not drop, a claim with nothing behind it", () => {
    const withOverride = buildUvaFiling({
      report: run(Q1, [
        ...FX_Q1,
        { id: "t-typed", date: "2026-03-20", amount: -6000, vatRateOverride: 20 },
      ]),
    });

    expect(withOverride.vorsteuer.undocumentedVat).toBe(1000);
    expect(withOverride.blockers.map((b) => b.code)).toEqual(["vorsteuer-undocumented"]);
  });
});

describe("the open items are each disposed of, with an effect", () => {
  const filing = buildUvaFiling({
    report: run(Q1, [INSURANCE, DISCOUNTED, ...FX_Q1]),
    openItems: OPEN_ITEMS,
  });

  it("carries all four with a rationale and a stated effect", () => {
    expect(filing.openItems).toHaveLength(4);
    for (const item of filing.openItems) {
      expect(item.rationale.trim().length).toBeGreaterThan(0);
      expect(item.effect).toBeDefined();
    }
    expect(filing.blockers).toEqual([]);
  });

  it("states the total the deferrals hold back from this filing", () => {
    const held = filing.openItems
      .filter((i) => i.disposition === "deferred")
      .reduce((s, i) => s + i.effect.inputVat, 0);

    // 6.71 rail + 15.91 floor on the Parsley receipt; the income rows move
    // nothing because they already book at the defaulted 20%.
    expect(held).toBe(2262);
  });
});

describe("handover", () => {
  it("is prepared for a human, and has no state that means submitted", () => {
    const filing = buildUvaFiling({
      report: run(Q1, [INSURANCE, DISCOUNTED, ...FX_Q1]),
      openItems: OPEN_ITEMS,
    });

    expect(filing.handover).toEqual({ state: "prepared" });
    expect(filing.blockers).toEqual([]);
  });

  it("records who received it and when, once a human hands it over", () => {
    const filing = buildUvaFiling({
      report: run(Q2, FX_Q2),
      openItems: OPEN_ITEMS,
      handover: { state: "handed-over", to: "Stefan", at: "2026-08-23", via: "e-mail" },
    });

    expect(filing.handover).toEqual({
      state: "handed-over",
      to: "Stefan",
      at: "2026-08-23",
      via: "e-mail",
    });
  });
});

describe("reconciliation against the pre-sweep baseline", () => {
  it("explains the movement per file instead of accepting it as noise", () => {
    // The D6 sweep's two outcomes on one quarter: one file gained its printed
    // rate-group block (better reading, same cents), one came back weaker off
    // the same rung (the #137 class, fixed by PR #144 and re-run).
    const preSweep = snapshotDerivations(
      run(Q1, [
        {
          id: "t-improved",
          date: "2026-02-01",
          amount: -12000,
          files: [{ id: "f-improved", totalGross: 12000, vatPercent: 20, vatAmount: 2000 }],
        },
        {
          id: "t-weaker",
          date: "2026-02-02",
          amount: -6000,
          files: [
            {
              id: "f-weaker",
              totalGross: 6000,
              rateGroups: [{ rate: 20, net: 5000, vat: 1000, gross: 6000 }],
            },
          ],
        },
      ])
    );
    const postSweep = snapshotDerivations(
      run(Q1, [
        {
          id: "t-improved",
          date: "2026-02-01",
          amount: -12000,
          files: [
            {
              id: "f-improved",
              totalGross: 12000,
              rateGroups: [{ rate: 20, net: 10000, vat: 2000, gross: 12000 }],
            },
          ],
        },
        {
          id: "t-weaker",
          date: "2026-02-02",
          amount: -6000,
          files: [
            {
              id: "f-weaker",
              totalGross: 6000,
              rateGroups: [{ rate: 20, net: 5200, vat: 800, gross: 6000 }],
            },
          ],
        },
      ])
    );
    const rec = reconcileDerivations(preSweep, postSweep);
    const byId = Object.fromEntries(rec.movements.map((m) => [m.transactionId, m]));

    expect(byId["t-improved"].kind).toBe("source-changed");
    expect(byId["t-improved"].fileIds).toEqual(["f-improved"]);
    expect(byId["t-weaker"].kind).toBe("figure-changed");
    expect(byId["t-weaker"].fileIds).toEqual(["f-weaker"]);
    expect(byId["t-weaker"].inputVatDelta).toBe(-200);
    expect(rec.accountedFor).toBe(true);
    expect(rec.totals.inputVatDelta).toBe(-200);
  });

  it("hangs off the filing when a baseline was kept", () => {
    const before = snapshotDerivations(run(Q1, [DISCOUNTED, ...FX_Q1]));
    const report = run(Q1, [INSURANCE, DISCOUNTED, ...FX_Q1]);
    const filing = buildUvaFiling({
      report,
      openItems: OPEN_ITEMS,
      reconciliation: reconcileDerivations(before, snapshotDerivations(report)),
    });

    expect(filing.reconciliation!.comparable).toBe(true);
    expect(filing.reconciliation!.accountedFor).toBe(true);
    expect(filing.blockers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #92 — what the ECB rate would have moved on the eight documents
//
// The filings for these two quarters went out under method 3 (the effective
// bank rate) as a written exception, with an exposure stated as a 1-3% band on
// the converted Vorsteuer: EUR 0.44 to EUR 1.33 across both quarters. Now that
// the published rates are in the run, the band can be replaced by the figure —
// per document, which is the point: an aggregate says the filing was close, a
// per-file table says which document moved and by how much.
// ---------------------------------------------------------------------------

describe("the ECB rate against the filed figures, per document", () => {
  const q1 = buildUvaFiling({ report: runAtEcbRates(Q1, FX_Q1) });
  const q2 = buildUvaFiling({ report: runAtEcbRates(Q2, FX_Q2) });
  const deltas = [...q1.fxRateDeltas, ...q2.fxRateDeltas];

  it("converts all eight at a published rate, naming the day for each", () => {
    expect(deltas.map((d) => [d.fileId, d.method, d.rateDate])).toEqual([
      ["usd-1", "ecb-reference", "2026-01-14"],
      ["usd-2", "ecb-reference", "2026-02-03"],
      ["usd-3", "ecb-reference", "2026-02-19"],
      ["usd-4", "ecb-reference", "2026-03-11"],
      ["usd-5", "ecb-reference", "2026-04-14"],
      ["usd-6", "ecb-reference", "2026-04-30"],
      ["usd-7", "ecb-reference", "2026-05-19"],
      ["usd-8", "ecb-reference", "2026-06-11"],
    ]);
  });

  it("states the move per file, not as a percentage of a total", () => {
    expect(
      deltas.map((d) => [d.fileId, d.vatAtEffectiveRate, d.vatAtAppliedRate, d.vatDelta])
    ).toEqual([
      ["usd-1", 554, 547, -7],
      ["usd-2", 554, 540, -14],
      ["usd-3", 554, 542, -12],
      ["usd-4", 554, 550, -4],
      ["usd-5", 554, 540, -14],
      ["usd-6", 554, 544, -10],
      ["usd-7", 554, 548, -6],
      ["usd-8", 558, 556, -2],
    ]);
  });

  it("lands inside the exposure the filings declared, and near its floor", () => {
    const moved = deltas.reduce((s, d) => s + d.vatDelta, 0);
    const filedAtBankRates = 4436;

    // EUR 0.69 less Vorsteuer across both quarters. The filings bounded the
    // method at EUR 0.44 to EUR 1.33; the measured figure sits inside it, so
    // the exception those filings carry was honest about its size.
    expect(moved).toBe(-69);
    expect(-moved).toBeGreaterThanOrEqual(Math.round(filedAtBankRates * FX_MARKUP_LOW));
    expect(-moved).toBeLessThanOrEqual(Math.round(filedAtBankRates * FX_MARKUP_HIGH));
  });

  it("moves KZ 060 by exactly that, and nothing else", () => {
    expect(run(Q1, FX_Q1).totalInputVat - q1.report.totalInputVat).toBe(37);
    expect(run(Q2, FX_Q2).totalInputVat - q2.report.totalInputVat).toBe(32);
    expect(q1.report.unresolved).toEqual([]);
    expect(q2.report.unresolved).toEqual([]);
  });

  it("re-labels the exception rather than dropping it", () => {
    const fx = q1.exceptions.find((e) => e.kind === "fx-ecb-reference")!;

    expect(fx.fileIds).toHaveLength(4);
    expect(fx.basis).toContain("§ 20 Abs 6 UStG method 2");
    expect(fx.exposure).toBeNull();
    expect(q1.blockers).toEqual([]);
  });
});
