/**
 * CHARACTERIZATION TESTS — learning callables of the matching engine, run
 * UNMODIFIED against the Postgres-backed firestore shim.
 *
 * Pins the exact outputs of:
 *   learnScoringWeightsCallable — per-partner weight learning from
 *     fileConnection scoreBreakdowns (all computeWeight tiers)
 *   learnBillingCycleCallable   — interval mode detection, confidence
 *     formula, day-of-month stats (including the common-period `>=`
 *     override quirk that relabels a 12-day cycle as 14 days)
 *
 * These pin CURRENT behavior for the rewrite — do not "fix" expected values.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";

// REAL application code, unmodified:
import { learnScoringWeightsCallable } from "../matching/learnScoringWeights";
import { learnBillingCycleCallable } from "../matching/learnBillingCycle";

const db = getFirestore();
const USER = "stefan-test";

function callWeights(partnerId: string) {
  return learnScoringWeightsCallable.run({ data: { partnerId }, auth: { uid: USER } } as never);
}

function callCycle(partnerId: string) {
  return learnBillingCycleCallable.run({ data: { partnerId }, auth: { uid: USER } } as never);
}

async function seedPartner(id: string) {
  await db.collection("partners").doc(id).set({
    userId: USER,
    name: `Partner ${id}`,
    aliases: [],
    ibans: [],
    isActive: true,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });
}

async function seedTx(
  id: string,
  partnerId: string,
  date: string,
  extra: Record<string, unknown> = {}
) {
  await db.collection("transactions").doc(id).set({
    userId: USER,
    sourceId: "src-1",
    partnerId,
    date: Timestamp.fromDate(new Date(date)),
    amount: -100,
    currency: "EUR",
    name: "Tx",
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    ...extra,
  });
}

async function seedConnection(
  id: string,
  fileId: string,
  transactionId: string,
  scoreBreakdown: { amount: number; date: number; partner: number } | null
) {
  await db.collection("fileConnections").doc(id).set({
    userId: USER,
    fileId,
    transactionId,
    createdAt: Timestamp.now(),
    ...(scoreBreakdown ? { scoreBreakdown } : {}),
  });
}

/**
 * Invoice file for the billing-cycle delay computation: computeInvoiceDelays
 * only counts files that carry the partnerId AND an extractedDate, reached
 * through a fileConnection on one of the partner's transactions.
 */
async function seedInvoiceFile(fileId: string, partnerId: string, extractedDate: string) {
  await db.collection("files").doc(fileId).set({
    userId: USER,
    partnerId,
    extractedDate: Timestamp.fromDate(new Date(extractedDate)),
    fileName: `${fileId}.pdf`,
    createdAt: Timestamp.now(),
  });
}

beforeEach(async () => {
  // Let fire-and-forget writes (usage logging) from the previous test land
  // before the reset so they can't bleed into this one.
  await new Promise((r) => setTimeout(r, 20));
  await __resetFirestoreShim();
  __resetTriggerShim();
});

// ============================================================================
// learnScoringWeights
// ============================================================================

