/**
 * Non-claimable VAT (#203): a document prints a VAT-looking figure that no
 * § 12 deduction reaches, and a human says so once, with a reason.
 *
 * Both anchors are live corpus records, and both are here as the figures they
 * actually carry rather than as fixtures on disk — the rule has to be provable
 * without a database, a network, or the corpus itself.
 *
 * The before/after deltas are asserted, not assumed: each anchor runs the same
 * transaction twice, once unmarked and once marked, and the tests state exactly
 * which figure moved.
 */

import { describe, it, expect } from "vitest";
import { calculateUva, deriveRateGroups } from "./calculateUva";
import { deriveTransactionVat } from "./transactionVat";
import { toUvaFile } from "./adapter";
import type { UvaPeriod, UvaReportResult, UvaTransaction } from "./types";

const Q1_2026: UvaPeriod = { year: 2026, period: 1, type: "quarterly" };

function run(
  transactions: UvaTransaction[],
  period: UvaPeriod = Q1_2026
): UvaReportResult {
  return calculateUva({ period, transactions });
}

/**
 * paperless-ap-1004 — Filmproduktionshaftpflichtversicherung, 11%.
 *
 * The only file in the corpus outside the Austrian rate set. 11% is
 * Versicherungssteuer; insurance is VAT-exempt (§ 6 Abs 1 Z 9 lit. c UStG), so
 * the 22.00 EUR is not Vorsteuer and never was. The file carries a validated
 * printed rate-group block, which is the strongest rung of the ladder.
 */
const INSURANCE: UvaTransaction = {
  id: "t-ap-1004",
  date: "2026-02-18",
  amount: -22200,
  partnerName: "Filmproduktionshaftpflicht",
  files: [
    {
      id: "paperless-ap-1004",
      totalGross: 22200,
      supplierVatId: "ATU12345678",
      rateGroups: [{ rate: 11, net: 20000, vat: 2200, gross: 22200 }],
    },
  ],
};

/**
 * FIBU_20260109-8624 — a 100% discount leaves EUR 0 due.
 *
 * The document still prints its 20% line; the standing decision is that its VAT
 * must not be claimed. Modelled as a payment of the residual only, so there is
 * a bank line for the derivation to hang off at all.
 */
const DISCOUNTED: UvaTransaction = {
  id: "t-fibu-8624",
  date: "2026-01-09",
  amount: -12000,
  partnerName: "FIBU 20260109-8624",
  files: [
    {
      id: "FIBU_20260109-8624",
      totalGross: 12000,
      vatPercent: 20,
      vatAmount: 2000,
    },
  ],
};

const marked = (tx: UvaTransaction, reason: "insurance-tax" | "discount-to-zero" | "levy" | "private"): UvaTransaction => ({
  ...tx,
  files: (tx.files ?? []).map((f) => ({ ...f, nonClaimableVatReason: reason })),
});

// ---------------------------------------------------------------------------
// The corpus anchors, before and after
// ---------------------------------------------------------------------------

describe("paperless-ap-1004 — Versicherungssteuer at 11%", () => {
  it("today: claims nothing, but sits on the chasing list as 22.00 recoverable", () => {
    const before = run([INSURANCE]);

    expect(before.totalInputVat).toBe(0);
    expect(before.unresolved).toHaveLength(1);
    expect(before.unresolved[0].reason).toBe("foreign-or-invalid-rate");
    // The damage: 22.00 EUR reported as input VAT a receipt could recover.
    expect(before.unresolved[0].foregoneVat).toBe(2200);
    expect(before.nonClaimableVat).toHaveLength(0);
  });

  it("marked insurance-tax: the 22.00 is excluded with its reason, not chased", () => {
    const after = run([marked(INSURANCE, "insurance-tax")]);

    expect(after.totalInputVat).toBe(0);
    expect(after.kennzahlen["060"]?.value ?? 0).toBe(0);
    expect(after.unresolved).toHaveLength(0);
    expect(after.nonClaimableVat).toEqual([
      {
        transactionId: "t-ap-1004",
        fileId: "paperless-ap-1004",
        reason: "insurance-tax",
        excludedVat: 2200,
      },
    ]);
  });

  it("states the delta: Vorsteuer unchanged at 0, 22.00 moves off the chasing list", () => {
    const before = run([INSURANCE]);
    const after = run([marked(INSURANCE, "insurance-tax")]);

    expect(after.totalInputVat - before.totalInputVat).toBe(0);
    expect(after.totalOutputVat - before.totalOutputVat).toBe(0);
    expect(after.balance - before.balance).toBe(0);

    const foregoneBefore = before.unresolved.reduce((s, u) => s + (u.foregoneVat ?? 0), 0);
    const foregoneAfter = after.unresolved.reduce((s, u) => s + (u.foregoneVat ?? 0), 0);
    expect(foregoneBefore - foregoneAfter).toBe(2200);
    expect(after.nonClaimableVat.reduce((s, n) => s + n.excludedVat, 0)).toBe(2200);
  });

  it("reports the exclusion as the derivation step, not as a top-level reading", () => {
    const after = run([marked(INSURANCE, "insurance-tax")]);
    expect(after.kennzahlen["060"].contributions["non-claimable"]).toBe(1);
  });
});

