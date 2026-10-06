/**
 * #618: a stated payment date absorbs the weekend, and teaches the billing
 * cycle the payment term.
 *
 * The observed case: a telecom invoice dated 05.06.2026 states "Zahlungstermin
 * 20.06.2026", a Saturday, and the bank books the collection on Monday 22.06.
 */

import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import {
  calculateDateScore,
  scoreTransaction,
  statedPaymentDate,
  toFileMatchingData,
  SCORING_CONFIG,
  BillingCycleHint,
  FileMatchingData,
  TransactionData,
} from "../transactionScoring";
import { isDueDateHit, SETTLEMENT_LAG_DAYS } from "../dueDate";
import { deriveLearnedCycles, type BillingCycleTransaction } from "../billingCycle";
import { delaySampleForFile } from "../learnBillingCycle";

const DAY = 86_400_000;

function d(dateStr: string): Date {
  return new Date(dateStr);
}

function ts(dateStr: string): Timestamp {
  return Timestamp.fromDate(new Date(dateStr));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY);
}

/** The day itself, or the Monday after when it falls on a weekend. */
function nextBankingDay(date: Date): Date {
  const weekday = date.getUTCDay();
  if (weekday === 6) return addDays(date, 2);
  if (weekday === 0) return addDays(date, 1);
  return date;
}

const ISSUE = "2026-06-05";
const DUE = "2026-06-20"; // a Saturday
const MONDAY = "2026-06-22";

// ============================================================================
// Decision 1: a Due Date gets the settlement lag
// ============================================================================

describe("isDueDateHit", () => {
  it("is the Due Date or up to three days after it, forward only", () => {
    expect(SETTLEMENT_LAG_DAYS).toBe(3);
    expect(d(DUE).getUTCDay()).toBe(6);
    expect(isDueDateHit(d(DUE), d("2026-06-19"))).toBe(false);
    expect(isDueDateHit(d(DUE), d(DUE))).toBe(true);
    expect(isDueDateHit(d(DUE), d(MONDAY))).toBe(true);
    expect(isDueDateHit(d(DUE), d("2026-06-23"))).toBe(true);
    expect(isDueDateHit(d(DUE), d("2026-06-24"))).toBe(false);
  });
});

describe("calculateDateScore: a Due Date hit", () => {
  it("scores a booking up to three days after the Due Date as the same-day endpoint", () => {
    for (const tx of [DUE, "2026-06-21", MONDAY, "2026-06-23"]) {
      const result = calculateDateScore(d(ISSUE), d(tx), undefined, d(DUE));
      expect(result, tx).toEqual({ score: 25, source: "date_exact", endpointScore: 25 });
    }
  });

  it("a booking four days after the Due Date is not a hit", () => {
    const result = calculateDateScore(d(ISSUE), d("2026-06-24"), undefined, d(DUE));
    expect(result.score).toBe(15);
    expect(result.endpointScore).toBe(15);
  });

  it("a Due Date on the issue date opens no window, so it gets no lag either", () => {
    const today = calculateDateScore(d(ISSUE), d("2026-06-07"));
    expect(calculateDateScore(d(ISSUE), d("2026-06-07"), undefined, d(ISSUE))).toEqual(today);
    expect(today.score).toBe(22);
  });
});

