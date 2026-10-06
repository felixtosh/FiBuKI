/**
 * #236: score the Transaction date against the payment window
 * `[issueDate, dueDate]`, not against the invoice date alone.
 *
 * The design rests on monotonicity: the issue date always lies inside the
 * window, so the window distance is never greater than today's distance and
 * no existing Match can lose points. Several cases below exist only to pin
 * that.
 */

import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import {
  calculateDateScore,
  scoreTransaction,
  toFileMatchingData,
  SCORING_CONFIG,
  BillingCycleHint,
  FileMatchingData,
  TransactionData,
} from "../transactionScoring";
import { dueDateFromAdditionalFields, parseIsoDueDate } from "../dueDate";
import { toDateSafe } from "../../utils/toDateSafe";

function d(dateStr: string): Date {
  return new Date(dateStr);
}

function ts(dateStr: string): Timestamp {
  return Timestamp.fromDate(new Date(dateStr));
}

const ISSUE = "2026-01-05";
const DUE = "2026-01-20";

// ============================================================================
// Reading the Due Date off the Extraction
// ============================================================================

describe("dueDateFromAdditionalFields", () => {
  it("reads the keyless legacy 'Due Date' row", () => {
    const date = dueDateFromAdditionalFields([
      { label: "Rechnungsnummer", value: "INV-0042" },
      { label: "Due Date", value: "2026-01-20", rawValue: "20.01.2026" },
    ]);
    expect(date).not.toBeNull();
    expect([date!.getUTCFullYear(), date!.getUTCMonth(), date!.getUTCDate()]).toEqual([2026, 0, 20]);
  });

  it("reads the vocabulary key whatever the printed label", () => {
    const date = dueDateFromAdditionalFields([
      { key: "dueDate", label: "Zahlungstermin", value: "2026-01-20" },
    ]);
    expect(date?.getUTCDate()).toBe(20);
  });

  it("never reads a Zahlungsziel, even filed under the dueDate key", () => {
    expect(
      dueDateFromAdditionalFields([{ key: "dueDate", label: "Zahlungsziel", value: "2026-01-20" }])
    ).toBeNull();
    expect(
      dueDateFromAdditionalFields([{ key: "paymentTerms", label: "Due Date", value: "2026-01-20" }])
    ).toBeNull();
    expect(
      dueDateFromAdditionalFields([{ label: "Zahlungsziel", value: "14 Tage" }])
    ).toBeNull();
  });

  it("reads a keyless row under any printed synonym of the Fälligkeitsdatum (#135)", () => {
    for (const label of [
      "Fälligkeitsdatum",
      "Zahlungstermin",
      "Fällig am",
      "fällig am:",
      "Zahlbar bis",
      "Zahlbar ohne Abzug bis",
    ]) {
      expect(dueDateFromAdditionalFields([{ label, value: "2026-01-20" }])?.getUTCDate()).toBe(20);
    }
  });

  it("stays closed: a keyless row under any other label is not a Due Date", () => {
    for (const label of ["Datum", "Leistungszeitraum", "Zahlung", "Frist"]) {
      expect(dueDateFromAdditionalFields([{ label, value: "2026-01-20" }])).toBeNull();
    }
  });

  it("rejects a Due Date earlier than the issue date, which inverts the window (#135)", () => {
    const issue = new Date(Date.UTC(2026, 0, 5));
    expect(
      dueDateFromAdditionalFields([{ key: "dueDate", label: "Fällig am", value: "2026-01-02" }], issue)
    ).toBeNull();
    // Equal is zahlbar sofort, a real document, and stays accepted.
    expect(
      dueDateFromAdditionalFields([{ key: "dueDate", label: "Fällig am", value: "2026-01-05" }], issue)
        ?.getUTCDate()
    ).toBe(5);
    // Day-level: an issue date carrying a time of day does not push the
    // boundary past its own calendar day.
    const issueWithTime = new Date(Date.UTC(2026, 0, 5, 14, 30));
    expect(
      dueDateFromAdditionalFields(
        [{ key: "dueDate", label: "Fällig am", value: "2026-01-05" }],
        issueWithTime
      )?.getUTCDate()
    ).toBe(5);
    // Without an issue date there is nothing to reject against.
    expect(
      dueDateFromAdditionalFields([{ key: "dueDate", label: "Fällig am", value: "2026-01-02" }])
        ?.getUTCDate()
    ).toBe(2);
  });

  it("rejects values that are not a real ISO date", () => {
    expect(parseIsoDueDate("20.01.2026")).toBeNull();
    expect(parseIsoDueDate("14 Tage")).toBeNull();
    expect(parseIsoDueDate("2026-02-31")).toBeNull();
    expect(parseIsoDueDate("1970-01-01")).toBeNull();
    expect(parseIsoDueDate(null)).toBeNull();
    expect(dueDateFromAdditionalFields(null)).toBeNull();
    expect(dueDateFromAdditionalFields("Due Date")).toBeNull();
  });
});