describe("FIBU_20260109-8624 — 100% discount, EUR 0 due", () => {
  it("today: the printed 20% reaches Vorsteuer", () => {
    const before = run([DISCOUNTED]);

    expect(before.totalInputVat).toBe(2000);
    expect(before.kennzahlen["060"].value).toBe(2000);
  });

  it("marked discount-to-zero: 20.00 leaves Vorsteuer with its reason attached", () => {
    const before = run([DISCOUNTED]);
    const after = run([marked(DISCOUNTED, "discount-to-zero")]);

    expect(after.totalInputVat).toBe(0);
    expect(after.totalInputVat - before.totalInputVat).toBe(-2000);
    expect(after.balance - before.balance).toBe(2000);
    expect(after.unresolved).toHaveLength(0);
    expect(after.nonClaimableVat).toEqual([
      {
        transactionId: "t-fibu-8624",
        fileId: "FIBU_20260109-8624",
        reason: "discount-to-zero",
        excludedVat: 2000,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The rules around the two anchors
// ---------------------------------------------------------------------------

describe("non-claimable VAT rules", () => {
  it("moves no figure on an unmarked document", () => {
    const plain = run([DISCOUNTED]);
    expect(plain.nonClaimableVat).toHaveLength(0);
    expect(plain.totalInputVat).toBe(2000);
  });

  it("books the document's gross at 0%, so the payment is still fully covered", () => {
    const d = deriveRateGroups(marked(DISCOUNTED, "discount-to-zero"));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.step).toBe("non-claimable");
    expect(d.groups).toEqual([{ rate: 0, net: 12000, vat: 0, gross: 12000 }]);
  });

  it("leaves output VAT alone on income — the marker is about deduction", () => {
    // Zeroing an outgoing document's VAT would understate the liability, which
    // is the error direction the whole module refuses to make (D1).
    const income: UvaTransaction = {
      id: "t-income",
      date: "2026-02-01",
      amount: 12000,
      files: [
        {
          id: "f-out",
          totalGross: 12000,
          vatPercent: 20,
          vatAmount: 2000,
          nonClaimableVatReason: "private",
        },
      ],
    };
    const r = run([income]);
    expect(r.totalOutputVat).toBe(2000);
    expect(r.nonClaimableVat).toHaveLength(0);
  });

  it("excludes only the marked file when a payment carries two documents", () => {
    const r = run([
      {
        id: "t-mixed",
        date: "2026-02-05",
        amount: -34200,
        files: [
          {
            id: "paperless-ap-1004",
            totalGross: 22200,
            supplierVatId: "ATU12345678",
            rateGroups: [{ rate: 11, net: 20000, vat: 2200, gross: 22200 }],
            nonClaimableVatReason: "insurance-tax",
          },
          { id: "f-office", totalGross: 12000, vatPercent: 20, vatAmount: 2000 },
        ],
      },
    ]);

    expect(r.totalInputVat).toBe(2000);
    expect(r.nonClaimableVat).toHaveLength(1);
    expect(r.nonClaimableVat[0].excludedVat).toBe(2200);
    // A file that DID produce a claim names the rung it came from.
    expect(r.kennzahlen["060"].contributions["top-level"]).toBe(1);
  });

  it("carries the exclusion onto the single-transaction lane the BMD export runs", () => {
    const v = deriveTransactionVat(marked(INSURANCE, "insurance-tax"));
    expect(v.kind).toBe("groups");
    if (v.kind !== "groups") return;
    expect(v.groups).toEqual([{ rate: 0, net: 22200, vat: 0, gross: 22200 }]);
    expect(v.nonClaimableVat).toHaveLength(1);
    expect(v.nonClaimableVat[0].reason).toBe("insurance-tax");
  });

  it("reads the marker off a stored file record", () => {
    expect(
      toUvaFile({ id: "f1", vatNotClaimableReason: "levy" }).nonClaimableVatReason
    ).toBe("levy");
    expect(toUvaFile({ id: "f2" }).nonClaimableVatReason).toBeNull();
  });
});
