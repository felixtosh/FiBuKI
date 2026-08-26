/**
 * Billing-cycle auto-learn (yazzbert/FiBuKI-selfhost#166), run against the
 * Postgres-backed firestore shim.
 *
 * Two triggers, one shared writer:
 *   connectFileToTransaction  → re-learns that one partner, right after the
 *                               connect that changed its evidence
 *   scheduledLearnBillingCycles → nightly, every partner with 3+ charges,
 *                               exercised through the scheduler shim's run()
 *
 * Both write through learnBillingCycleForPartner, so a declared cycle
 * (#167) survives either one — that half is only ever set by the MCP tool.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";

// REAL application code, unmodified:
import { connectFileToTransactionCallable } from "../files/connectFileToTransaction";
import {
  learnBillingCyclesForAllUsers,
  scheduledLearnBillingCycles,
} from "../matching/scheduledBillingCycleLearn";

const db = getFirestore();
const USER = "stefan-test";
const OTHER_USER = "other-tenant";

/** Monthly on the 15th — intervals [31,28,31], a clean 30-day cycle. */
const MONTHLY_DATES = ["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15"];

async function seedPartner(id: string, userId = USER, extra: Record<string, unknown> = {}) {
  await db.collection("partners").doc(id).set({
    userId,
    name: `Partner ${id}`,
    aliases: [],
    ibans: [],
    isActive: true,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    ...extra,
  });
}

async function seedTx(id: string, partnerId: string, date: string, userId = USER) {
  await db.collection("transactions").doc(id).set({
    userId,
    sourceId: "src-1",
    partnerId,
    date: Timestamp.fromDate(new Date(`${date}T12:00:00Z`)),
    amount: -100,
    currency: "EUR",
    name: "Tx",
    fileIds: [],
    isComplete: false,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });
}

async function seedMonthly(partnerId: string, userId = USER, dates = MONTHLY_DATES) {
  await seedPartner(partnerId, userId);
  for (let i = 0; i < dates.length; i++) {
    await seedTx(`${partnerId}-t${i}`, partnerId, dates[i], userId);
  }
}

async function seedFile(fileId: string, partnerId: string, extractedDate: string) {
  await db.collection("files").doc(fileId).set({
    userId: USER,
    partnerId,
    fileName: `${fileId}.pdf`,
    extractedDate: Timestamp.fromDate(new Date(`${extractedDate}T12:00:00Z`)),
    transactionIds: [],
    transactionSuggestions: [],
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });
}

function connect(fileId: string, transactionId: string) {
  return connectFileToTransactionCallable.run({
    data: { fileId, transactionId },
    auth: { uid: USER },
  } as never);
}

async function billingCycleOf(partnerId: string) {
  const snap = await db.collection("partners").doc(partnerId).get();
  return snap.data()!.billingCycle as
    | { learned?: unknown[]; declared?: unknown[]; effective?: Record<string, unknown>[] }
    | undefined;
}

beforeEach(async () => {
  // Let fire-and-forget writes (usage logging) from the previous test land
  // before the reset so they can't bleed into this one.
  await new Promise((r) => setTimeout(r, 20));
  await __resetFirestoreShim();
  __resetTriggerShim();
});

// ============================================================================
// Post-connect
// ============================================================================