describe("scoreTransaction: the observed telecom invoice", () => {
  const file: FileMatchingData = {
    extractedAmount: 4590,
    extractedCurrency: "EUR",
    extractedDate: ts(ISSUE),
    extractedDueDate: ts(DUE),
    extractedDebitDate: null,
    extractedPartner: null,
    extractedIban: null,
    extractedText: null,
    partnerId: null,
  };
  const tx: TransactionData = {
    id: "tx-1",
    amount: -4590,
    date: ts(MONDAY),
    currency: "EUR",
    name: "SEPA-Lastschrift",
  };

  it("Due Date 20.06 (Saturday), booking 22.06, exact amount: date 25 and the same-day bonus", () => {
    const result = scoreTransaction(file, tx);
    expect(result.breakdown.date).toBe(25);
    expect(result.matchSources).toContain("date_exact");
    expect(result.breakdown.hardFacts).toBe(SCORING_CONFIG.HARD_FACTS_BONUS_SAME_DAY);
  });

  it("booking 24.06 is not a hit", () => {
    const result = scoreTransaction(file, { ...tx, date: ts("2026-06-24") });
    expect(result.breakdown.date).toBe(15);
    expect(result.breakdown.hardFacts).toBe(0);
  });

  it("the direct-debit near-proof bonus stays a Debit Date matter", () => {
    const result = scoreTransaction(file, { ...tx, transactionType: "direct_debit" });
    expect(result.breakdown.hardFacts).toBe(SCORING_CONFIG.HARD_FACTS_BONUS_SAME_DAY);
    expect(result.matchSources).not.toContain("debit_date");
  });

  it("reads the stored Due Date, never the 'Zahlungstermin' row it was derived from (#641)", () => {
    const record = {
      extractedAmount: 4590,
      extractedCurrency: "EUR",
      extractedDate: ts(ISSUE),
      extractedAdditionalFields: [{ label: "Zahlungstermin", value: DUE }],
    };
    expect(scoreTransaction(toFileMatchingData(record), tx).breakdown.hardFacts).not.toBe(
      SCORING_CONFIG.HARD_FACTS_BONUS_SAME_DAY
    );
    const stored = toFileMatchingData({ ...record, extractedDueDate: ts(DUE) });
    expect(scoreTransaction(stored, tx).breakdown.hardFacts).toBe(
      SCORING_CONFIG.HARD_FACTS_BONUS_SAME_DAY
    );
  });
});

// ============================================================================
// Decision 2, as decided on the PR (option b): a stated-date hit overrides
// the learned delay, but not the rule that a booking on a neighbouring
// period's expected day is that period's charge
// ============================================================================

describe("a Due Date hit against a learned cycle", () => {
  it("is not undercut by the learned delay's close band", () => {
    // Learned 15 +/- 1 on a monthly cycle: a booking 19 days after issue is
    // close at best. It is the day after the stated Due Date.
    const cycle: BillingCycleHint = { invoiceToTransactionDelay: 15, delayVariance: 1, frequencyDays: 30 };
    const result = calculateDateScore(d(ISSUE), d("2026-06-24"), cycle, d("2026-06-23"));
    expect(result).toEqual({ score: 25, source: "date_exact", endpointScore: 25 });
  });

  it("is not undercut by a learned delay the booking misses entirely", () => {
    // Learned 10 +/- 1, monthly: a booking 19 days after issue is neither on
    // time nor close, and no neighbouring period is near. The Due Date is.
    const cycle: BillingCycleHint = { invoiceToTransactionDelay: 10, delayVariance: 1, frequencyDays: 30 };
    expect(calculateDateScore(d(ISSUE), d("2026-06-24"), cycle).score).toBe(3);
    const result = calculateDateScore(d(ISSUE), d("2026-06-24"), cycle, d("2026-06-23"));
    expect(result).toEqual({ score: 25, source: "date_exact", endpointScore: 25 });
  });

  it("carries the same-day hard-facts bonus through scoreTransaction", () => {
    const file: FileMatchingData = {
      extractedAmount: 45.9,
      extractedCurrency: "EUR",
      extractedDate: ts(ISSUE),
      extractedDueDate: ts("2026-06-23"),
      extractedPartner: null,
      extractedIban: null,
      extractedText: null,
      partnerId: null,
    };
    const tx: TransactionData = { id: "t", amount: -45.9, date: ts("2026-06-24"), currency: "EUR", name: "x" };
    const billingCycle: BillingCycleHint = { invoiceToTransactionDelay: 10, delayVariance: 1, frequencyDays: 30 };
    const result = scoreTransaction(file, tx, undefined, { billingCycle });
    expect(result.breakdown.date).toBe(25);
    expect(result.breakdown.hardFacts).toBe(SCORING_CONFIG.HARD_FACTS_BONUS_SAME_DAY);
  });

  it("loses to the period penalty when the booking is the neighbouring period's charge", () => {
    // Weekly biller, learned delay 3 +/- 0. A booking ten days after issue
    // sits on next week's expected day. The File's Due Date two days earlier
    // does not make it this File's payment.
    const cycle: BillingCycleHint = { invoiceToTransactionDelay: 3, delayVariance: 0, frequencyDays: 7 };
    const issue = d("2026-07-02");
    const booking = d("2026-07-12");
    expect(calculateDateScore(issue, booking, cycle).score).toBe(0);
    expect(calculateDateScore(issue, booking, cycle, d("2026-07-10")).score).toBe(0);
  });
});

