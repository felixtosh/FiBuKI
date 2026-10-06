/**
 * The File facts module at its interface, for the one-time date backfill
 * (#641): every File stores its Due Date and Debit Date as the module derives
 * them, unless the User set one by hand.
 *
 * Each case gives the module a File and the `date-backfill` change and reads
 * the outcome. No database. The run itself (dry run, applied run, report) is
 * covered on the self-host shim (`selfhost/backfill-file-dates.test.ts`).
 *
 *   npx vitest run src/fileFacts/__tests__/date-backfill.test.ts --pool=forks --maxWorkers=1
 */

import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { decideFactChange, type FactOutcome, type FactUpdate } from "../factChange";

const AT = Timestamp.fromDate(new Date("2026-10-06T10:00:00Z"));
const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));
const isoOf = (value: unknown) => (value as Timestamp | null)?.toDate().toISOString().slice(0, 10) ?? null;

const ISSUE = "2026-03-02";
const DUE_ROW = { key: "dueDate", label: "Fällig am", value: "2026-03-16" };
const DEBIT_ROW = { key: "debitDate", label: "Einzug am", value: "2026-03-20" };

function backfill(record: Record<string, unknown>): FactOutcome {
  return decideFactChange({ record, linkedTransactions: [] }, { origin: "date-backfill", at: AT });
}

function decided(record: Record<string, unknown>): FactUpdate {
  const outcome = backfill(record);
  if (outcome.refused) throw new Error(`refused: ${outcome.message}`);
  return outcome;
}

describe("the date backfill (#641)", () => {
  it("stores the dates a record without the fields states in its rows", () => {
    const { update, followUps } = decided({
      extractedDate: day(ISSUE),
      extractedAdditionalFields: [DUE_ROW, DEBIT_ROW],
    });
    expect(isoOf(update.extractedDueDate)).toBe("2026-03-16");
    expect(isoOf(update.extractedDebitDate)).toBe("2026-03-20");
    expect(update.lastFactChange).toEqual({ origin: "date-backfill", at: AT });
    expect(update.updatedAt).toBe(AT);
    expect(followUps).toEqual([{ kind: "rescore-suggestions" }]);
  });

  it("writes only the dates that differ from what is stored", () => {
    const { update } = decided({
      extractedDate: day(ISSUE),
      extractedAdditionalFields: [DUE_ROW, DEBIT_ROW],
      extractedDueDate: day("2026-03-16"),
    });
    expect("extractedDueDate" in update).toBe(false);
    expect(isoOf(update.extractedDebitDate)).toBe("2026-03-20");
  });

  it("writes nothing on a File that already stores what it derives, so a second run is a no-op", () => {
    const record = {
      extractedDate: day(ISSUE),
      extractedAdditionalFields: [DUE_ROW],
      extractedDueDate: day("2026-03-16"),
      extractedDebitDate: null,
    };
    expect(decided(record)).toMatchObject({ update: {}, followUps: [] });
    // Absent and null are alike: a File with no rows and no fields gets no write.
    expect(decided({ extractedDate: day(ISSUE) })).toMatchObject({ update: {}, followUps: [] });
  });

  it("fixes an inversion: a Due Date before the issue date is not stored (#135)", () => {
    const { update } = decided({
      extractedDate: day(ISSUE),
      extractedAdditionalFields: [{ key: "dueDate", label: "Fällig am", value: "2026-02-16" }],
      extractedDueDate: day("2026-02-16"),
    });
    expect(update.extractedDueDate).toBeNull();
  });

  it("re-derives against a hand-corrected issue date, which is the date's input, not the date", () => {
    const { update } = decided({
      extractedDate: day("2026-03-18"),
      extractedAdditionalFields: [DUE_ROW],
      extractedDueDate: day("2026-03-16"),
      extractionCorrectedFields: { date: AT },
      extractionCorrectedAt: AT,
    });
    expect(update.extractedDueDate).toBeNull();
  });

  it("clears a stored date the rows no longer state", () => {
    const { update } = decided({
      extractedDate: day(ISSUE),
      extractedAdditionalFields: null,
      extractedDebitDate: day("2026-03-20"),
    });
    expect(update.extractedDebitDate).toBeNull();
  });

  it("refuses a File whose Due Date or Debit Date the User set by hand, and writes nothing", () => {
    for (const field of ["dueDate", "debitDate"]) {
      const outcome = backfill({
        extractedDate: day(ISSUE),
        extractedAdditionalFields: [DUE_ROW, DEBIT_ROW],
        extractionCorrectedFields: { [field]: AT },
        extractionCorrectedAt: AT,
      });
      expect(outcome).toMatchObject({ refused: true, code: "HAND_CORRECTED", fields: [field] });
    }
  });

  it("reads the issue day from the UTC date part, on any host", () => {
    // Stored dates are UTC midnight of the Vienna day: a Due Date on the
    // issue day itself is fine (zahlbar sofort) and must not read as before it.
    const { update } = decided({
      extractedDate: day("2026-03-16"),
      extractedAdditionalFields: [DUE_ROW],
    });
    expect(isoOf(update.extractedDueDate)).toBe("2026-03-16");
  });
});