describe("characterization: learnScoringWeightsCallable", () => {
  it("computes tiered weights from correct vs rejected breakdowns (1.0 / 1.3 / 0.5)", async () => {
    await seedPartner("p-w1");
    // Rejections come from BOTH rejectedFileIds and rejectedFiles records
    await seedTx("t1", "p-w1", "2026-01-10T12:00:00Z", { rejectedFileIds: ["f-bad"] });
    await seedTx("t2", "p-w1", "2026-02-10T12:00:00Z", { rejectedFiles: [{ fileId: "f-bad2" }] });
    await seedTx("t3", "p-w1", "2026-03-10T12:00:00Z");

    // 4 correct connections: amount 40, date 20, partner 0
    await seedConnection("c1", "f1", "t1", { amount: 40, date: 20, partner: 0 });
    await seedConnection("c2", "f2", "t2", { amount: 40, date: 20, partner: 0 });
    await seedConnection("c3", "f3", "t3", { amount: 40, date: 20, partner: 0 });
    await seedConnection("c4", "f4", "t3", { amount: 40, date: 20, partner: 0 });
    // 2 rejected connections: amount 40, date 5, partner 20
    await seedConnection("c5", "f-bad", "t1", { amount: 40, date: 5, partner: 20 });
    await seedConnection("c6", "f-bad2", "t2", { amount: 40, date: 5, partner: 20 });
    // Connection WITHOUT scoreBreakdown must be ignored entirely
    await seedConnection("c7", "f7", "t3", null);
    await drainTriggers();

    const res = await callWeights("p-w1");

    // amount: avg 40 vs 40 → ratio 1 → 1.0 (not discriminating)
    // date:   avg 20 vs 5  → ratio 4 > 2 → 1.3 (strong discriminator)
    // partner: avgCorrect 0, avgIncorrect 20 → max(0.5, 1 - 20/40) = 0.5
    expect(res.success).toBe(true);
    expect(res.weights).toMatchObject({
      amountWeight: 1.0,
      dateWeight: 1.3,
      partnerWeight: 0.5,
      sampleSize: 6, // c7 (no breakdown) not counted
    });

    // Weights are persisted on the partner document
    const partner = (await db.collection("partners").doc("p-w1").get()).data()!;
    expect(partner.scoringWeights).toMatchObject({
      amountWeight: 1.0,
      dateWeight: 1.3,
      partnerWeight: 0.5,
      sampleSize: 6,
    });
  });

  it("all-correct history uses the avgIncorrect==0 branch: min(1.5, 1 + avg/40)", async () => {
    await seedPartner("p-w2");
    await seedTx("t-w2", "p-w2", "2026-01-10T12:00:00Z");
    for (let i = 1; i <= 5; i++) {
      await seedConnection(`w2-c${i}`, `w2-f${i}`, "t-w2", { amount: 30, date: 10, partner: 0 });
    }
    await drainTriggers();

    const res = await callWeights("p-w2");
    // amount: min(1.5, 1 + 30/40) = 1.5 (capped)
    // date:   1 + 10/40 = 1.25
    // partner: both averages 0 → 1.0
    expect(res.weights).toMatchObject({
      amountWeight: 1.5,
      dateWeight: 1.25,
      partnerWeight: 1.0,
      sampleSize: 5,
    });
  });

  it("moderate ratios hit the 0.7 / 0.85 / 1.15 tiers", async () => {
    await seedPartner("p-w3");
    await seedTx("t-w3a", "p-w3", "2026-01-10T12:00:00Z", { rejectedFileIds: ["w3-bad1", "w3-bad2"] });
    // 3 correct: amount 10, date 15, partner 18
    await seedConnection("w3-c1", "w3-f1", "t-w3a", { amount: 10, date: 15, partner: 18 });
    await seedConnection("w3-c2", "w3-f2", "t-w3a", { amount: 10, date: 15, partner: 18 });
    await seedConnection("w3-c3", "w3-f3", "t-w3a", { amount: 10, date: 15, partner: 18 });
    // 2 rejected: amount 25, date 24, partner 10
    await seedConnection("w3-c4", "w3-bad1", "t-w3a", { amount: 25, date: 24, partner: 10 });
    await seedConnection("w3-c5", "w3-bad2", "t-w3a", { amount: 25, date: 24, partner: 10 });
    await drainTriggers();

    const res = await callWeights("p-w3");
    // amount: 10/25 = 0.4  < 0.5  → 0.7  (misleading)
    // date:   15/24 = 0.625 < 0.75 → 0.85 (slightly misleading)
    // partner: 18/10 = 1.8 > 1.5  → 1.15 (moderately discriminating)
    expect(res.weights).toMatchObject({
      amountWeight: 0.7,
      dateWeight: 0.85,
      partnerWeight: 1.15,
      sampleSize: 5,
    });
  });

  it("returns null weights below the 5-sample minimum and with no transactions", async () => {
    await seedPartner("p-w4");
    await seedTx("t-w4", "p-w4", "2026-01-10T12:00:00Z");
    for (let i = 1; i <= 4; i++) {
      await seedConnection(`w4-c${i}`, `w4-f${i}`, "t-w4", { amount: 40, date: 20, partner: 0 });
    }
    await seedPartner("p-w5"); // no transactions at all
    await drainTriggers();

    expect((await callWeights("p-w4")).weights).toBeNull();
    expect((await callWeights("p-w5")).weights).toBeNull();
    // Nothing stored when below the minimum
    const partner = (await db.collection("partners").doc("p-w4").get()).data()!;
    expect(partner.scoringWeights).toBeUndefined();
  });
});

// ============================================================================
// learnBillingCycle
// ============================================================================

