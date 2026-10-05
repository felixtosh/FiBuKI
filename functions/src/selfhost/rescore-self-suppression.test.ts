/**
 * #644: a connected pair is never judged a duplicate of itself.
 *
 * The documentation rule (#104) suppresses a File whose class the Transaction
 * already holds. The stored `documentationState` is derived from every File on
 * the Transaction, so for a pair that is already connected it includes the
 * scored File: the billing-cycle re-score stored confidence 0 for every
 * connected pair of the Partner, and the agent's score tool answered 0 for a
 * connected pair named by id. The matcher now derives the state from the
 * Transaction's Files other than the scored one.
 *
 * Fixtures derive `documentationState` with `deriveForTransaction`, as the
 * Transaction trigger stores it; without one the scorer skips the rule and
 * none of this shows.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// The recurrence check asks a model whether the Partner bills on a schedule.
// This one does; the check itself is covered by recurrenceCheck.test.ts.
vi.mock("../matching/recurrenceCheck", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../matching/recurrenceCheck")>();
  const { Timestamp } = await import("firebase-admin/firestore");
  return {
    ...actual,
    checkRecurrence: vi.fn(async (_userId: string, _partnerId: string, input: Parameters<typeof actual.recurrenceKey>[0]) => ({
      recurring: true,
      reason: "test",
      key: actual.recurrenceKey(input),
      model: "test",
      checkedAt: Timestamp.now(),
    })),
  };
});

import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";

import { learnBillingCycleCallable } from "../matching/learnBillingCycle";
import { scorePair } from "../matching/matcher";
import { scoreFileTransactionMatchCallable } from "../matching/scoreFileTransactionMatchCallable";
import { deriveForTransaction } from "../documents/syncDocumentationState";
import { repairRescoredConnections } from "../matching/repairRescoredConnections";

const db = getFirestore();
const USER = "rescore-644";
const PARTNER = "p-644";
const AMOUNT = 4000;
const CHARGES = ["2026-06-01", "2026-06-08", "2026-06-15", "2026-06-22"];

const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));
/** Three days before the charge: the delay the cycle learns. */
const invoiceDay = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 3);
  return d.toISOString().slice(0, 10);
};

async function seedTx(id: string, date: string) {
  await db.collection("transactions").doc(id).set({
    userId: USER,
    sourceId: "src-1",
    partnerId: PARTNER,
    date: day(date),
    amount: -AMOUNT,
    currency: "EUR",
    name: "ANTHROPIC PBC",
    partner: "Anthropic PBC",
    fileIds: [],
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });
}

async function seedFile(id: string, date: string) {
  await db.collection("files").doc(id).set({
    userId: USER,
    partnerId: PARTNER,
    documentType: "invoice",
    extractedDate: day(date),
    extractedAmount: AMOUNT,
    extractedCurrency: "EUR",
    extractedPartner: "Anthropic PBC",
    extractionComplete: true,
    transactionIds: [],
    fileName: `${id}.pdf`,
    createdAt: Timestamp.now(),
  });
}

/** A File Connection with both lists, and the Transaction's state derived as the trigger stores it. */
async function connect(connectionId: string, fileId: string, transactionId: string) {
  await db.collection("fileConnections").doc(connectionId).set({
    userId: USER,
    fileId,
    transactionId,
    connectionType: "manual",
    matchConfidence: 80,
    createdAt: Timestamp.now(),
  });
  const fileRef = db.collection("files").doc(fileId);
  const txRef = db.collection("transactions").doc(transactionId);
  const file = (await fileRef.get()).data()!;
  const tx = (await txRef.get()).data()!;
  await fileRef.update({ transactionIds: [...((file.transactionIds as string[] | undefined) ?? []), transactionId] });
  const fileIds = [...((tx.fileIds as string[] | undefined) ?? []), fileId];
  await txRef.update({ fileIds });
  await txRef.update({ documentationState: await deriveForTransaction(db as never, { fileIds }) });
}

/** Four weekly charges of the same amount, each connected to its own invoice (the #597 shape). */
async function seedPartnerWithConnectedInvoices() {
  await db.collection("partners").doc(PARTNER).set({
    userId: USER,
    name: "Anthropic PBC",
    aliases: [],
    ibans: [],
    isActive: true,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });
  for (let i = 0; i < CHARGES.length; i++) {
    await seedTx(`t${i}`, CHARGES[i]);
    await seedFile(`f${i}`, invoiceDay(CHARGES[i]));
    await connect(`c${i}`, `f${i}`, `t${i}`);
  }
  await drainTriggers();
}

const learnCycle = () =>
  learnBillingCycleCallable.run({ data: { partnerId: PARTNER }, auth: { uid: USER } } as never);
const fileOf = async (id: string) => ({ id, data: (await db.collection("files").doc(id).get()).data()! });
const txOf = (id: string) => db.collection("transactions").doc(id).get();
const connectionOf = async (id: string) => (await db.collection("fileConnections").doc(id).get()).data()!;

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
  await seedPartnerWithConnectedInvoices();
});

