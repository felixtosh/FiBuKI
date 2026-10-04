/**
 * The File facts module at its interface, for a Hand Correction (#638).
 *
 * Every case gives the module a File and a Fact Change and reads the outcome:
 * the complete File update, the follow-ups, or the refusal. No database: the
 * module reads nothing and writes nothing. These absorb the tests of the
 * correction builder (fork #147), of the moved-field comparison (#149), the
 * provenance stamp (#184), the tip bound (#310) and the RKSV review on a
 * correction (#166), and add what #638 changes: the Due Date and Debit Date,
 * their record in the Hand Correction, and the re-score follow-up.
 *
 *   npx vitest run src/fileFacts/__tests__/hand-correction.test.ts --pool=forks --maxWorkers=1
 */

import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import {
  decideFactChange,
  reExtractionRefusal,
  type FactChange,
  type FactOutcome,
  type FollowUp,
} from "../factChange";

const AT = Timestamp.fromDate(new Date("2026-09-01T10:00:00Z"));

/** A stored date: UTC midnight of the calendar day, as every writer stores it. */
const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));
const isoOf = (value: unknown) =>
  value instanceof Timestamp ? value.toDate().toISOString().slice(0, 10) : value;

function decide(
  record: Record<string, unknown>,
  change: Omit<FactChange, "at">,
  linkedTransactions: Array<{ id: string; amount: number }> = []
): FactOutcome {
  return decideFactChange({ record, linkedTransactions }, { ...change, at: AT } as FactChange);
}

function accepted(outcome: FactOutcome) {
  if (outcome.refused) throw new Error(`refused: ${outcome.message}`);
  return outcome;
}

/** The update an MCP Hand Correction makes: the caller names the fields it means. */
function mcp(correction: Record<string, unknown>, record: Record<string, unknown> = {}) {
  return accepted(decide(record, { origin: "mcp-correction", correction })).update;
}

function mcpRefusal(correction: Record<string, unknown>, record: Record<string, unknown> = {}) {
  const outcome = decide(record, { origin: "mcp-correction", correction });
  if (!outcome.refused) throw new Error("expected a refusal");
  return outcome;
}

const kinds = (followUps: FollowUp[]) => followUps.map((f) => f.kind);

