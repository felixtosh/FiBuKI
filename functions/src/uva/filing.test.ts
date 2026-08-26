/**
 * The filing record (#85): the trace, the exceptions and the handover gate.
 */

import { describe, it, expect } from "vitest";
import { calculateUva } from "./calculateUva";
import {
  buildUvaFiling,
  buildVorsteuerTrace,
  deriveFilingExceptions,
  FX_MARKUP_HIGH,
  FX_MARKUP_LOW,
} from "./filing";
import { reconcileDerivations, snapshotDerivations } from "./reconcile";
import type { UvaPeriod, UvaTransaction } from "./types";

const Q1_2026: UvaPeriod = { year: 2026, period: 1, type: "quarterly" };

const run = (transactions: UvaTransaction[], period: UvaPeriod = Q1_2026) =>
  calculateUva({ period, transactions });

const DOCUMENTED: UvaTransaction = {
  id: "t-doc",
  date: "2026-02-10",
  amount: -12000,
  partnerName: "Supplier",
  files: [{ id: "f-doc", totalGross: 12000, vatPercent: 20, vatAmount: 2000 }],
};

describe("buildVorsteuerTrace", () => {
  it("traces a claim to the document it rests on", () => {
    const trace = buildVorsteuerTrace(run([DOCUMENTED]));

    expect(trace.traced).toEqual([
      {
        transactionId: "t-doc",
        date: "2026-02-10",
        partner: "Supplier",
        vat: 2000,
        step: "top-level",
        fileIds: ["f-doc"],
      },
    ]);
    expect(trace.untraced).toHaveLength(0);
    expect(trace.reconciles).toBe(true);
  });

  it("lists a hand-typed rate as undocumented instead of dropping it", () => {
    // The override lane resolves a rate with no receipt at all. § 12 Abs 1 Z 1
    // deducts tax invoiced under § 11 — this claim has nothing behind it, and
    // silently counting it is exactly what the trace exists to stop.
    const trace = buildVorsteuerTrace(
      run([{ id: "t-ovr", date: "2026-02-11", amount: -6000, vatRateOverride: 20 }])
    );

    expect(trace.traced).toHaveLength(0);
    expect(trace.untraced).toHaveLength(1);
    expect(trace.untraced[0]).toMatchObject({ basis: "no-document", vat: 1000 });
    expect(trace.undocumentedVat).toBe(1000);
    expect(trace.reconciles).toBe(true);
  });

  it("names reverse-charge input VAT as self-assessed, not as a missing invoice", () => {
    const trace = buildVorsteuerTrace(
      run([
        {
          id: "t-rc",
          date: "2026-02-12",
          amount: -10000,
          files: [{ id: "f-rc", totalGross: 10000, supplierVatId: "IE6388047V" }],
          foreignRegime: { kind: "service", origin: "eu", basis: "heuristic" },
        },
      ])
    );

    expect(trace.untraced[0]).toMatchObject({ basis: "self-assessed", vat: 2000 });
    // The pair nets to zero in the same run, so it is not an unsupported claim.
    expect(trace.undocumentedVat).toBe(0);
  });

  it("names import VAT after the customs declaration that evidences it", () => {
    const trace = buildVorsteuerTrace(
      run([
        {
          id: "t-imp",
          date: "2026-02-13",
          amount: -50000,
          foreignRegime: {
            kind: "goods",
            origin: "third-country",
            basis: "override",
            importVatPaid: 10000,
          },
        },
      ])
    );

    expect(trace.untraced[0]).toMatchObject({ basis: "import-declaration", vat: 10000 });
    expect(trace.undocumentedVat).toBe(0);
  });

  it("adds up to the run's own input-VAT total", () => {
    const result = run([
      DOCUMENTED,
      { id: "t-ovr", date: "2026-02-11", amount: -6000, vatRateOverride: 20 },
      {
        id: "t-rc",
        date: "2026-02-12",
        amount: -10000,
        files: [{ id: "f-rc", totalGross: 10000, supplierVatId: "IE6388047V" }],
        foreignRegime: { kind: "service", origin: "eu", basis: "heuristic" },
      },
    ]);
    const trace = buildVorsteuerTrace(result);

    expect(trace.tracedVat + trace.untracedVat).toBe(result.totalInputVat);
    expect(trace.reconciles).toBe(true);
  });
});