describe("the reviewer's case: net-30 invoice paid by card on issue, next month's charge on the Due Date + 1", () => {
  // A monthly invoice dated 01.03 with a net-30 Due Date (31.03), paid by
  // card on 01.03; the same amount is charged again on 01.04. The learned
  // cycle says: paid on the issue day, every 30 days.
  const billingCycle: BillingCycleHint = { invoiceToTransactionDelay: 0, delayVariance: 1, frequencyDays: 30 };
  const file: FileMatchingData = {
    extractedAmount: 29.99,
    extractedCurrency: "EUR",
    extractedDate: ts("2026-03-01"),
    extractedDueDate: ts("2026-03-31"),
    extractedPartner: null,
    extractedIban: null,
    extractedText: null,
    partnerId: null,
  };
  const rightCharge: TransactionData = {
    id: "march",
    amount: -29.99,
    date: ts("2026-03-01"),
    currency: "EUR",
    name: "Card payment",
    transactionType: "card",
  };
  const nextCharge: TransactionData = { ...rightCharge, id: "april", date: ts("2026-04-01") };
  const withPartner = (f: FileMatchingData): FileMatchingData => ({ ...f, partnerId: "p-1" });
  const txWithPartner = (t: TransactionData): TransactionData => ({ ...t, partnerId: "p-1" });

  it("the 01.04 charge stays below the auto-connect threshold, with or without a Partner match", () => {
    const bare = scoreTransaction(file, nextCharge, undefined, { billingCycle });
    const partnered = scoreTransaction(withPartner(file), txWithPartner(nextCharge), undefined, { billingCycle });
    expect(bare.confidence).toBe(40);
    expect(partnered.confidence).toBe(55);
    expect(partnered.confidence).toBeLessThan(SCORING_CONFIG.AUTO_MATCH_THRESHOLD);
  });

  it("the 01.03 charge keeps its score", () => {
    const bare = scoreTransaction(file, rightCharge, undefined, { billingCycle });
    const partnered = scoreTransaction(withPartner(file), txWithPartner(rightCharge), undefined, { billingCycle });
    expect(bare.confidence).toBe(85);
    expect(partnered.confidence).toBe(100);
  });

  it("the same holds when the File states the date as a Debit Date", () => {
    const asDebit: FileMatchingData = { ...file, extractedDueDate: null, extractedDebitDate: ts("2026-03-31") };
    const next = scoreTransaction(withPartner(asDebit), txWithPartner(nextCharge), undefined, { billingCycle });
    expect(next.confidence).toBeLessThan(SCORING_CONFIG.AUTO_MATCH_THRESHOLD);
    expect(next.matchSources).not.toContain("debit_date");
    const right = scoreTransaction(withPartner(asDebit), txWithPartner(rightCharge), undefined, { billingCycle });
    expect(right.confidence).toBe(100);
  });
});

// ============================================================================
// Decision 4: the learned check gets the same forward lag
// ============================================================================