describe("the billing-cycle re-score of a connected pair (#644)", () => {
  it("stores the scorer's real confidence, not the 0 of a self-duplicate", async () => {
    // The fixture is the bug's shape: each Transaction's own invoice made it `invoice`.
    expect((await txOf("t0")).data()!.documentationState).toBe("invoice");

    const res = await learnCycle();
    expect(res.billingCycle).toMatchObject({ frequencyDays: 7 });

    for (let i = 0; i < CHARGES.length; i++) {
      const connection = await connectionOf(`c${i}`);
      expect(connection.rescoredAt, `c${i} re-scored`).toBeDefined();
      expect(connection.matchConfidence, `c${i}`).toBeGreaterThan(0);
    }
  });

  it("stores what the matcher scores for the same pair (parity)", async () => {
    await learnCycle();
    for (let i = 0; i < CHARGES.length; i++) {
      const connection = await connectionOf(`c${i}`);
      const { match } = await scorePair(db as never, USER, await fileOf(`f${i}`), (await txOf(`t${i}`)) as never);
      expect(connection.matchConfidence, `c${i}`).toBe(match.confidence);
      expect(connection.scoreBreakdown, `c${i}`).toEqual(match.breakdown);
    }
  });

  it("still suppresses a pair whose Transaction holds another invoice (decided on #644)", async () => {
    // Two invoices on one line: the other one keeps the state at `invoice`,
    // so the rule says what it says. The Copy and Invoice Correction work
    // resolves a Transaction documented twice.
    await seedFile("f-second", invoiceDay(CHARGES[1]));
    await connect("c-second", "f-second", "t1");
    await drainTriggers();

    await learnCycle();
    const connection = await connectionOf("c-second");
    expect(connection.rescoredAt).toBeDefined();
    expect(connection.matchConfidence).toBe(0);
  });
});

describe("a pair scored by id (#644)", () => {
  it("does not suppress a connected pair because of its own File (the agent's score tool)", async () => {
    const r = (await scoreFileTransactionMatchCallable.run({
      data: { fileId: "f2", transactionId: "t2" },
      auth: { uid: USER, token: {} },
    } as never)) as { confidence: number };
    expect(r.confidence).toBeGreaterThan(0);
  });

  it("still suppresses a second invoice that is not on the Transaction (#104 unchanged)", async () => {
    await seedFile("f-candidate", invoiceDay(CHARGES[2]));
    await drainTriggers();
    const { match } = await scorePair(db as never, USER, await fileOf("f-candidate"), (await txOf("t2")) as never);
    expect(match.documentation).toMatchObject({ outcome: "suppressed", reason: "duplicate-document-class" });
    expect(match.documentation!.confidenceBefore).toBeGreaterThan(0);
    expect(match.confidence).toBe(0);
  });
});

describe("the one-time repair of the records the bug wrote (#644)", () => {
  /** What the re-score stored before the fix: 0 beside a full-confidence breakdown. */
  async function writtenByTheBug(connectionId: string) {
    await db.collection("fileConnections").doc(connectionId).update({
      matchConfidence: 0,
      scoreBreakdown: { amount: 40, date: 37, partner: 25, hardFacts: 20 },
      matchSources: ["amount_exact"],
      rescoredAt: Timestamp.now(),
    });
  }

  beforeEach(async () => {
    await writtenByTheBug("c0");
    await writtenByTheBug("c1");
  });

  it("reports in a dry run and writes nothing", async () => {
    const report = await repairRescoredConnections(db as never, { apply: false });
    expect(report.recordsScanned).toBe(2);
    expect(report.changed.map((c) => c.connectionId).sort()).toEqual(["c0", "c1"]);
    expect(report.raisedFromZero).toBe(2);
    expect(report.written).toBe(0);
    expect((await connectionOf("c0")).matchConfidence).toBe(0);
  });

  it("stores the matcher's score through the writer, and leaves records without rescoredAt alone", async () => {
    const report = await repairRescoredConnections(db as never, { apply: true });
    expect(report.written).toBe(2);
    for (const id of ["c0", "c1"]) {
      const connection = await connectionOf(id);
      const i = Number(id.slice(1));
      const { match } = await scorePair(db as never, USER, await fileOf(`f${i}`), (await txOf(`t${i}`)) as never);
      expect(connection.matchConfidence).toBeGreaterThan(0);
      expect(connection.matchConfidence).toBe(match.confidence);
      expect(connection.scoreBreakdown).toEqual(match.breakdown);
      // The pair itself is never touched.
      expect(connection.connectionType).toBe("manual");
    }
    // Never re-scored, so not the repair's to touch.
    expect(await connectionOf("c2")).toMatchObject({ matchConfidence: 80 });
    expect((await connectionOf("c2")).rescoredAt).toBeUndefined();
  });

  it("is idempotent: a second run writes nothing", async () => {
    await repairRescoredConnections(db as never, { apply: true });
    const again = await repairRescoredConnections(db as never, { apply: true });
    expect(again.recordsScanned).toBe(2);
    expect(again.changed).toEqual([]);
    expect(again.unchanged).toBe(2);
    expect(again.written).toBe(0);
  });
});