describe("characterization: learnBillingCycleCallable", () => {
  it("detects a monthly cycle: mode 30, confidence 98, day 15, variance 0", async () => {
    await seedPartner("p-c1");
    // Monthly on the 15th, Jan–Jun 2026 → intervals [31,28,31,30,31]
    const dates = ["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15", "2026-05-15", "2026-06-15"];
    for (let i = 0; i < dates.length; i++) {
      await seedTx(`c1-t${i}`, "p-c1", `${dates[i]}T12:00:00Z`);
    }
    // 3 invoices, each extracted 5 days before its transaction → delays
    // [5,5,5], the minimum sample for the delay fields to be learned.
    for (let i = 0; i < 3; i++) {
      const invoiceDate = ["2026-01-10", "2026-02-10", "2026-03-10"][i];
      await seedInvoiceFile(`c1-f${i}`, "p-c1", `${invoiceDate}T12:00:00Z`);
      await seedConnection(`c1-conn${i}`, `c1-f${i}`, `c1-t${i}`, null);
    }
    await drainTriggers();

    const res = await callCycle("p-c1");
    // consistency 5/5 = 1 → 80; avg deviation (1+2+1+0+1)/5 = 1 → +18 → 98
    expect(res.success).toBe(true);
    expect(res.billingCycle).toMatchObject({
      frequencyDays: 30,
      frequencyConfidence: 98,
      typicalDayOfMonth: 15,
      dayVariance: 0,
      sampleSize: 6,
      invoiceToTransactionDelay: 5,
      delayVariance: 0,
    });

    const partner = (await db.collection("partners").doc("p-c1").get()).data()!;
    expect(partner.billingCycle).toMatchObject({ frequencyDays: 30, frequencyConfidence: 98 });
  });

  // characterization: the common-period loop uses `>=` when comparing match
  // counts, so a true 12-day cycle (center bucket 10) is overwritten first by
  // period 7, then by period 14 — the stored cycle says 14 days, not 12.
  it("relabels a perfect 12-day cycle as a 14-day cycle (common-period >= override)", async () => {
    await seedPartner("p-c2");
    const dates = ["2026-01-01", "2026-01-13", "2026-01-25", "2026-02-06"]; // intervals [12,12,12]
    for (let i = 0; i < dates.length; i++) {
      await seedTx(`c2-t${i}`, "p-c2", `${dates[i]}T12:00:00Z`);
    }
    // 3 delays of 3 days each — the minimum sample for delay learning.
    for (let i = 0; i < 3; i++) {
      const invoiceDate = ["2025-12-29", "2026-01-10", "2026-01-22"][i];
      await seedInvoiceFile(`c2-f${i}`, "p-c2", `${invoiceDate}T12:00:00Z`);
      await seedConnection(`c2-conn${i}`, `c2-f${i}`, `c2-t${i}`, null);
    }
    await drainTriggers();

    const res = await callCycle("p-c2");
    // avg deviation |12-14| = 2 → confidence round(1*80 + 20 - 4) = 96
    expect(res.billingCycle).toMatchObject({
      frequencyDays: 14, // characterization: preserves current behavior (true cycle is 12)
      frequencyConfidence: 96,
      typicalDayOfMonth: 1, // mode of [1,13,25,6] — all tied, first wins
      dayVariance: 9, // round(sqrt(324.75 / 4)) = round(9.01)
      sampleSize: 4,
      invoiceToTransactionDelay: 3,
      delayVariance: 0,
    });
  });

  // Regression guard for a former REAL BUG (fixed 2026-07-19): with fewer
  // than 3 computable invoice delays (no file connections — the common
  // case), invoiceToTransactionDelay/delayVariance used to reach the
  // partner write as `undefined`, which firebase-admin rejects — the
  // callable 500'd for every such partner. The fields are now omitted
  // entirely and the cycle is still learned.
  it("learns the cycle without delay fields when fewer than 3 invoice delays exist", async () => {
    await seedPartner("p-c6");
    const dates = ["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15"];
    for (let i = 0; i < dates.length; i++) {
      await seedTx(`c6-t${i}`, "p-c6", `${dates[i]}T12:00:00Z`);
    }
    await drainTriggers();

    const res = await callCycle("p-c6");
    // intervals [31,28,31] → common period 30; avg deviation 4/3 → 80 + (20 - 8/3) → 97
    expect(res.success).toBe(true);
    expect(res.billingCycle).toMatchObject({
      frequencyDays: 30,
      frequencyConfidence: 97,
      typicalDayOfMonth: 15,
      dayVariance: 0,
      sampleSize: 4,
    });
    const partner = (await db.collection("partners").doc("p-c6").get()).data()!;
    const stored = partner.billingCycle as Record<string, unknown>;
    expect(stored.frequencyDays).toBe(30);
    // The unlearned delay fields are ABSENT, not null/undefined-written.
    expect("invoiceToTransactionDelay" in stored).toBe(false);
    expect("delayVariance" in stored).toBe(false);
  });

  it("returns null with fewer than 3 transactions", async () => {
    await seedPartner("p-c3");
    await seedTx("c3-t0", "p-c3", "2026-01-15T12:00:00Z");
    await seedTx("c3-t1", "p-c3", "2026-02-15T12:00:00Z");
    await drainTriggers();

    expect((await callCycle("p-c3")).billingCycle).toBeNull();
  });

  it("returns null when all transactions share one date (zero intervals filtered)", async () => {
    await seedPartner("p-c4");
    await seedTx("c4-t0", "p-c4", "2026-01-15T12:00:00Z");
    await seedTx("c4-t1", "p-c4", "2026-01-15T12:00:00Z");
    await seedTx("c4-t2", "p-c4", "2026-01-15T12:00:00Z");
    await drainTriggers();

    expect((await callCycle("p-c4")).billingCycle).toBeNull();
  });

  it("returns null for irregular intervals (mode count < 3)", async () => {
    await seedPartner("p-c5");
    await seedTx("c5-t0", "p-c5", "2026-01-01T12:00:00Z");
    await seedTx("c5-t1", "p-c5", "2026-01-11T12:00:00Z"); // +10
    await seedTx("c5-t2", "p-c5", "2026-04-21T12:00:00Z"); // +100
    await drainTriggers();

    expect((await callCycle("p-c5")).billingCycle).toBeNull();
  });
});