describe("calculateDateScore: the learned check's forward lag", () => {
  const monthly: BillingCycleHint = { invoiceToTransactionDelay: 15, delayVariance: 0, frequencyDays: 30 };

  it("expected day on a Saturday, booking on the Monday scores as on time", () => {
    // Issue 05.06 + 15 = 20.06, a Saturday. No Due Date on this File.
    const result = calculateDateScore(d(ISSUE), d(MONDAY), monthly);
    expect(result).toEqual({ score: 25, source: "date_exact", endpointScore: 25 });
  });

  it("is forward only and stops after three days", () => {
    expect(calculateDateScore(d(ISSUE), d("2026-06-23"), monthly).score).toBe(25);
    expect(calculateDateScore(d(ISSUE), d("2026-06-24"), monthly).score).not.toBe(25);
    expect(calculateDateScore(d(ISSUE), d("2026-06-19"), monthly).score).not.toBe(25);
  });

  it("sits on top of the learned variance", () => {
    const loose: BillingCycleHint = { ...monthly, delayVariance: 2 };
    expect(calculateDateScore(d(ISSUE), d("2026-06-25"), loose).score).toBe(25); // 20.06 + 2 + 3
    expect(calculateDateScore(d(ISSUE), d("2026-06-18"), loose).score).toBe(25); // 20.06 - 2
    expect(calculateDateScore(d(ISSUE), d("2026-06-17"), loose).score).toBe(22); // close, as before
  });

  it("the period penalty also allows the lag after a neighbouring period's day", () => {
    // The previous month's collection: expected day 21.05 (one period before
    // 20.06), booked three days late on 24.05. One period plus the lag is
    // still that other period's charge; before #618 it scored 8 here, 12
    // days before this File's issue date.
    const cycle: BillingCycleHint = { ...monthly, delayVariance: 1 };
    const result = calculateDateScore(d(ISSUE), d("2026-05-24"), cycle);
    expect(result.score).toBe(0);
    // Inside the plain variance it was penalised before and still is.
    expect(calculateDateScore(d(ISSUE), d("2026-05-22"), cycle).score).toBe(0);
  });

  it("is not applied to a weekly cycle, where three days is half a period", () => {
    const weekly: BillingCycleHint = { invoiceToTransactionDelay: 3, delayVariance: 0, frequencyDays: 7 };
    expect(calculateDateScore(d("2026-07-02"), d("2026-07-06"), weekly).score).toBeLessThan(25);
  });
});

// ============================================================================
// Decision 3 + 5: the learner learns the payment term from what the File prints
// ============================================================================

/** Eight monthly Files dated the 5th, May to December 2026. */
const MONTHS = ["05", "06", "07", "08", "09", "10", "11", "12"];

function charge(month: string, opts: { stated: boolean }): BillingCycleTransaction {
  const issue = d(`2026-${month}-05`);
  const twentieth = d(`2026-${month}-20`);
  return {
    date: nextBankingDay(twentieth),
    amount: 45.9,
    ...(opts.stated
      ? { statedTerms: [{ invoiceDate: issue, statedDate: twentieth }] }
      : { invoiceDates: [issue] }),
  };
}

describe("deriveLearnedCycles with stated payment dates", () => {
  it("the fixture has weekend shifts that break a booking-measured cycle", () => {
    const shifted = MONTHS.filter((m) => nextBankingDay(d(`2026-${m}-20`)).getUTCDate() !== 20);
    expect(shifted.length).toBeGreaterThanOrEqual(3);
    const measuredToBooking = deriveLearnedCycles(MONTHS.map((m) => charge(m, { stated: false })));
    expect(measuredToBooking[0].delayVariance).toBeGreaterThan(0);
  });

  it("eight Files stating the 20th, booked on the 20th or the Monday after: delay 15, variance 0", () => {
    const cycles = deriveLearnedCycles(MONTHS.map((m) => charge(m, { stated: true })));
    expect(cycles).toHaveLength(1);
    expect(cycles[0].invoiceToTransactionDelay).toBe(15);
    expect(cycles[0].delayVariance).toBe(0);
  });

  it("mixed Files, some stating a date and some not, learn one delay", () => {
    const cycles = deriveLearnedCycles(MONTHS.map((m, i) => charge(m, { stated: i < 4 })));
    expect(cycles).toHaveLength(1);
    expect(cycles[0].invoiceToTransactionDelay).toBe(15);
    expect(cycles[0].sampleSize).toBe(8);
  });

  it("a booking that is not on the stated date keeps measuring to the booking", () => {
    // A User who pays ten days past the Zahlungstermin every month: the
    // printed term says 15, the habit says 25, and the habit is what the
    // learned check must recognise.
    const latePayer = MONTHS.map((m) => ({
      date: d(`2026-${m}-30`),
      amount: 45.9,
      statedTerms: [{ invoiceDate: d(`2026-${m}-05`), statedDate: d(`2026-${m}-20`) }],
    }));
    expect(deriveLearnedCycles(latePayer)[0].invoiceToTransactionDelay).toBe(25);

    // One who pays on receipt, well before it.
    const earlyPayer = MONTHS.map((m) => ({
      date: d(`2026-${m}-07`),
      amount: 45.9,
      statedTerms: [{ invoiceDate: d(`2026-${m}-05`), statedDate: d(`2026-${m}-20`) }],
    }));
    expect(deriveLearnedCycles(earlyPayer)[0].invoiceToTransactionDelay).toBe(2);
  });

  it("counts stated-date samples towards the three-sample minimum", () => {
    const cycles = deriveLearnedCycles([
      charge("05", { stated: true }),
      charge("06", { stated: true }),
      charge("07", { stated: false }),
      { date: d("2026-08-20"), amount: 45.9 },
    ]);
    expect(cycles[0].invoiceToTransactionDelay).toBe(15);
  });
});