describe("a Hand Correction's values", () => {
  it("touches only the fields that were passed", () => {
    const outcome = accepted(decide({}, { origin: "mcp-correction", correction: { vatPercent: 20 } }));

    expect(outcome.changed).toEqual(["vatPercent"]);
    expect(outcome.update.extractedVatPercent).toBe(20);
    expect("extractedAmount" in outcome.update).toBe(false);
    expect("extractedLineItems" in outcome.update).toBe(false);
  });

  it("treats zero as a correction, not as unset", () => {
    const update = mcp({ vatPercent: 0, vatAmount: 0 });

    expect(update.extractedVatPercent).toBe(0);
    expect(update.extractedVatAmount).toBe(0);
  });

  it("clears a field on an explicit null", () => {
    expect(mcp({ vatAmount: null }).extractedVatAmount).toBeNull();
  });

  it("does not re-derive the corrected total from the line items", () => {
    // A Schlussrechnung due 3180.00 whose items describe the full 6360.00 scope.
    const update = mcp({
      amount: 318000,
      vatAmount: 53000,
      lineItems: [{ description: "Grafikdesign", vatPercent: 20, vatAmount: 54000, amount: 324000 }],
    });

    expect(update.extractedAmount).toBe(318000);
    expect(update.extractedVatAmount).toBe(53000);
    // #203: the disagreement is surfaced, so VAT derivation refuses the items.
    expect(update.lineItemsUnreconciled).toBe(true);
  });

  it("makes the person the authority on any VAT-bearing correction", () => {
    const update = mcp({ amount: 318000 });

    expect(update.lineItemsUnreconciled).toBe(false);
    expect(update.lineItemsUnreconciledRates).toBeNull();
    expect(update.extractedRateGroups).toBeNull();
    expect(update.vatSourceDowngraded).toBe(false);
    expect(update.vatFieldsPreserved).toBe(false);
  });

  describe("re-deriving the reconciliation flag (#203)", () => {
    // Three captured goods rows, gross 90.00, on a document printing 81.00.
    const capturedRows = [
      { description: "goods A", vatPercent: 20, vatAmount: 500, amount: 3000 },
      { description: "goods B", vatPercent: 20, vatAmount: 750, amount: 4500 },
      { description: "goods C", vatPercent: 20, vatAmount: 250, amount: 1500 },
    ];

    it("keeps the File flagged when the corrected items still contradict the total", () => {
      const update = mcp({ lineItems: capturedRows }, { extractedAmount: 8100 });

      expect(update.lineItemsUnreconciled).toBe(true);
      expect(update.extractedRateGroups).toBeNull();
    });

    it("un-flags a File once the person completes the itemisation", () => {
      const update = mcp(
        {
          lineItems: [
            ...capturedRows,
            { description: "postage", vatPercent: 20, vatAmount: 0, amount: 0 },
            { description: "discount 10%", vatPercent: 20, vatAmount: -150, amount: -900 },
          ],
        },
        { extractedAmount: 8100, lineItemsUnreconciled: true }
      );

      expect(update.lineItemsUnreconciled).toBe(false);
      expect(update.lineItemsUnreconciledRates).toBeNull();
    });

    it("judges an amount correction against the items already stored", () => {
      const stored = { extractedLineItems: capturedRows };

      expect(mcp({ amount: 9000 }, stored).lineItemsUnreconciled).toBe(false);
      expect(mcp({ amount: 8100 }, stored).lineItemsUnreconciled).toBe(true);
    });

    it("clears the flag with the itemisation: nothing is left to contradict", () => {
      const update = mcp(
        { lineItems: null },
        { extractedAmount: 8100, extractedLineItems: capturedRows, lineItemsUnreconciled: true }
      );

      expect(update.extractedLineItems).toBeNull();
      expect(update.lineItemsUnreconciled).toBe(false);
    });

    it("re-checks an untouched itemisation a form save re-posted, against its printed block", () => {
      // The panel posts the items on every save; one that moved nothing still
      // re-derives the flag from the stored record, printed block and all.
      const record = {
        extractedAmount: 9000,
        extractedLineItems: capturedRows,
        lineItemsUnreconciled: true,
      };
      const outcome = accepted(
        decide(record, { origin: "ui-correction", correction: { lineItems: capturedRows } })
      );

      expect(outcome.changed).toEqual([]);
      expect(outcome.update.lineItemsUnreconciled).toBe(false);
    });
  });

  it("leaves the VAT artefacts alone on a date-only correction", () => {
    const update = mcp({ date: "2026-05-30" });

    expect("extractedRateGroups" in update).toBe(false);
    expect("lineItemsUnreconciled" in update).toBe(false);
    expect((update.extractedDate as Timestamp).toDate().toISOString()).toBe("2026-05-30T00:00:00.000Z");
  });

  it("keeps a negative total: a credit note is legal", () => {
    expect(mcp({ amount: -579 }).extractedAmount).toBe(-579);
  });

  it("normalises line items and defaults a missing VAT to zero", () => {
    const update = mcp({
      lineItems: [{ amount: 1000.4 }, { description: "  spaced  ", amount: 500, vatPercent: 200 }],
    });

    expect(update.extractedLineItems).toEqual([
      { description: "Item 1", vatPercent: null, vatAmount: 0, amount: 1000 },
      { description: "spaced", vatPercent: null, vatAmount: 0, amount: 500 },
    ]);
  });

  it("refuses a correction that corrects nothing", () => {
    expect(mcpRefusal({}).code).toBe("INVALID");
  });

  it("refuses a rate outside 0-100, a date that is not a real day, and a non-numeric amount", () => {
    expect(mcpRefusal({ vatPercent: 120 }).message).toMatch(/between 0 and 100/);
    expect(mcpRefusal({ date: "2026-02-30" }).message).toMatch(/real calendar date/);
    expect(mcpRefusal({ date: "30.05.2026" }).message).toMatch(/YYYY-MM-DD/);
    expect(mcpRefusal({ amount: "3180" }).message).toMatch(/finite number of cents/);
  });

  it("refuses a value it cannot read rather than writing anything", () => {
    const outcome = mcpRefusal({ amount: 9000, vatPercent: 120 });

    expect(outcome).not.toHaveProperty("update");
  });
});

