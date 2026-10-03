import { describe, it, expect } from "vitest";
import { calculateUva } from "./calculateUva";
import { compareWithFiled, differsFrom, kennzahlValues, validateFiledKennzahlen } from "./filedRecord";
import { buildUvaFiling } from "./filing";
import { snapshotDerivations } from "./reconcile";
import type { UvaCorrection, UvaPeriod, UvaTransaction } from "./types";

const Q1: UvaPeriod = { year: 2026, period: 1, type: "quarterly" };

/** A 30,00 Amazon refund whose credit note prints negative figures. */
const refund = (correction: UvaCorrection | null): UvaTransaction => ({
  id: "t-refund",
  date: "2026-02-10",
  amount: 3000,
  files: [{ id: "f-credit", totalGross: -3000, vatPercent: 20, vatAmount: -500 }],
  correction,
});
const purchase: UvaTransaction = {
  id: "t-purchase",
  date: "2026-01-05",
  amount: -12000,
  files: [{ id: "f-invoice", totalGross: 12000, vatPercent: 20, vatAmount: 2000 }],
};
const linked: UvaCorrection = {
  status: "linked",
  kind: "purchase",
  basis: "link",
  original: { fileId: "f-invoice", paidByTransactionIds: ["t-purchase"], gross: 12000, claimed: [{ rate: 20, net: 10000, vat: 2000 }] },
  priorCorrected: [],
};

const run = (txs: UvaTransaction[]) => calculateUva({ period: Q1, transactions: txs });

describe("validateFiledKennzahlen", () => {
  it("takes three-digit codes in whole cents, and requires KZ 095", () => {
    expect(validateFiledKennzahlen({ "060": 2000, "095": -2000 })).toEqual({ "060": 2000, "095": -2000 });
    expect(validateFiledKennzahlen({ "060": 2000 })).toMatch(/KZ 095/);
    expect(validateFiledKennzahlen({ "60": 1, "095": 0 })).toMatch(/three-digit/);
    expect(validateFiledKennzahlen({ "060": 20.5, "095": 0 })).toMatch(/whole cents/);
  });
});

describe("compareWithFiled", () => {
  // Filed before the fix: the refund as negative revenue.
  const before = run([purchase, refund({ status: "unlinked", reason: "no-link", fileIds: ["f-credit"] })]);
  const filed = {
    periodKey: "2026-Q1",
    period: Q1,
    filedAt: "2026-10-03T10:00:00.000Z",
    kennzahlen: kennzahlValues(before),
  };

  it("shows nothing moved against the run it was filed on", () => {
    const c = compareWithFiled(filed, snapshotDerivations(before), before);
    expect(c).toMatchObject({ moved: false, deltas: [], balanceMoved: false, transactions: [] });
  });

  it("shows filed vs now per Kennzahl and the Transactions behind it", () => {
    const now = run([purchase, refund(linked)]);
    const c = compareWithFiled(filed, snapshotDerivations(before), now);
    expect(c.moved).toBe(true);
    expect(c.deltas.map((d) => d.code)).toEqual(["000", "022", "067"]);
    expect(c.deltas.find((d) => d.code === "067")).toEqual({ code: "067", filed: 0, now: -500, delta: -500 });
    expect(c.transactions.map((m) => m.transactionId)).toEqual(["t-refund"]);
  });

  it("tells a move between Kennzahlen apart from a move in the amount payable", () => {
    const now = run([purchase, refund(linked)]);
    // The unlinked refund at the defaulted 20% owed what its correction gives
    // back, so linking it only moves the amount between Kennzahlen.
    expect(compareWithFiled(filed, snapshotDerivations(before), now)).toMatchObject({
      balanceMoved: false,
      balanceDelta: 0,
    });
    const filedLower = { ...filed, kennzahlen: { ...filed.kennzahlen, "095": filed.kennzahlen["095"] - 1000 } };
    expect(compareWithFiled(filedLower, snapshotDerivations(before), now)).toMatchObject({
      balanceMoved: true,
      balanceDelta: 1000,
    });
  });

  it("compares against the figures filed by hand, not the calculated ones", () => {
    const now = run([purchase, refund(linked)]);
    const byHand = { ...filed, kennzahlen: kennzahlValues(now) };
    expect(differsFrom(byHand.kennzahlen, filed.kennzahlen)).toBe(true);
    expect(compareWithFiled(byHand, snapshotDerivations(before), now)).toMatchObject({ moved: false });
  });
});

describe("the handover raises earlier filed periods that moved", () => {
  it("keeps the moved ones and never blocks on them", () => {
    const report = run([purchase]);
    const moved = { periodKey: "2025-Q4", moved: true } as never;
    const still = { periodKey: "2025-Q3", moved: false } as never;
    const filing = buildUvaFiling({ report, filedPeriods: [moved, still] });
    expect(filing.filedPeriodsMoved).toEqual([moved]);
    expect(filing.blockers).toEqual([]);
  });
});
