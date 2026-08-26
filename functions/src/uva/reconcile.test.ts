/**
 * Reconciling two runs of the same period (#85).
 *
 * The D6 sweep is the shape these tests are built from: 325 documents
 * re-extracted, 131 better, 29 WORSE. Both groups move a figure, and a diff on
 * figures alone cannot tell them apart. The two cases below are the two the
 * sweep actually produced.
 */

import { describe, it, expect } from "vitest";
import { calculateUva } from "./calculateUva";
import {
  figureOnlyMovements,
  movedEntries,
  reconcileDerivations,
  snapshotDerivations,
} from "./reconcile";
import type { UvaPeriod, UvaTransaction } from "./types";

const Q1_2026: UvaPeriod = { year: 2026, period: 1, type: "quarterly" };
const Q2_2026: UvaPeriod = { year: 2026, period: 2, type: "quarterly" };

const snap = (transactions: UvaTransaction[], period: UvaPeriod = Q1_2026) =>
  snapshotDerivations(calculateUva({ period, transactions }));

/** The pre-sweep reading: no printed rate-group block, top-level extraction only. */
const PRE_SWEEP: UvaTransaction = {
  id: "t-1",
  date: "2026-02-10",
  amount: -12000,
  partnerName: "Supplier",
  files: [{ id: "f-1", totalGross: 12000, vatPercent: 20, vatAmount: 2000 }],
};

describe("snapshotDerivations", () => {
  it("projects the run's own per-transaction record, not a second derivation", () => {
    const s = snap([PRE_SWEEP]);

    expect(s.periodKey).toBe("2026-Q1");
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]).toMatchObject({
      transactionId: "t-1",
      step: "top-level",
      fileIds: ["f-1"],
      inputVat: 2000,
      outputVat: 0,
    });
    expect(s.totalInputVat).toBe(2000);
  });

  it("keeps a transaction that booked nothing, with the reason it booked nothing", () => {
    const s = snap([{ id: "t-none", date: "2026-02-10", amount: -5000 }]);

    expect(s.entries[0]).toMatchObject({ step: null, reason: "no-file", inputVat: 0 });
  });
});

describe("a sweep that improved a file", () => {
  it("reads as source-changed: the rung moved, so the new figure follows from it", () => {
    // extractedRateGroups went from 0 files to 128 in the D6 run — this is that
    // transition on one file, with the same cents at the end of it.
    const after = snap([
      {
        ...PRE_SWEEP,
        files: [
          {
            id: "f-1",
            totalGross: 12000,
            rateGroups: [{ rate: 20, net: 10000, vat: 2000, gross: 12000 }],
          },
        ],
      },
    ]);
    const rec = reconcileDerivations(snap([PRE_SWEEP]), after);

    expect(rec.movements).toHaveLength(1);
    expect(rec.movements[0].kind).toBe("source-changed");
    expect(rec.movements[0].changed).toEqual(["step"]);
    expect(rec.movements[0].fileIds).toEqual(["f-1"]);
    expect(rec.movements[0].inputVatDelta).toBe(0);
    expect(figureOnlyMovements(rec)).toHaveLength(0);
  });
});

describe("a sweep that came back weaker", () => {
  it("reads as figure-changed: same rung, same document, different cents", () => {
    // The #137 class: 29 records where the re-extraction produced a worse
    // reading off the same rung. Nothing about the change argues it is better,
    // which is precisely why it must not share a bucket with an improvement.
    const before = snap([
      {
        ...PRE_SWEEP,
        files: [
          {
            id: "f-1",
            totalGross: 12000,
            rateGroups: [{ rate: 20, net: 10000, vat: 2000, gross: 12000 }],
          },
        ],
      },
    ]);
    const after = snap([
      {
        ...PRE_SWEEP,
        files: [
          {
            id: "f-1",
            totalGross: 12000,
            rateGroups: [{ rate: 20, net: 10500, vat: 1500, gross: 12000 }],
          },
        ],
      },
    ]);
    const rec = reconcileDerivations(before, after);

    expect(rec.movements[0].kind).toBe("figure-changed");
    expect(rec.movements[0].changed).toEqual(["inputVat"]);
    expect(rec.movements[0].inputVatDelta).toBe(-500);
    expect(figureOnlyMovements(rec)).toHaveLength(1);
  });
});

describe("the movements own the whole delta", () => {
  it("accounts for appearances and disappearances, not just changes", () => {
    const before = snap([PRE_SWEEP]);
    const after = snap([
      { ...PRE_SWEEP, files: [] },
      {
        id: "t-2",
        date: "2026-03-01",
        amount: -6000,
        files: [{ id: "f-2", totalGross: 6000, vatPercent: 20, vatAmount: 1000 }],
      },
    ]);
    const rec = reconcileDerivations(before, after);

    expect(rec.accountedFor).toBe(true);
    expect(rec.totals.inputVatDelta).toBe(-1000);
    expect(
      rec.movements.reduce((s, m) => s + m.inputVatDelta, 0)
    ).toBe(rec.totals.inputVatDelta);

    const byId = Object.fromEntries(rec.movements.map((m) => [m.transactionId, m]));
    expect(byId["t-1"].kind).toBe("source-changed");
    // The file was disconnected — the union names it, so the movement is
    // explained per file rather than as "2000 cents went missing".
    expect(byId["t-1"].changed).toEqual(["step", "reason", "files", "inputVat"]);
    expect(byId["t-1"].fileIds).toEqual(["f-1"]);
    expect(byId["t-2"].kind).toBe("appeared");
    expect(byId["t-2"].inputVatDelta).toBe(1000);
  });

  it("reports an unchanged transaction rather than dropping it", () => {
    const rec = reconcileDerivations(snap([PRE_SWEEP]), snap([PRE_SWEEP]));

    expect(rec.movements).toHaveLength(1);
    expect(rec.movements[0].kind).toBe("unchanged");
    expect(movedEntries(rec)).toHaveLength(0);
  });

  it("refuses to call two different periods a comparison", () => {
    const rec = reconcileDerivations(
      snap([PRE_SWEEP]),
      snap([{ ...PRE_SWEEP, date: "2026-05-10" }], Q2_2026)
    );

    expect(rec.comparable).toBe(false);
  });
});
