/**
 * #149: which fields a *form* save actually moved.
 *
 * The MCP tool sends the fields a caller deliberately named, so "present"
 * means "corrected" there. The file detail panel sends the whole extracted
 * record on every save, so "present" means nothing at all — stamping it would
 * mark a file hand-corrected on all five fields the first time someone opens
 * the panel and clicks save without typing.
 *
 * The comparison therefore lives on the server, next to the builder that
 * stamps, and this is its test: what is proposed is compared against what is
 * stored, and only the difference is treated as a correction.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin/firestore", () => ({
  Timestamp: {
    fromDate: (d: Date) => ({ toDate: () => d }),
    now: () => ({ toDate: () => new Date("2026-08-26T00:00:00Z") }),
  },
}));

const { selectMovedCorrections } = await import("../extractionCorrectionOps");

const storedDate = (iso: string) => ({ toDate: () => new Date(`${iso}T00:00:00Z`) });

const ITEM = {
  description: "Consulting",
  quantity: 2,
  unitPrice: 50000,
  vatPercent: 20,
  vatAmount: 20000,
  amount: 100000,
};

/** The panel's payload for a file it has not changed. */
const unchangedForm = {
  amount: 318000,
  vatAmount: 53000,
  vatPercent: 20,
  date: "2026-03-04",
  lineItems: [ITEM],
};

const storedRecord = {
  extractedAmount: 318000,
  extractedVatAmount: 53000,
  extractedVatPercent: 20,
  extractedDate: storedDate("2026-03-04"),
  extractedLineItems: [ITEM],
};

describe("selectMovedCorrections", () => {
  it("treats a save that typed nothing as no correction at all", () => {
    expect(selectMovedCorrections(unchangedForm, storedRecord)).toEqual({});
  });

  it("keeps the field that moved and drops the ones that rode along", () => {
    const moved = selectMovedCorrections({ ...unchangedForm, amount: 636000 }, storedRecord);

    expect(moved).toEqual({ amount: 636000 });
  });

  it("compares a date by the day it names, not by the object carrying it", () => {
    expect(selectMovedCorrections({ date: "2026-03-04" }, storedRecord)).toEqual({});
    expect(selectMovedCorrections({ date: "2026-03-05" }, storedRecord)).toEqual({
      date: "2026-03-05",
    });
  });

  it("accepts a stored date written at local midnight, not only at UTC midnight", () => {
    // extractionCore builds the stored Timestamp with `new Date(y, m - 1, d)`,
    // which is midnight LOCAL. Cloud Functions run in UTC so the two agree
    // there, but the self-host container runs in Europe/Vienna, where that
    // instant is 23:00 UTC the day before. Reading it back in UTC only would
    // call the date moved on every save of an untouched file — stamping a
    // correction nobody made, which is the failure this whole change exists to
    // prevent.
    // Node re-reads TZ when it is assigned, so this pins the host zone for the
    // assertion instead of inheriting whatever the runner happens to use.
    const hostZone = process.env.TZ;
    process.env.TZ = "Europe/Vienna";
    try {
      const viennaMidnight = { toDate: () => new Date("2026-03-03T23:00:00Z") };

      expect(
        selectMovedCorrections({ date: "2026-03-04" }, { extractedDate: viennaMidnight })
      ).toEqual({});
      expect(
        selectMovedCorrections({ date: "2026-03-05" }, { extractedDate: viennaMidnight })
      ).toEqual({ date: "2026-03-05" });
    } finally {
      process.env.TZ = hostZone;
    }
  });

  it("compares line items by value, including a one-cent move", () => {
    expect(selectMovedCorrections({ lineItems: [{ ...ITEM }] }, storedRecord)).toEqual({});

    const repaired = [{ ...ITEM, amount: 100001 }];
    expect(selectMovedCorrections({ lineItems: repaired }, storedRecord)).toEqual({
      lineItems: repaired,
    });
  });

  it("treats a re-ordered itemisation as a correction", () => {
    const second = { ...ITEM, description: "Travel", amount: 5000, vatAmount: 1000 };
    const stored = { extractedLineItems: [ITEM, second] };

    expect(selectMovedCorrections({ lineItems: [second, ITEM] }, stored)).toEqual({
      lineItems: [second, ITEM],
    });
  });

  it("does not read the absence of a stored value as a change to null", () => {
    // A file the model never gave a VAT rate, saved from a form whose rate box
    // is empty. Nothing was ruled on, so nothing is stamped.
    expect(selectMovedCorrections({ vatPercent: null, lineItems: null }, {})).toEqual({});
  });

  it("keeps a clear-out that really removes a stored value", () => {
    expect(selectMovedCorrections({ vatAmount: null }, storedRecord)).toEqual({
      vatAmount: null,
    });
    expect(selectMovedCorrections({ lineItems: null }, storedRecord)).toEqual({
      lineItems: null,
    });
  });

  it("keeps a value it cannot compare so the builder still refuses it", () => {
    // Dropping an unparseable date as "unchanged" would turn a refusal into a
    // silent no-op, which is worse than the error.
    expect(selectMovedCorrections({ date: "04.03.2026" } as never, storedRecord)).toEqual({
      date: "04.03.2026",
    });
    expect(selectMovedCorrections({ amount: "318,00" } as never, storedRecord)).toEqual({
      amount: "318,00",
    });
  });

  it("reads an absent direction and an explicit unknown as the same answer", () => {
    // #233 stores `unknown` where a caller passed null, and records written
    // before it have no field at all. Re-sending either for a document nobody
    // has placed is not a ruling.
    expect(selectMovedCorrections({ invoiceDirection: null }, {})).toEqual({});
    expect(selectMovedCorrections({ invoiceDirection: "unknown" }, {})).toEqual({});
    expect(
      selectMovedCorrections({ invoiceDirection: null }, { invoiceDirection: "unknown" })
    ).toEqual({});
    expect(
      selectMovedCorrections({ invoiceDirection: "incoming" }, { invoiceDirection: "incoming" })
    ).toEqual({});
    expect(
      selectMovedCorrections({ invoiceDirection: "incoming" }, { invoiceDirection: "unknown" })
    ).toEqual({ invoiceDirection: "incoming" });
  });

  it("leaves a field the form did not send alone", () => {
    expect(selectMovedCorrections({ amount: 636000 }, storedRecord)).toEqual({ amount: 636000 });
  });
});
