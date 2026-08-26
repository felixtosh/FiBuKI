/**
 * Tests for the billing-cycle date window the search-query generator emits
 * beside its queries (#169): a recurring partner's charge gets a window, a
 * non-recurring one gets none. The pure cycle derivation the window reads
 * from is covered by ../../matching/__tests__/learnBillingCycle.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  expectedInvoiceWindow,
  generateSearchQueryPlan,
  type QueryGenerationPartner,
} from "../generateSearchQueries";
import type { ResolvedEffectiveCycle } from "../../matching/billingCycle";

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** 2026-07-15, the charge every test below is about. */
const TX_DATE = new Date("2026-07-15T00:00:00.000Z");

/** Days between two dates, so assertions read as "5 days before the charge". */
function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}

const MONTHLY: ResolvedEffectiveCycle = {
  source: "learned",
  frequencyDays: 30,
  frequencyConfidence: 90,
  typicalDayOfMonth: 15,
  dayVariance: 2,
  invoiceToTransactionDelay: 5,
  delayVariance: 2,
};

const recurringPartner: QueryGenerationPartner = {
  name: "Notion Labs",
  emailDomains: ["notion.so"],
  effectiveCycles: [MONTHLY],
};

const plainPartner: QueryGenerationPartner = {
  name: "Bipa",
  emailDomains: ["bipa.at"],
};

describe("expectedInvoiceWindow", () => {
  it("puts the window at the transaction date minus the learned delay", () => {
    const window = expectedInvoiceWindow(
      { name: "NOTION LABS INC", date: TX_DATE, amount: 1000 },
      recurringPartner
    );

    expect(window).toBeDefined();
    expect(daysBetween(window!.expectedAt, TX_DATE)).toBe(5);
    // delayVariance 2, doubled to also admit what the scorer calls a "close" date
    expect(window!.varianceDays).toBe(4);
    expect(daysBetween(window!.from, window!.expectedAt)).toBe(4);
    expect(daysBetween(window!.expectedAt, window!.to)).toBe(4);
  });

  it("yields no window for a partner with no billing cycle", () => {
    expect(
      expectedInvoiceWindow({ name: "BIPA 4711", date: TX_DATE, amount: 1000 }, plainPartner)
    ).toBeUndefined();
    expect(
      expectedInvoiceWindow({ name: "BIPA 4711", date: TX_DATE, amount: 1000 }, null)
    ).toBeUndefined();
  });

  it("yields no window for a charge that belongs to none of the partner's bands", () => {
    const anthropic: QueryGenerationPartner = {
      name: "Anthropic PBC",
      effectiveCycles: [
        { source: "learned", frequencyDays: 7, amountBand: 3825 },
        { source: "learned", frequencyDays: 30, amountBand: 9000 },
      ],
    };

    // A one-off 500.00 payment to a recurring vendor is nobody's recurrence.
    expect(
      expectedInvoiceWindow({ name: "ANTHROPIC", date: TX_DATE, amount: 50000 }, anthropic)
    ).toBeUndefined();
  });

  it("picks the band the charge amount belongs to", () => {
    const anthropic: QueryGenerationPartner = {
      name: "Anthropic PBC",
      effectiveCycles: [
        { source: "learned", frequencyDays: 7, amountBand: 3825, invoiceToTransactionDelay: 1, delayVariance: 0 },
        { source: "learned", frequencyDays: 30, amountBand: 9000, invoiceToTransactionDelay: 10, delayVariance: 1 },
      ],
    };

    const weekly = expectedInvoiceWindow({ name: "ANTHROPIC", date: TX_DATE, amount: 3825 }, anthropic);
    const monthly = expectedInvoiceWindow({ name: "ANTHROPIC", date: TX_DATE, amount: 9000 }, anthropic);

    expect(daysBetween(weekly!.expectedAt, TX_DATE)).toBe(1);
    expect(daysBetween(monthly!.expectedAt, TX_DATE)).toBe(10);
  });

  it("never spans more than half a period, so neighbouring charges stay apart", () => {
    const noisyWeekly: QueryGenerationPartner = {
      name: "Anthropic PBC",
      // delayVariance 5 doubled would be 10 days — wider than the 7-day period.
      effectiveCycles: [
        { source: "learned", frequencyDays: 7, invoiceToTransactionDelay: 1, delayVariance: 5 },
      ],
    };

    const window = expectedInvoiceWindow({ name: "ANTHROPIC", date: TX_DATE, amount: 3825 }, noisyWeekly);
    expect(window!.varianceDays).toBe(3);
  });

  it("centres on the transaction date when the recurrence has no learned delay", () => {
    const declaredOnly: QueryGenerationPartner = {
      name: "Magenta Telekom",
      effectiveCycles: [{ source: "declared", frequencyDays: 30 }],
    };

    const window = expectedInvoiceWindow({ name: "MAGENTA", date: TX_DATE, amount: 2999 }, declaredOnly);
    expect(window!.expectedAt.getTime()).toBe(TX_DATE.getTime());
    expect(window!.varianceDays).toBe(15);
  });

  it("yields no window without a transaction date or amount to anchor it", () => {
    expect(expectedInvoiceWindow({ name: "NOTION", amount: 1000 }, recurringPartner)).toBeUndefined();
    expect(expectedInvoiceWindow({ name: "NOTION", date: TX_DATE }, recurringPartner)).toBeUndefined();
  });
});

describe("generateSearchQueryPlan", () => {
  it("emits the date window beside the queries for a recurring partner", () => {
    const plan = generateSearchQueryPlan(
      { name: "NOTION LABS INC", partner: "Notion Labs", date: TX_DATE, amount: 1000 },
      recurringPartner
    );

    expect(plan.suggestions.length).toBeGreaterThan(0);
    expect(plan.dateWindow).toBeDefined();
    expect(daysBetween(plan.dateWindow!.expectedAt, TX_DATE)).toBe(5);
  });

  it("emits the same queries and no window for a non-recurring partner", () => {
    const plan = generateSearchQueryPlan(
      { name: "BIPA 4711", partner: "Bipa", date: TX_DATE, amount: 1000 },
      plainPartner
    );

    expect(plan.suggestions.length).toBeGreaterThan(0);
    expect(plan.dateWindow).toBeUndefined();
  });
});
