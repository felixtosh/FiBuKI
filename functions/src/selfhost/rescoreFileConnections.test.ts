/**
 * Re-score-on-learn characterization (yazzbert/FiBuKI-selfhost#168), run
 * against the Postgres-backed firestore shim like the sibling
 * matching-characterization.test.ts.
 *
 * Covers rescoreFileConnectionsForPartner's wiring into
 * learnBillingCycleCallable: once a cycle is learned, a same-amount file
 * connected to more than one transaction of that partner must re-rank so the
 * charge matching its expected invoice date scores highest, while
 * connectionType and the connections themselves are never touched.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";

// REAL application code, unmodified:
import { learnBillingCycleCallable } from "../matching/learnBillingCycle";

const db = getFirestore();
const USER = "stefan-test";

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

async function seedTx(id: string, partnerId: string, date: string, amount: number) {
  await db.collection("transactions").doc(id).set({
    userId: USER,
    sourceId: "src-1",
    partnerId,
    date: Timestamp.fromDate(new Date(date)),
    amount,
    currency: "EUR",
    name: "Tx",
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });
}

async function seedFile(id: string, partnerId: string, extractedDate: string, extractedAmount: number) {
  await db.collection("files").doc(id).set({
    userId: USER,
    partnerId,
    extractedDate: Timestamp.fromDate(new Date(extractedDate)),
    extractedAmount,
    extractedCurrency: "EUR",
    fileName: `${id}.pdf`,
    createdAt: Timestamp.now(),
  });
}

async function seedConnection(
  id: string,
  fileId: string,
  transactionId: string,
  connectionType: string,
  matchConfidence: number
) {
  await db.collection("fileConnections").doc(id).set({
    userId: USER,
    fileId,
    transactionId,
    connectionType,
    matchConfidence,
    scoreBreakdown: { amount: 40, date: 8, partner: 0, iban: 0, reference: 0, hint: 0 },
    createdAt: Timestamp.now(),
  });
}

beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 20));
  await __resetFirestoreShim();
  __resetTriggerShim();
});

describe("rescoreFileConnectionsForPartner (via learnBillingCycleCallable)", () => {
  it("re-ranks a same-amount file connected to two transactions after the cycle is learned", async () => {
    await seedPartner("p-rs1");

    // Weekly cadence, four charges of 3825 → frequencyDays=7 learned cleanly.
    const dates = ["2026-06-01", "2026-06-08", "2026-06-15", "2026-06-22"];
    for (let i = 0; i < dates.length; i++) {
      await seedTx(`rs1-t${i}`, "p-rs1", `${dates[i]}T12:00:00Z`, 3825);
    }
    // 3 invoices, each 3 days before its charge — clean delay=3, variance=0.
    for (let i = 0; i < 3; i++) {
      const invoiceDate = ["2026-05-29", "2026-06-05", "2026-06-12"][i];
      await seedFile(`rs1-delay-f${i}`, "p-rs1", `${invoiceDate}T12:00:00Z`, 3825);
      await db.collection("fileConnections").doc(`rs1-delay-conn${i}`).set({
        userId: USER,
        fileId: `rs1-delay-f${i}`,
        transactionId: `rs1-t${i}`,
        createdAt: Timestamp.now(),
      });
    }

    // The disambiguation case: one file, dated 2026-06-12 (3 days before
    // t2's 06-15), sits connected to BOTH t1 (06-08, one period early) and
    // t2 (06-15, its actual charge) — the INCW9PTA shape, minimal version.
    await seedFile("rs1-target-f", "p-rs1", "2026-06-12T12:00:00Z", 3825);
    await seedConnection("rs1-conn-t1", "rs1-target-f", "rs1-t1", "auto_matched", 80);
    await seedConnection("rs1-conn-t2", "rs1-target-f", "rs1-t2", "manual", 80);
    await drainTriggers();

    const res = await callCycle("p-rs1");
    expect(res.billingCycle).toMatchObject({ frequencyDays: 7 });

    const connT1 = (await db.collection("fileConnections").doc("rs1-conn-t1").get()).data()!;
    const connT2 = (await db.collection("fileConnections").doc("rs1-conn-t2").get()).data()!;

    // t2 is the real charge (file dated 3 days before it, matching the
    // learned delay) — t1 is one whole period earlier and must rank behind
    // it after re-score. The target file's own contested connections feed
    // back into delay learning too (getInvoiceDates has no way to know
    // which of its own connections are "correct"), so the exact learned
    // delay/variance isn't pinned here — only the ranking the AC requires.
    expect(connT2.scoreBreakdown.date).toBeGreaterThan(connT1.scoreBreakdown.date);
    expect(connT2.matchConfidence).toBeGreaterThan(connT1.matchConfidence);

    // Re-scoring updates confidence/breakdown only — connection identity and
    // type (manual vs auto) are never touched.
    expect(connT1.connectionType).toBe("auto_matched");
    expect(connT2.connectionType).toBe("manual");
    expect(connT1.fileId).toBe("rs1-target-f");
    expect(connT2.fileId).toBe("rs1-target-f");
  });

  it("leaves connections untouched when fewer than 3 transactions (no cycle learned)", async () => {
    await seedPartner("p-rs2");
    await seedTx("rs2-t0", "p-rs2", "2026-01-15T12:00:00Z", 3825);
    await seedTx("rs2-t1", "p-rs2", "2026-02-15T12:00:00Z", 3825);
    await seedFile("rs2-f0", "p-rs2", "2026-01-12T12:00:00Z", 3825);
    await seedConnection("rs2-conn0", "rs2-f0", "rs2-t0", "auto_matched", 80);
    await drainTriggers();

    const res = await callCycle("p-rs2");
    expect(res.billingCycle).toBeNull();

    const conn = (await db.collection("fileConnections").doc("rs2-conn0").get()).data()!;
    expect(conn.matchConfidence).toBe(80);
    expect(conn.scoreBreakdown).toMatchObject({ amount: 40, date: 8, partner: 0 });
  });
});