describe("a hand-set Trinkgeld (#217, #310)", () => {
  it("stores the tip beside the total without touching it", () => {
    const outcome = accepted(
      decide(
        { extractedAmount: 5080, extractedVatAmount: 555 },
        { origin: "mcp-correction", correction: { tipAmount: 320 } }
      )
    );

    expect(outcome.changed).toEqual(["tipAmount"]);
    expect(outcome.update.extractedTipAmount).toBe(320);
    expect("extractedAmount" in outcome.update).toBe(false);
    expect("extractedVatAmount" in outcome.update).toBe(false);
  });

  it("leaves the printed rate groups standing: a tip is outside VAT", () => {
    const update = mcp({ tipAmount: 320 }, { extractedAmount: 5080 });

    expect("extractedRateGroups" in update).toBe(false);
    expect("lineItemsUnreconciled" in update).toBe(false);
    expect("vatSourceDowngraded" in update).toBe(false);
  });

  it("reads zero and null as the same answer: no tip", () => {
    expect(mcp({ tipAmount: null }).extractedTipAmount).toBeNull();
    expect(mcp({ tipAmount: 0 }).extractedTipAmount).toBeNull();
  });

  it("refuses a negative tip and one that is not a number", () => {
    expect(mcpRefusal({ tipAmount: -320 }).message).toMatch(/must not be negative/);
    expect(mcpRefusal({ tipAmount: "3,20" }).message).toMatch(/finite number of cents/);
  });

  it("measures the tip against the document total this correction leaves", () => {
    expect(mcp({ tipAmount: 320 }, { extractedAmount: 5080 }).extractedTipBound).toEqual({
      bound: "document",
      total: 5080,
    });
    expect(mcpRefusal({ tipAmount: 6000 }, { extractedAmount: 5080 }).message).toMatch(
      /must be less than the document total/
    );
    expect(mcpRefusal({ tipAmount: 320, amount: 300 }, { extractedAmount: 5080 }).code).toBe("INVALID");
  });

  it("records a tip declared as not printed, bounded by nothing on the document", () => {
    const outcome = accepted(
      decide(
        { extractedAmount: 5080 },
        { origin: "mcp-correction", correction: { tipAmount: 6000 }, tipNotPrinted: true }
      )
    );

    expect(outcome.update.extractedTipBound).toEqual({ bound: "not-printed" });
  });

  it("refuses a declaration that is not a boolean", () => {
    const outcome = decide({}, {
      origin: "mcp-correction",
      correction: { tipAmount: 320 },
      tipNotPrinted: "yes" as never,
    });

    expect(outcome.refused).toBe(true);
  });
});

describe("the Hand Correction record (#184)", () => {
  it("stamps the corrected fields, merging with earlier corrections", () => {
    const earlier = day("2026-01-01");
    const update = mcp(
      { amount: 318000, vatAmount: 53000 },
      { extractionCorrectedFields: { date: earlier } }
    );

    expect(update.extractionCorrectedFields).toEqual({ date: earlier, amount: AT, vatAmount: AT });
    expect(update.extractionCorrectedAt).toBe(AT);
  });

  it("stamps a date-only correction too, VAT-bearing or not", () => {
    expect(Object.keys(mcp({ date: "2026-05-30" }).extractionCorrectedFields as object)).toEqual([
      "date",
    ]);
  });

  it("stamps a hand-set tip, so re-extraction refuses the File", () => {
    expect(Object.keys(mcp({ tipAmount: 320 }, { extractedAmount: 5080 }).extractionCorrectedFields as object))
      .toEqual(["tipAmount"]);
  });

  it("never records the descriptive fields", () => {
    const outcome = accepted(
      decide({}, { origin: "mcp-correction", details: { partner: "ACME GmbH", vatId: "ATU12345678" } })
    );

    expect(outcome.update.extractedPartner).toBe("ACME GmbH");
    expect(outcome.update.extractedVatId).toBe("ATU12345678");
    expect("extractionCorrectedFields" in outcome.update).toBe(false);
    expect(outcome.changed).toEqual([]);
  });
});