describe("auto-learn after a file connects", () => {
  it("learns the partner's cycle as part of the connect", async () => {
    await seedMonthly("p-connect");
    await seedFile("f-invoice", "p-connect", "2026-01-10");

    const res = await connect("f-invoice", "p-connect-t0");
    await drainTriggers();

    expect(res.success).toBe(true);
    const cycle = await billingCycleOf("p-connect");
    expect(cycle!.learned).toHaveLength(1);
    expect(cycle!.effective![0]).toMatchObject({ source: "learned", frequencyDays: 30 });
  });

  it("leaves a declared cycle in charge — the re-learn only rewrites learned/effective", async () => {
    await seedMonthly("p-declared");
    await db.collection("partners").doc("p-declared").update({
      billingCycle: {
        declared: [{ frequencyDays: 30, documentExpectation: "invoice" }],
        learned: [],
        effective: [],
      },
    });
    await seedFile("f-declared", "p-declared", "2026-01-10");

    await connect("f-declared", "p-declared-t0");
    await drainTriggers();

    const cycle = await billingCycleOf("p-declared");
    expect(cycle!.declared).toEqual([{ frequencyDays: 30, documentExpectation: "invoice" }]);
    expect(cycle!.learned).toHaveLength(1);
    // Declared wins in the effective view, enriched by what was just learned.
    expect(cycle!.effective![0]).toMatchObject({
      source: "declared",
      frequencyDays: 30,
      typicalDayOfMonth: 15,
    });
  });

  it("still connects when the partner has too little history to learn from", async () => {
    await seedPartner("p-thin");
    await seedTx("p-thin-t0", "p-thin", "2026-01-15");
    await seedTx("p-thin-t1", "p-thin", "2026-02-15");
    await seedFile("f-thin", "p-thin", "2026-01-10");

    const res = await connect("f-thin", "p-thin-t0");
    await drainTriggers();

    expect(res.success).toBe(true);
    expect(res.alreadyConnected).toBe(false);
    expect(await billingCycleOf("p-thin")).toBeUndefined();
    // The connection itself is intact.
    const tx = (await db.collection("transactions").doc("p-thin-t0").get()).data()!;
    expect(tx.fileIds).toEqual(["f-thin"]);
  });

  it("learns nothing for a transaction with no partner", async () => {
    await db.collection("transactions").doc("t-orphan").set({
      userId: USER,
      sourceId: "src-1",
      date: Timestamp.fromDate(new Date("2026-01-15T12:00:00Z")),
      amount: -100,
      fileIds: [],
      createdAt: Timestamp.now(),
    });
    await db.collection("files").doc("f-orphan").set({
      userId: USER,
      fileName: "f-orphan.pdf",
      transactionIds: [],
      createdAt: Timestamp.now(),
    });

    const res = await connect("f-orphan", "t-orphan");
    await drainTriggers();

    expect(res.success).toBe(true);
  });
});

// ============================================================================
// Nightly
// ============================================================================

describe("nightly billing-cycle learn", () => {
  it("walks every partner with 3+ transactions, per user, and skips the rest", async () => {
    await seedMonthly("p-night");
    await seedMonthly("p-night-other", OTHER_USER);
    // Two charges only — below the threshold, never learned.
    await seedPartner("p-night-thin");
    await seedTx("p-night-thin-t0", "p-night-thin", "2026-01-15");
    await seedTx("p-night-thin-t1", "p-night-thin", "2026-02-15");
    // Enough charges, but irregular — walked, and yields no cycle.
    await seedMonthly("p-night-random", USER, ["2026-01-01", "2026-01-11", "2026-04-21"]);
    await drainTriggers();

    const result = await learnBillingCyclesForAllUsers();

    expect(result).toEqual({ users: 2, eligible: 3, learned: 2 });
    expect((await billingCycleOf("p-night"))!.effective![0]).toMatchObject({
      source: "learned",
      frequencyDays: 30,
    });
    expect((await billingCycleOf("p-night-other"))!.effective![0]).toMatchObject({
      source: "learned",
      frequencyDays: 30,
    });
    expect(await billingCycleOf("p-night-thin")).toBeUndefined();
    expect(await billingCycleOf("p-night-random")).toBeUndefined();
  });

  it("runs directly through the scheduler shim", async () => {
    await seedMonthly("p-shim");
    await drainTriggers();

    await scheduledLearnBillingCycles.run({
      jobName: "scheduledLearnBillingCycles",
      scheduleTime: "2026-08-22T01:00:00Z",
    } as never);

    expect((await billingCycleOf("p-shim"))!.learned).toHaveLength(1);
  });

  it("makes no AI call — history only", async () => {
    await seedMonthly("p-no-ai");
    await drainTriggers();

    // Every AI provider behind the vertexai adapter goes out over global
    // fetch, and every model call is billed through the aiUsage collection.
    // Neither may move for a nightly pass over the whole book.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await learnBillingCyclesForAllUsers();
    } finally {
      fetchSpy.mockRestore();
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await db.collection("aiUsage").get()).empty).toBe(true);
    expect((await billingCycleOf("p-no-ai"))!.learned).toHaveLength(1);
  });
});