describe("statedPaymentDate: what the learner measures to", () => {
  it("is the Debit Date when both are present", () => {
    const file = {
      extractedDate: ts(ISSUE),
      extractedDueDate: ts("2026-06-19"),
      extractedDebitDate: ts(DUE),
    };
    expect(statedPaymentDate(file)?.toISOString().slice(0, 10)).toBe(DUE);
  });

  it("is the stored Due Date otherwise; rows without a stored date state none (#641)", () => {
    const rows = [{ label: "Zahlungstermin", value: DUE }];
    const file = { extractedDate: ts(ISSUE), extractedDueDate: ts(DUE), extractedAdditionalFields: rows };
    expect(statedPaymentDate(file)?.toISOString().slice(0, 10)).toBe(DUE);
    expect(statedPaymentDate({ extractedDate: ts(ISSUE), extractedAdditionalFields: rows })).toBeNull();
  });

  it("prefers the typed field: a typed null means extraction found none", () => {
    const file = {
      extractedDate: ts(ISSUE),
      extractedDueDate: null,
      extractedAdditionalFields: [{ label: "Zahlungstermin", value: DUE }],
    };
    expect(statedPaymentDate(file)).toBeNull();
  });

  it("ignores a Due Date that opens no window, and is null when nothing is stated", () => {
    expect(statedPaymentDate({ extractedDate: ts(ISSUE), extractedDueDate: ts(ISSUE) })).toBeNull();
    expect(statedPaymentDate({ extractedDate: ts(ISSUE), extractedDueDate: ts("2026-06-01") })).toBeNull();
    expect(statedPaymentDate({ extractedDate: ts(ISSUE) })).toBeNull();
    expect(statedPaymentDate({ extractedDueDate: ts(DUE) })).toBeNull();
  });

  it("ignores a Debit Date before the issue date", () => {
    expect(statedPaymentDate({ extractedDate: ts(ISSUE), extractedDebitDate: ts("2026-06-01") })).toBeNull();
  });
});

describe("delaySampleForFile: one connected File's delay sample", () => {
  it("a File stating a date measures to it", () => {
    const sample = delaySampleForFile({
      extractedDate: ts(ISSUE),
      extractedDueDate: ts(DUE),
      extractedAdditionalFields: [{ key: "dueDate", label: "Zahlungstermin", value: DUE }],
    });
    expect(sample?.invoiceDate.toISOString().slice(0, 10)).toBe(ISSUE);
    expect(sample?.statedDate?.toISOString().slice(0, 10)).toBe(DUE);
  });

  it("a File stating no date keeps measuring to the booking", () => {
    const sample = delaySampleForFile({ extractedDate: ts(ISSUE) });
    expect(sample?.invoiceDate.toISOString().slice(0, 10)).toBe(ISSUE);
    expect(sample?.statedDate).toBeNull();
    // A row the File does not store as a date is not read (#641).
    const unstored = delaySampleForFile({
      extractedDate: ts(ISSUE),
      extractedAdditionalFields: [{ key: "dueDate", label: "Zahlungstermin", value: DUE }],
    });
    expect(unstored?.statedDate).toBeNull();
  });

  it("a File with no date contributes nothing", () => {
    expect(delaySampleForFile({ extractedDueDate: ts(DUE) })).toBeNull();
  });
});