describe("what a form save moved (#149)", () => {
  const ITEM = { description: "Consulting", vatPercent: 20, vatAmount: 20000, amount: 100000 };
  const stored = {
    extractedAmount: 318000,
    extractedVatAmount: 53000,
    extractedVatPercent: 20,
    extractedDate: day("2026-03-04"),
    extractedLineItems: [ITEM],
  };
  const untouched = {
    amount: 318000,
    vatAmount: 53000,
    vatPercent: 20,
    date: "2026-03-04",
    lineItems: [ITEM],
  };

  const saved = (correction: Record<string, unknown>, record: Record<string, unknown> = stored) =>
    decide(record, { origin: "ui-correction", correction });
  const moved = (correction: Record<string, unknown>, record: Record<string, unknown> = stored) =>
    accepted(saved(correction, record)).changed;

  it("treats a save that typed nothing as no correction at all", () => {
    const outcome = accepted(saved(untouched));

    expect(outcome.changed).toEqual([]);
    expect("extractionCorrectedFields" in outcome.update).toBe(false);
    expect(outcome.followUps).toEqual([]);
  });

  it("stamps the field that moved and none of the ones that rode along", () => {
    const outcome = accepted(saved({ ...untouched, amount: 636000 }));

    expect(outcome.changed).toEqual(["amount"]);
    expect(Object.keys(outcome.update.extractionCorrectedFields as object)).toEqual(["amount"]);
  });

  it("compares a date by the day it names", () => {
    expect(moved({ date: "2026-03-04" })).toEqual([]);
    expect(moved({ date: "2026-03-05" })).toEqual(["date"]);
  });

  it("accepts a stored date written at local midnight, not only at UTC midnight", () => {
    const hostZone = process.env.TZ;
    process.env.TZ = "Europe/Vienna";
    try {
      const viennaMidnight = Timestamp.fromDate(new Date("2026-03-03T23:00:00Z"));
      expect(moved({ date: "2026-03-04" }, { extractedDate: viennaMidnight })).toEqual([]);
      expect(moved({ date: "2026-03-05" }, { extractedDate: viennaMidnight })).toEqual(["date"]);
    } finally {
      process.env.TZ = hostZone;
    }
  });

  it("compares line items by value, including a one-cent move", () => {
    expect(moved({ lineItems: [{ ...ITEM }] })).toEqual([]);
    expect(moved({ lineItems: [{ ...ITEM, amount: 100001 }] })).toEqual(["lineItems"]);
  });

  it("does not compare a stored row's quantity and unit price (#252)", () => {
    const record = { extractedLineItems: [{ ...ITEM, quantity: 2, unitPrice: 50000 }] };
    expect(moved({ lineItems: [{ ...ITEM, quantity: 1, unitPrice: 100000 }] }, record)).toEqual([]);
  });

  it("treats a re-ordered itemisation as a correction", () => {
    const second = { ...ITEM, description: "Travel", amount: 5000, vatAmount: 1000 };
    expect(moved({ lineItems: [second, ITEM] }, { extractedLineItems: [ITEM, second] })).toEqual([
      "lineItems",
    ]);
  });

  it("does not read the absence of a stored value as a change to null", () => {
    expect(moved({ vatPercent: null, lineItems: null }, {})).toEqual([]);
  });

  it("keeps a clear-out that really removes a stored value", () => {
    expect(moved({ vatAmount: null })).toEqual(["vatAmount"]);
    expect(moved({ lineItems: null })).toEqual(["lineItems"]);
  });

  it("refuses a value it cannot compare instead of reading it as unchanged", () => {
    expect(saved({ date: "04.03.2026" }).refused).toBe(true);
    expect(saved({ amount: "318,00" }).refused).toBe(true);
  });

  it("reads an absent direction and an explicit unknown as the same answer", () => {
    expect(moved({ invoiceDirection: null }, {})).toEqual([]);
    expect(moved({ invoiceDirection: "unknown" }, {})).toEqual([]);
    expect(moved({ invoiceDirection: null }, { invoiceDirection: "unknown" })).toEqual([]);
    expect(moved({ invoiceDirection: "incoming" }, { invoiceDirection: "incoming" })).toEqual([]);
    expect(moved({ invoiceDirection: "incoming" }, { invoiceDirection: "unknown" })).toEqual([
      "invoiceDirection",
    ]);
  });

  it("reads an empty tip box and a zero as the same answer: no tip (#217)", () => {
    const tipped = { extractedAmount: 5080, extractedTipAmount: 320 };
    expect(moved({ tipAmount: null }, {})).toEqual([]);
    expect(moved({ tipAmount: 0 }, { extractedTipAmount: null })).toEqual([]);
    expect(moved({ tipAmount: 320 }, tipped)).toEqual([]);
    expect(moved({ tipAmount: 320 }, { extractedAmount: 5080 })).toEqual(["tipAmount"]);
    expect(moved({ tipAmount: null }, tipped)).toEqual(["tipAmount"]);
  });

  it("drops a key outside the correction vocabulary", () => {
    const outcome = accepted(saved({ extractedAmount: 1, documentType: "invoice" }));

    expect("extractedAmount" in outcome.update).toBe(false);
    expect(outcome.changed).toEqual([]);
  });
});