describe("deriveFilingExceptions", () => {
  it("reads a non-claimable marker off the run and states its statutory basis", () => {
    const exceptions = deriveFilingExceptions(
      run([
        {
          id: "t-ins",
          date: "2026-02-18",
          amount: -22200,
          files: [
            {
              id: "paperless-ap-1004",
              totalGross: 22200,
              supplierVatId: "ATU12345678",
              rateGroups: [{ rate: 11, net: 20000, vat: 2200, gross: 22200 }],
              nonClaimableVatReason: "insurance-tax",
            },
          ],
        },
      ])
    );

    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({
      kind: "non-claimable-vat",
      reason: "insurance-tax",
      fileIds: ["paperless-ap-1004"],
      amount: 2200,
      exposure: null,
    });
    expect(exceptions[0].basis).toContain("§ 6 Abs 1 Z 9 lit. c UStG");
  });

  it("groups one exception per reason, not one per document", () => {
    const exceptions = deriveFilingExceptions(
      run([
        {
          id: "t-a",
          date: "2026-01-05",
          amount: -12000,
          files: [
            { id: "f-a", totalGross: 12000, vatPercent: 20, vatAmount: 2000, nonClaimableVatReason: "private" },
          ],
        },
        {
          id: "t-b",
          date: "2026-01-06",
          amount: -6000,
          files: [
            { id: "f-b", totalGross: 6000, vatPercent: 20, vatAmount: 1000, nonClaimableVatReason: "private" },
          ],
        },
      ])
    );

    expect(exceptions).toHaveLength(1);
    expect(exceptions[0].fileIds).toEqual(["f-a", "f-b"]);
    expect(exceptions[0].amount).toBe(3000);
  });

  it("states the foreign-currency method and bounds the markup it carries", () => {
    // USD 25.00 settled as EUR 22.00 — the effective rate the card actually
    // charged. § 20 Abs 6 method 3 allows it; the issuer's markup lives inside
    // it, so the exposure is bounded rather than left implicit.
    const result = run([
      {
        id: "t-usd",
        date: "2026-03-02",
        amount: -2200,
        files: [
          { id: "f-usd", currency: "USD", totalGross: 2500, vatPercent: 20 },
        ],
      },
    ]);
    const [fx] = deriveFilingExceptions(result).filter((e) => e.kind === "fx-effective-rate");

    expect(result.fxConversions).toHaveLength(1);
    expect(result.fxConversions[0]).toMatchObject({
      documentCurrency: "USD",
      documentGross: 2500,
      bankAmount: 2200,
      band: "tight",
    });
    expect(fx.amount).toBe(result.totalInputVat);
    expect(fx.basis).toContain("§ 20 Abs 6 UStG method 3");
    expect(fx.exposure).toEqual({
      low: Math.round(fx.amount * FX_MARKUP_LOW),
      high: Math.round(fx.amount * FX_MARKUP_HIGH),
    });
  });

  it("says nothing when the run carries no exception", () => {
    expect(deriveFilingExceptions(run([DOCUMENTED]))).toEqual([]);
  });
});

describe("buildUvaFiling", () => {
  it("is prepared, never submitted, and states the Ist basis on its face", () => {
    const filing = buildUvaFiling({ report: run([DOCUMENTED]) });

    expect(filing.handover).toEqual({ state: "prepared" });
    expect(filing.basis).toBe("ist");
    expect(filing.blockers).toEqual([]);
  });

  it("blocks on input VAT that rests on no document", () => {
    const filing = buildUvaFiling({
      report: run([{ id: "t-ovr", date: "2026-02-11", amount: -6000, vatRateOverride: 20 }]),
    });

    expect(filing.blockers.map((b) => b.code)).toEqual(["vorsteuer-undocumented"]);
    expect(filing.blockers[0].detail).toContain("1000 cents");
  });

  it("blocks on an open item deferred without a reason", () => {
    const filing = buildUvaFiling({
      report: run([DOCUMENTED]),
      openItems: [
        {
          ref: "OEBBTicket",
          summary: "Total present, no VAT rate on the document",
          disposition: "deferred",
          rationale: "   ",
          effect: { inputVat: 671, outputVat: 0 },
        },
      ],
    });

    expect(filing.blockers.map((b) => b.code)).toEqual(["open-item-unexplained"]);
  });

  it("carries a declared open item through with its effect intact", () => {
    const filing = buildUvaFiling({
      report: run([DOCUMENTED]),
      openItems: [
        {
          ref: "OEBBTicket",
          summary: "Total present, no VAT rate on the document",
          disposition: "deferred",
          rationale:
            "Austrian passenger rail is 10% (§ 10 Abs 2 UStG), but the rate is not " +
            "on the document and the original ruling did not cover it.",
          effect: { inputVat: 671, outputVat: 0 },
        },
      ],
    });

    expect(filing.blockers).toEqual([]);
    expect(filing.openItems[0].effect).toEqual({ inputVat: 671, outputVat: 0 });
  });

  it("keeps a recorded handover, and says so when the run no longer matches it", () => {
    const report = run([DOCUMENTED]);
    const handover = {
      state: "handed-over" as const,
      to: "Stefan",
      at: "2026-08-24",
      via: "e-mail",
    };

    const asSent = buildUvaFiling({
      report,
      handover,
      handoverCovers: {
        totalInputVat: report.totalInputVat,
        totalOutputVat: report.totalOutputVat,
        balance: report.balance,
      },
    });
    // A late correction to a document the Steuerberater already has.
    const corrected = buildUvaFiling({
      report: run([
        { ...DOCUMENTED, files: [{ id: "f-doc", totalGross: 12000, vatPercent: 20, vatAmount: 1500 }] },
      ]),
      handover,
      handoverCovers: {
        totalInputVat: report.totalInputVat,
        totalOutputVat: report.totalOutputVat,
        balance: report.balance,
      },
    });

    expect(asSent.blockers).toEqual([]);
    expect(corrected.handover).toEqual(handover);
    expect(corrected.blockers.map((b) => b.code)).toEqual(["handover-stale"]);
  });

  it("rejects a baseline from another period rather than reporting its delta", () => {
    const before = snapshotDerivations(run([DOCUMENTED]));
    const after = snapshotDerivations(
      calculateUva({
        period: { year: 2026, period: 2, type: "quarterly" },
        transactions: [{ ...DOCUMENTED, date: "2026-05-10" }],
      })
    );
    const filing = buildUvaFiling({
      report: run([DOCUMENTED]),
      reconciliation: reconcileDerivations(before, after),
    });

    expect(filing.blockers.map((b) => b.code)).toEqual(["reconciliation-not-comparable"]);
  });
});