describe("toFileMatchingData: extractedDueDate", () => {
  it("backfills a legacy record from the 'Due Date' row, without re-extraction", () => {
    const data = toFileMatchingData({
      extractedDate: ts(ISSUE),
      extractedAdditionalFields: [{ label: "Due Date", value: DUE, rawValue: "20.01.2026" }],
    });
    const due = toDateSafe(data.extractedDueDate);
    expect(due).toBeDefined();
    expect([due!.getUTCFullYear(), due!.getUTCMonth(), due!.getUTCDate()]).toEqual([2026, 0, 20]);
  });

  it("prefers the typed field, and a typed null means extraction found none", () => {
    const typed = ts(DUE);
    expect(
      toFileMatchingData({
        extractedDueDate: typed,
        extractedAdditionalFields: [{ label: "Due Date", value: "2026-03-01" }],
      }).extractedDueDate
    ).toBe(typed);
    expect(
      toFileMatchingData({
        extractedDueDate: null,
        extractedAdditionalFields: [{ label: "Due Date", value: DUE }],
      }).extractedDueDate
    ).toBeNull();
  });

  it("is null when the record states no Due Date at all", () => {
    expect(toFileMatchingData({ extractedDate: ts(ISSUE) }).extractedDueDate).toBeNull();
  });
});

// ============================================================================
// calculateDateScore over the window
// ============================================================================

describe("calculateDateScore with a Due Date", () => {
  it("scores date_exact anywhere inside [issueDate, dueDate]", () => {
    for (const tx of ["2026-01-05", "2026-01-09", "2026-01-12", "2026-01-17", "2026-01-20"]) {
      const result = calculateDateScore(d(ISSUE), d(tx), undefined, d(DUE));
      expect(result.score, tx).toBe(25);
      expect(result.source, tx).toBe("date_exact");
    }
  });

  it("scores from the nearer edge outside the window, not from the issue date", () => {
    // 2 days after the due date is a Due Date hit since #618 (settlement
    // lag); 17 days from issue would be 3 points.
    expect(calculateDateScore(d(ISSUE), d("2026-01-22"), undefined, d(DUE)).score).toBe(25);
    // 4 days after the due date, past the lag: scored from the edge.
    expect(calculateDateScore(d(ISSUE), d("2026-01-24"), undefined, d(DUE)).score).toBe(15);
    // 5 days after the due date.
    expect(calculateDateScore(d(ISSUE), d("2026-01-25"), undefined, d(DUE)).score).toBe(15);
    // Before the window, the issue date is the nearer edge: identical to today.
    expect(calculateDateScore(d(ISSUE), d("2026-01-02"), undefined, d(DUE)).score).toBe(22);
  });

  it("a File with no Due Date scores exactly as it does today", () => {
    const cycles: (BillingCycleHint | undefined)[] = [
      undefined,
      { invoiceToTransactionDelay: 14, delayVariance: 3 },
      { invoiceToTransactionDelay: 1, delayVariance: 2, frequencyDays: 7 },
    ];
    for (const cycle of cycles) {
      for (let offset = -40; offset <= 40; offset++) {
        const tx = new Date(d(ISSUE).getTime() + offset * 86_400_000);
        const today = calculateDateScore(d(ISSUE), tx, cycle);
        expect(calculateDateScore(d(ISSUE), tx, cycle, null)).toEqual(today);
        expect(calculateDateScore(d(ISSUE), tx, cycle, undefined)).toEqual(today);
      }
    }
  });

  it("is monotone: a Due Date never lowers the date score", () => {
    for (let offset = -40; offset <= 60; offset++) {
      const tx = new Date(d(ISSUE).getTime() + offset * 86_400_000);
      const without = calculateDateScore(d(ISSUE), tx).score;
      const withDue = calculateDateScore(d(ISSUE), tx, undefined, d(DUE)).score;
      expect(withDue, `offset ${offset}`).toBeGreaterThanOrEqual(without);
    }
  });

  it("ignores a Due Date earlier than the issue date (an inverted window is a misread)", () => {
    const today = calculateDateScore(d(ISSUE), d("2026-01-01"));
    expect(calculateDateScore(d(ISSUE), d("2026-01-01"), undefined, d("2025-12-20"))).toEqual(
      today
    );
  });

  it("where no cycle is learned, a window wider than the cap scores only its endpoints", () => {
    const wideDue = "2026-03-06"; // 60 days after issue
    expect(SCORING_CONFIG.DUE_DATE_WINDOW_CAP_DAYS).toBe(30);

    // Mid-window: 30 days from each endpoint, so no interior hit.
    expect(calculateDateScore(d(ISSUE), d("2026-02-04"), undefined, d(wideDue)).score).toBe(3);
    // Endpoints still count.
    expect(calculateDateScore(d(ISSUE), d(wideDue), undefined, d(wideDue)).score).toBe(25);
    expect(calculateDateScore(d(ISSUE), d("2026-03-04"), undefined, d(wideDue)).score).toBe(22);

    // A window exactly at the cap is still a window.
    const capDue = "2026-02-04"; // 30 days after issue
    expect(calculateDateScore(d(ISSUE), d("2026-01-20"), undefined, d(capDue)).score).toBe(25);
  });

  it("keeps the frequencyDays period penalty with a wide window present (INCW9PTA shape)", () => {
    // Weekly biller, learned delay 3 +/- 0. A same-amount charge one period
    // away sits inside a 14-day stated window and must still lose.
    const cycle: BillingCycleHint = {
      invoiceToTransactionDelay: 3,
      delayVariance: 0,
      frequencyDays: 7,
    };
    const issue = d("2026-07-02");
    const due = d("2026-07-16");

    const theCharge = calculateDateScore(issue, d("2026-07-05"), cycle, due);
    const onePeriodLater = calculateDateScore(issue, d("2026-07-12"), cycle, due);
    const onePeriodBefore = calculateDateScore(issue, d("2026-06-28"), cycle, due);

    expect(theCharge.score).toBe(25);
    expect(onePeriodLater.score).toBe(0);
    expect(onePeriodBefore.score).toBe(0);
  });

  it("the learned invoiceToTransactionDelay still takes precedence where it exists", () => {
    // Learned 14 +/- 3; tx at day 9 is 5 off the delay (<= 2x variance), so
    // the learned path answers 22 even though the stated window says 25.
    const cycle: BillingCycleHint = { invoiceToTransactionDelay: 14, delayVariance: 3 };
    const result = calculateDateScore(d(ISSUE), d("2026-01-14"), cycle, d(DUE));
    expect(result.score).toBe(22);
    expect(result.source).toBe("date_close");
  });
});