describe("the fields derived from the corrected File", () => {
  it("clears the Rate Groups, their source and the RKSV flag on a VAT-bearing correction (#166)", () => {
    const record = {
      extractionComplete: true,
      extractedAmount: 2260,
      extractedQrCodes: [
        { format: "rksv", payload: "_R1-AT1_K1_42_2026-05-02T10:00:00_0,00_11,60_11,00_0,00_0,00_x_y_z_sig" },
      ],
      extractedRateGroups: [
        { rate: 10, net: 1000, vat: 100, gross: 1100 },
        { rate: 13, net: 1027, vat: 133, gross: 1160 },
      ],
      extractedRateGroupsSource: "document",
      needsRksvCodeReview: true,
      rksvCodeDisagreeingRates: [10, 13],
      invoiceDirection: "incoming",
    };

    const vat = mcp({ vatAmount: 227 }, record);
    expect(vat.extractedRateGroups).toBeNull();
    expect(vat.extractedRateGroupsSource).toBeNull();
    expect(vat.needsRksvCodeReview).toBe(false);
    expect(vat.rksvCodeDisagreeingRates).toEqual([]);

    const dateOnly = mcp({ date: "2026-05-03" }, record);
    expect("extractedRateGroupsSource" in dateOnly).toBe(false);
    expect(dateOnly.needsRksvCodeReview).toBe(true);
    expect(dateOnly.rksvCodeDisagreeingRates).toEqual([10, 13]);
  });

  it("re-classifies the Document Type and syncs the connected Transactions when it moved", () => {
    const record = { extractionComplete: true, documentType: "stale", transactionIds: ["t-1", "t-2"] };
    const outcome = accepted(decide(record, { origin: "mcp-correction", correction: { amount: 5000 } }));

    expect(outcome.update.documentType).not.toBe("stale");
    expect(outcome.followUps).toContainEqual({
      kind: "sync-documentation-state",
      transactionIds: ["t-1", "t-2"],
    });
  });

  it("syncs nothing when no Transaction is connected", () => {
    const record = { extractionComplete: true, documentType: "stale", transactionIds: [] };
    const outcome = accepted(decide(record, { origin: "mcp-correction", correction: { amount: 5000 } }));

    expect(kinds(outcome.followUps)).not.toContain("sync-documentation-state");
  });

  it("reviews the direction against the connected Transactions it is handed (#233)", () => {
    const record = { extractionComplete: true, invoiceDirection: "outgoing", transactionIds: ["t-1"] };
    const money = [{ id: "t-1", amount: -5000 }];

    const fixed = accepted(
      decide(record, { origin: "mcp-correction", correction: { invoiceDirection: "incoming" } }, money)
    );
    expect(fixed.update.needsDirectionReview).toBe(false);

    const wrong = accepted(
      decide(record, { origin: "mcp-correction", correction: { amount: 5000 } }, money)
    );
    expect(wrong.update.needsDirectionReview).toBe(true);
    expect(wrong.update.directionConflictTransactionIds).toEqual(["t-1"]);
  });

  it("retires a repair flag per corrected field, figure or detail (#301)", () => {
    const record = {
      extractedAmount: 1000,
      extractedPartner: "AMCE",
      repairAmbiguousFields: ["amount", "partner", "vatId"],
      needsRepairReview: true,
    };
    const outcome = accepted(
      decide(record, {
        origin: "ui-correction",
        correction: { amount: 1200 },
        details: { partner: "ACME GmbH" },
      })
    );

    expect(outcome.update.repairAmbiguousFields).toEqual(["vatId"]);
    expect(outcome.update.needsRepairReview).toBe(true);
  });
});

