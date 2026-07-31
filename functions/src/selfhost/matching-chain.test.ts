/**
 * Spike test 2 — THE GATE 3 TEST.
 *
 * The crown-jewel matching engine (matchFilePartner 1.4k LOC +
 * matchFileTransactions 1.2k LOC), imported UNMODIFIED, must run its
 * trigger-chained pipeline on the Postgres-backed shim:
 *
 *   files/{id} update (extractionComplete: false→true)
 *     → matchFilePartner   (deterministic IBAN match → partnerId set,
 *                           partnerMatchComplete: true)
 *     → matchFileTransactions (scores vs transactions → suggestions and/or
 *                           fileConnections, transactionMatchComplete: true)
 *
 * User is seeded in PASSIVE automation mode so AI-powered steps skip by
 * design (production self-host repoints those to Claude/local models) and
 * the deterministic scoring path is what's under test.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";

// REAL trigger modules, unmodified:
import "../matching/matchFilePartner";
import "../matching/matchFileTransactions";

const db = getFirestore();
const USER = "stefan-test";
const IBAN = "AT61 1904 3002 3457 3201";

async function seedBase() {
  // Passive mode: deterministic matching only, AI steps skip.
  await db.collection("subscriptions").doc(USER).set({
    userId: USER,
    automationMode: "passive",
    planId: "free",
  });

  await db.collection("partners").doc("p-hetzner").set({
    userId: USER,
    name: "Hetzner Online GmbH",
    aliases: ["Hetzner"],
    ibans: [IBAN],
    isActive: true,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });

  await db.collection("sources").doc("src-n26").set({
    userId: USER,
    name: "N26 Business",
    iban: "DE89370400440532013000",
    currency: "EUR",
    type: "manual",
    isActive: true,
  });

  await db.collection("transactions").doc("t-hetzner").set({
    userId: USER,
    sourceId: "src-n26",
    date: Timestamp.fromDate(new Date("2026-07-01")),
    amount: -119.0,
    currency: "EUR",
    name: "Hetzner Online GmbH",
    partner: "Hetzner Online GmbH",
    partnerIban: IBAN,
    reference: "Invoice R0011223344",
    dedupeHash: "hash-hetzner-1",
    fileIds: [],
    isComplete: false,
    partnerId: null,
    partnerType: null,
    partnerSuggestions: [],
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });

  // File as extractFileData would leave it just BEFORE completion flips.
  await db.collection("files").doc("f-invoice").set({
    userId: USER,
    fileName: "hetzner-r0011223344.pdf",
    fileType: "application/pdf",
    fileSize: 52341,
    storagePath: `files/${USER}/hetzner.pdf`,
    extractionComplete: false,
    transactionIds: [],
    uploadedAt: Timestamp.now(),
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });
}

async function completeExtraction() {
  await db.collection("files").doc("f-invoice").update({
    extractionComplete: true,
    extractedPartner: "Hetzner Online GmbH",
    extractedIban: IBAN,
    extractedAmount: 119.0,
    extractedCurrency: "EUR",
    extractedDate: Timestamp.fromDate(new Date("2026-07-01")),
    extractedText: "Hetzner Online GmbH Rechnung R0011223344 119,00 EUR",
    updatedAt: Timestamp.now(),
  });
  await drainTriggers();
}

beforeEach(async () => {
  await __resetFirestoreShim();
  __resetTriggerShim();
  await seedBase();
});

describe("selfhost spike GATE 3: matching engine chain on firestore-pg shim", () => {
  it("matchFilePartner matches the partner deterministically by IBAN", async () => {
    await completeExtraction();

    const file = (await db.collection("files").doc("f-invoice").get()).data()!;
    expect(file.partnerMatchComplete).toBe(true);
    expect(file.partnerId).toBe("p-hetzner");
    expect(file.partnerMatchedBy).toBe("auto"); // match source "iban" is internal; stored value is "auto"
    expect(file.partnerMatchConfidence).toBeGreaterThanOrEqual(0.9);
  });

  it("matchFileTransactions chains off partner completion and scores the transaction", async () => {
    await completeExtraction();

    const file = (await db.collection("files").doc("f-invoice").get()).data()!;
    expect(file.transactionMatchComplete).toBe(true);

    // High-confidence IBAN+amount+date match must surface: either auto-connected
    // (fileConnections doc) or as the top suggestion on the file.
    const connections = await db
      .collection("fileConnections")
      .where("fileId", "==", "f-invoice")
      .get();
    const suggestions = (file.transactionSuggestions as Array<{ transactionId: string }>) || [];

    const autoConnected = !connections.empty;
    const suggested = suggestions.some((s) => s.transactionId === "t-hetzner");
    expect(autoConnected || suggested).toBe(true);

    if (autoConnected) {
      expect(connections.docs[0].data()!.transactionId).toBe("t-hetzner");
      const tx = (await db.collection("transactions").doc("t-hetzner").get()).data()!;
      expect((tx.fileIds as string[]).includes("f-invoice")).toBe(true);
    }
  });

  it("does not re-run matching when unrelated file fields change", async () => {
    await completeExtraction();
    const before = (await db.collection("files").doc("f-invoice").get()).data()!;

    await db.collection("files").doc("f-invoice").update({
      fileName: "renamed.pdf",
      updatedAt: Timestamp.now(),
    });
    await drainTriggers();

    const after = (await db.collection("files").doc("f-invoice").get()).data()!;
    expect(after.partnerId).toBe(before.partnerId);
    expect(after.partnerMatchComplete).toBe(true);
    expect(after.transactionMatchComplete).toBe(true);
  });

  it("completes the pipeline (no stuck flags) even with no matching partner", async () => {
    await db.collection("files").doc("f-unknown").set({
      userId: USER,
      fileName: "unknown-vendor.pdf",
      extractionComplete: false,
      transactionIds: [],
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
    await db.collection("files").doc("f-unknown").update({
      extractionComplete: true,
      extractedPartner: "Completely Unknown Vendor Ltd",
      extractedAmount: 42.5,
      updatedAt: Timestamp.now(),
    });
    await drainTriggers();

    const file = (await db.collection("files").doc("f-unknown").get()).data()!;
    expect(file.partnerMatchComplete).toBe(true);
    expect(file.transactionMatchComplete).toBe(true);
  });
});