// ============================================================================
// scoreTransaction: the endpoint rule and the observed case
// ============================================================================

describe("scoreTransaction with a payment window", () => {
  const file: FileMatchingData = {
    extractedAmount: 3999,
    extractedCurrency: "EUR",
    extractedDate: ts(ISSUE),
    extractedDueDate: ts(DUE),
    extractedPartner: null,
    extractedIban: null,
    extractedText: null,
    partnerId: null,
  };
  const tx: TransactionData = {
    id: "tx-1",
    amount: -3999,
    date: ts(DUE),
    currency: "EUR",
    name: "SEPA-Lastschrift",
  };

  it("HARD_FACTS_BONUS_SAME_DAY fires on an exact hit on the due-date endpoint", () => {
    const result = scoreTransaction(file, tx);
    expect(result.breakdown.date).toBe(25);
    expect(result.breakdown.hardFacts).toBe(SCORING_CONFIG.HARD_FACTS_BONUS_SAME_DAY);
    expect(result.confidence).toBe(85);
  });

  it("does not fire for a cent-exact Transaction strictly inside the window", () => {
    const result = scoreTransaction(file, { ...tx, date: ts("2026-01-12") });
    expect(result.breakdown.date).toBe(25);
    expect(result.matchSources).toContain("date_exact");
    expect(result.breakdown.hardFacts).toBe(0);
    expect(result.confidence).toBe(65);
  });

  it("near an endpoint inside the window, the close bonus is decided on that endpoint", () => {
    // Two days after issue: today this is 22 + HARD_FACTS_BONUS_CLOSE. The
    // window lifts the date to 25 and must not take the bonus away.
    const inside = scoreTransaction(file, { ...tx, date: ts("2026-01-07") });
    const today = scoreTransaction({ ...file, extractedDueDate: null }, { ...tx, date: ts("2026-01-07") });
    expect(today.breakdown.hardFacts).toBe(SCORING_CONFIG.HARD_FACTS_BONUS_CLOSE);
    expect(inside.breakdown.hardFacts).toBe(SCORING_CONFIG.HARD_FACTS_BONUS_CLOSE);
    expect(inside.confidence).toBeGreaterThanOrEqual(today.confidence);
  });

  it("a File with no Due Date scores exactly as it does today", () => {
    const noDue = { ...file, extractedDueDate: undefined };
    for (const date of ["2026-01-05", "2026-01-07", "2026-01-12", "2026-01-20", "2026-01-25"]) {
      const candidate = { ...tx, date: ts(date) };
      expect(scoreTransaction({ ...file, extractedDueDate: null }, candidate)).toEqual(
        scoreTransaction(noDue, candidate)
      );
    }
  });

  it("the observed mobile invoice (issue 05.01, due 20.01, debit 20.01) reaches AUTO_MATCH_THRESHOLD", () => {
    const iban = "AT611904300234573201";
    const mobileInvoice: FileMatchingData = {
      ...file,
      extractedPartner: "Magenta Telekom",
      extractedIban: iban,
    };
    const debit: TransactionData = {
      ...tx,
      partner: "Magenta Telekom",
      partnerIban: iban,
    };

    const result = scoreTransaction(mobileInvoice, debit);
    expect(result.confidence).toBeGreaterThanOrEqual(SCORING_CONFIG.AUTO_MATCH_THRESHOLD);

    // Before any Partner or IBAN was assigned: amount + date + bonus alone.
    const bare = scoreTransaction(file, tx);
    expect(bare.confidence).toBeGreaterThanOrEqual(SCORING_CONFIG.AUTO_MATCH_THRESHOLD);

    // And without the Due Date the same pair stays where it was reported.
    const withoutDue = scoreTransaction({ ...file, extractedDueDate: null }, tx);
    expect(withoutDue.confidence).toBe(43);
  });
});