describe("the Due Date and Debit Date (#638)", () => {
  const rows = [
    { key: "dueDate", label: "Fällig am", value: "2026-03-10" },
    { key: "debitDate", label: "Einzug am", value: "2026-03-12" },
  ];
  const record = {
    extractedDate: day("2026-03-01"),
    extractedAdditionalFields: rows,
    extractedDueDate: day("2026-03-10"),
    extractedDebitDate: day("2026-03-12"),
  };

  it("re-derives both when only the issue date is corrected", () => {
    const later = mcp({ date: "2026-03-11" }, record);
    // The Due Date row is now earlier than the issue date: it no longer
    // qualifies, so the stored Due Date clears instead of inverting the window.
    expect(later.extractedDueDate).toBeNull();
    expect(isoOf(later.extractedDebitDate)).toBe("2026-03-12");

    const earlier = mcp({ date: "2026-02-20" }, record);
    expect(isoOf(earlier.extractedDueDate)).toBe("2026-03-10");
    expect(isoOf(earlier.extractedDebitDate)).toBe("2026-03-12");
  });

  it("stores the dates as UTC midnight of the stated day", () => {
    const update = mcp({ date: "2026-02-20" }, record);

    expect((update.extractedDueDate as Timestamp).toDate().toISOString()).toBe("2026-03-10T00:00:00.000Z");
  });

  it("gives an older File without stored dates the derived ones on its first correction", () => {
    const legacy = { extractedDate: day("2026-03-01"), extractedAdditionalFields: rows };

    expect(isoOf(mcp({ date: "2026-03-02" }, legacy).extractedDueDate)).toBe("2026-03-10");
  });

  it("reads the issue day from the UTC date part, whatever the host's zone", () => {
    // Stored dates are UTC midnight. West of Greenwich the host's local day of
    // that instant is the day before, which would let a Due Date one day
    // earlier than the issue date through.
    const hostZone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const stored = {
        extractedDate: day("2026-03-10"),
        extractedAdditionalFields: [{ key: "dueDate", label: "Fällig am", value: "2026-03-09" }],
      };
      const update = mcp({ amount: 1000, date: "2026-03-10" }, stored);
      expect(update.extractedDueDate).toBeNull();
    } finally {
      process.env.TZ = hostZone;
    }
  });

  it("leaves both alone on a correction that moves neither the date nor the rows", () => {
    const update = mcp({ vatPercent: 20 }, record);

    expect("extractedDueDate" in update).toBe(false);
    expect("extractedDebitDate" in update).toBe(false);
  });

  it("records a hand-set Due Date, which a later re-extraction then refuses on", () => {
    const outcome = accepted(
      decide(record, {
        origin: "mcp-correction",
        details: {
          additionalFields: [
            { key: "dueDate", label: "Fällig am", value: "2026-03-31" },
            rows[1],
          ],
        },
      })
    );

    expect(isoOf(outcome.update.extractedDueDate)).toBe("2026-03-31");
    expect(outcome.changed).toEqual(["dueDate"]);
    expect(outcome.update.extractionCorrectedFields).toEqual({ dueDate: AT });

    const after = { ...record, ...outcome.update };
    const refusal = reExtractionRefusal(after, {});
    expect(refusal?.code).toBe("HAND_CORRECTED");
    expect(refusal?.fields).toEqual(["dueDate"]);
    // The hand-set date survives the refused re-extraction: a refusal writes nothing.
    expect(isoOf(after.extractedDueDate)).toBe("2026-03-31");
    // A forced re-extraction is still possible, deliberately.
    expect(reExtractionRefusal(after, { overwriteCorrections: true })).toBeNull();
  });

  it("records a hand-set Debit Date the same way", () => {
    const outcome = accepted(
      decide(record, {
        origin: "ui-correction",
        details: { additionalFields: [rows[0], { key: "debitDate", label: "Einzug am", value: "2026-03-15" }] },
      })
    );

    expect(isoOf(outcome.update.extractedDebitDate)).toBe("2026-03-15");
    expect(outcome.changed).toEqual(["debitDate"]);
  });

  it("does not record a Due Date that only the issue-date guard moved", () => {
    const outcome = accepted(decide(record, { origin: "mcp-correction", correction: { date: "2026-03-11" } }));

    expect(outcome.changed).toEqual(["date"]);
    expect(Object.keys(outcome.update.extractionCorrectedFields as object)).toEqual(["date"]);
  });

  it("does not record the dates when a save re-posts the rows unchanged", () => {
    const outcome = accepted(
      decide(record, { origin: "ui-correction", details: { additionalFields: rows } })
    );

    expect(outcome.changed).toEqual([]);
    expect(outcome.movedDetails).toEqual([]);
    expect("extractionCorrectedFields" in outcome.update).toBe(false);
    // Nothing moved, so nothing derived is rewritten and nothing follows.
    expect("documentType" in outcome.update).toBe(false);
    expect(outcome.followUps).toEqual([]);
  });

  it("refuses a row under a key outside the vocabulary (#540)", () => {
    const outcome = decide(record, {
      origin: "mcp-correction",
      details: { additionalFields: [{ key: "favouriteColour", label: "Colour", value: "red" }] },
    });

    expect(outcome.refused).toBe(true);
  });
});

describe("re-scoring the suggestions (#637 user stories 12 and 13)", () => {
  const record = {
    extractionComplete: true,
    extractedAmount: 5000,
    extractedDate: day("2026-03-01"),
    extractedPartner: "ACME GmbH",
    extractedIban: "AT611904300234573201",
    extractedVatId: "ATU12345678",
    extractedAdditionalFields: [{ key: "debitDate", label: "Einzug am", value: "2026-03-12" }],
    extractedDebitDate: day("2026-03-12"),
    transactionIds: ["t-1"],
    documentType: "receipt",
  };

  const followUpsOf = (change: Omit<FactChange, "at">) => accepted(decide(record, change)).followUps;

  it("re-scores after a moved amount and connects nothing", () => {
    const outcome = accepted(decide(record, { origin: "mcp-correction", correction: { amount: 5100 } }));

    expect(outcome.followUps).toContainEqual({ kind: "rescore-suggestions" });
    // Suggestions only: nothing in the update touches a File Connection, and
    // no follow-up connects or disconnects.
    expect("transactionIds" in outcome.update).toBe(false);
    expect("transactionSuggestions" in outcome.update).toBe(false);
    expect(kinds(outcome.followUps).every((k) => k === "rescore-suggestions" || k === "sync-documentation-state"))
      .toBe(true);
  });

  it("re-scores after a moved date, partner, Due Date or Debit Date", () => {
    expect(kinds(followUpsOf({ origin: "mcp-correction", correction: { date: "2026-03-02" } }))).toContain(
      "rescore-suggestions"
    );
    expect(kinds(followUpsOf({ origin: "ui-correction", details: { partner: "ACME Holding GmbH" } }))).toContain(
      "rescore-suggestions"
    );
    expect(
      kinds(
        followUpsOf({
          origin: "ui-correction",
          details: { additionalFields: [{ key: "debitDate", label: "Einzug am", value: "2026-03-13" }] },
        })
      )
    ).toContain("rescore-suggestions");
    expect(
      kinds(
        followUpsOf({
          origin: "mcp-correction",
          details: {
            additionalFields: [
              { key: "dueDate", label: "Fällig am", value: "2026-03-20" },
              { key: "debitDate", label: "Einzug am", value: "2026-03-12" },
            ],
          },
        })
      )
    ).toContain("rescore-suggestions");
  });

  it("re-scores after a moved IBAN or VAT ID, through either door", () => {
    for (const origin of ["ui-correction", "mcp-correction"] as const) {
      expect(kinds(followUpsOf({ origin, details: { iban: "AT021100000012345678" } }))).toContain(
        "rescore-suggestions"
      );
      expect(kinds(followUpsOf({ origin, details: { vatId: "ATU87654321" } }))).toContain("rescore-suggestions");
    }
    // A save that re-posts them unchanged moved nothing.
    expect(
      kinds(followUpsOf({ origin: "ui-correction", details: { iban: "AT611904300234573201", vatId: "ATU12345678" } }))
    ).not.toContain("rescore-suggestions");
  });

  it("does not re-score after a correction the scorer does not read", () => {
    expect(kinds(followUpsOf({ origin: "mcp-correction", correction: { vatPercent: 10 } }))).not.toContain(
      "rescore-suggestions"
    );
    expect(kinds(followUpsOf({ origin: "ui-correction", details: { address: "Hauptplatz 1" } }))).not.toContain(
      "rescore-suggestions"
    );
    expect(kinds(followUpsOf({ origin: "ui-correction", details: { partner: "ACME GmbH" } }))).not.toContain(
      "rescore-suggestions"
    );
  });
});

describe("the UI and MCP doors (#637 user story 20)", () => {
  it("produce the same File for the same correction", () => {
    const record = {
      extractionComplete: true,
      extractedAmount: 5000,
      extractedVatAmount: 833,
      extractedVatPercent: 20,
      extractedDate: day("2026-03-01"),
      extractedPartner: "AMCE",
      extractedAdditionalFields: [{ key: "dueDate", label: "Fällig am", value: "2026-03-10" }],
      extractedDueDate: day("2026-03-10"),
      invoiceDirection: "incoming",
      transactionIds: ["t-1"],
      documentType: "receipt",
      extractionCorrectedFields: { vatPercent: day("2026-01-01") },
    };
    const change = {
      correction: { amount: 5200, date: "2026-03-02", tipAmount: 100 },
      details: {
        partner: " ACME GmbH ",
        vatId: "ATU12345678",
        additionalFields: [{ key: "dueDate", label: "Fällig am", value: "2026-03-20" }],
      },
    };
    const money = [{ id: "t-1", amount: -5300 }];

    const ui = accepted(decide(record, { origin: "ui-correction", ...change }, money));
    const viaMcp = accepted(decide(record, { origin: "mcp-correction", ...change }, money));

    expect(viaMcp.update).toEqual(ui.update);
    expect(viaMcp.followUps).toEqual(ui.followUps);
    expect(viaMcp.changed).toEqual(ui.changed);
    expect(ui.changed).toEqual(["amount", "tipAmount", "date", "dueDate"]);
  });
});

describe("the re-extraction check", () => {
  it("lets a File without a Hand Correction be re-extracted", () => {
    expect(reExtractionRefusal({}, {})).toBeNull();
  });

  it("refuses a normal re-extraction of a hand-corrected File, naming the fields", () => {
    const refusal = reExtractionRefusal(
      { extractionCorrectedFields: { vatPercent: AT, amount: AT } },
      {}
    );

    expect(refusal).toMatchObject({ refused: true, code: "HAND_CORRECTED", fields: ["amount", "vatPercent"] });
    expect(refusal?.message).toMatch(/amount, vatPercent/);
  });

  it("lets a forced one overwrite", () => {
    expect(
      reExtractionRefusal({ extractionCorrectedFields: { amount: AT } }, { overwriteCorrections: true })
    ).toBeNull();
  });
});
