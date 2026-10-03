/**
 * #589: the local-file search strategies nominate a Transaction; the matcher
 * alone scores and connects.
 *
 * The shape of matching-chain.test.ts, one step further: a File is stored,
 * extracted and matched while no Transaction exists to pair it with. A
 * Transaction is then imported through the real import handler, and draining
 * the triggers runs the real search queue (Partner and amount strategies) and
 * the real matcher. Importing never re-runs the matcher on stored Files, so
 * whatever the File ends up with came from a nomination.
 *
 * Before #589 those strategies scored each File with the attachment scorer and
 * wrote a precision-search hint worth up to 40 points, which carried a
 * fixed-price invoice from the wrong month over the auto-connect threshold.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";

// REAL application code, unmodified:
import "../matching/matchFilePartner";
import "../matching/matchFileTransactions";
import "../gmail/onTransactionsImported";
import "../precision-search/precisionSearchQueue";
import { bulkCreateTransactionsCallable } from "../imports/bulkCreateTransactions";
import { createImportRecordCallable } from "../imports/createImportRecord";
import { scoreFileTransactionMatch } from "../tools/handlers";

const db = getFirestore();
const USER = "stefan-test";
const IBAN = "AT61 1904 3002 3457 3201";
const AUTH = { uid: USER };

interface Suggestion {
  transactionId: string;
  confidence: number;
  matchSources: string[];
}

interface Attempt {
  strategy: string;
  candidatesFound: number;
  fileIdsConnected: string[];
  fileIdsNominated?: string[];
}

async function seedBase() {
  // Active mode: the matcher may auto-connect, so "no connection" means
  // the matcher declined, not that automation was off.
  await db.collection("subscriptions").doc(USER).set({
    userId: USER,
    automationMode: "active",
    planId: "free",
  });

  await db.collection("partners").doc("p-acme").set({
    userId: USER,
    name: "Acme Hosting GmbH",
    aliases: ["Acme Hosting"],
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

  // Searching after an Import needs a connected mailbox. It has no token, so
  // the email strategies find nothing and only the local-file ones act.
  await db.collection("emailIntegrations").doc("imap-1").set({
    userId: USER,
    provider: "imap",
    email: "stefan@example.com",
    isActive: true,
    needsReauth: false,
    initialSyncComplete: true,
  });
}

/** A monthly fixed-price invoice: stored, extracted, matched with nothing to pair. */
async function storeInvoice(fileId: string, invoiceDate: string) {
  await db.collection("files").doc(fileId).set({
    userId: USER,
    fileName: "invoice.pdf",
    fileType: "application/pdf",
    storagePath: `files/${USER}/${fileId}.pdf`,
    extractionComplete: false,
    transactionIds: [],
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });
  await db.collection("files").doc(fileId).update({
    extractionComplete: true,
    extractedPartner: "Acme Hosting GmbH",
    extractedIban: IBAN,
    extractedAmount: 4900,
    extractedCurrency: "EUR",
    extractedDate: Timestamp.fromDate(new Date(`${invoiceDate}T00:00:00.000Z`)),
    extractedText: "Acme Hosting GmbH Rechnung Managed Server 49,00 EUR",
    updatedAt: Timestamp.now(),
  });
  await drainTriggers();

  const file = (await db.collection("files").doc(fileId).get()).data()!;
  expect(file.partnerId).toBe("p-acme");
  expect(file.transactionMatchComplete).toBe(true);
  expect(file.transactionSuggestions).toEqual([]);
}

/**
 * Import one bank line through the real handler and run what follows it.
 * `assignPartner` stands in for the partner matching a real import runs
 * before the search, so the Partner strategy has a Transaction to act for.
 */
async function importCharge(
  bookedOn: string,
  opts: { assignPartner?: boolean; beforeSearch?: (transactionId: string) => Promise<void> } = {}
): Promise<string> {
  const created = await bulkCreateTransactionsCallable.run({
    data: {
      sourceId: "src-n26",
      transactions: [
        {
          sourceId: "src-n26",
          date: `${bookedOn}T12:00:00.000Z`,
          amount: -4900,
          currency: "EUR",
          name: "ACME HOSTING GMBH",
          partner: "Acme Hosting GmbH",
          partnerIban: IBAN,
          dedupeHash: `hash-${bookedOn}`,
          importJobId: "job-1",
          csvRowIndex: 0,
          _original: { rawRow: {} },
        },
      ],
    },
    auth: AUTH,
  } as never);
  const transactionId = created.transactionIds[0] as string;

  if (opts.assignPartner) {
    await db.collection("transactions").doc(transactionId).update({
      partnerId: "p-acme",
      partnerType: "user",
    });
  }
  await opts.beforeSearch?.(transactionId);

  await createImportRecordCallable.run({
    data: {
      importJobId: "job-1",
      sourceId: "src-n26",
      fileName: "n26.csv",
      importedCount: 1,
      skippedCount: 0,
      errorCount: 0,
      totalRows: 1,
    },
    auth: AUTH,
  } as never);
  await drainTriggers();
  await __whenShimIdle();
  return transactionId;
}

async function fileOf(fileId: string) {
  return (await db.collection("files").doc(fileId).get()).data()!;
}

function matchFor(file: FirebaseFirestore.DocumentData, transactionId: string): Suggestion | undefined {
  return ((file.transactionSuggestions ?? []) as Suggestion[]).find((s) => s.transactionId === transactionId);
}

async function connectionsOf(fileId: string) {
  return (await db.collection("fileConnections").where("fileId", "==", fileId).get()).docs.map((d) => d.data()!);
}

async function searchRecordOf(transactionId: string) {
  const searches = await db.collection("transactions").doc(transactionId).collection("searches").get();
  expect(searches.docs).toHaveLength(1);
  return searches.docs[0].data()!;
}

function attemptOf(record: FirebaseFirestore.DocumentData, strategy: string): Attempt {
  const attempt = (record.attempts as Attempt[]).find((a) => a.strategy === strategy);
  expect(attempt).toBeDefined();
  return attempt!;
}

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
  await seedBase();
});

describe("#589: local-file strategies nominate, the matcher scores and connects", () => {
  it("leaves a Match carrying the matcher's own confidence and no hint Score", async () => {
    await storeInvoice("f-invoice", "2026-07-01");
    // 19 days on: inside the matcher's window, too far for an auto-connect.
    const transactionId = await importCharge("2026-07-20");

    const file = await fileOf("f-invoice");
    expect(file.precisionSearchHint).toBeUndefined();
    const match = matchFor(file, transactionId);
    expect(match).toBeDefined();
    expect(match!.matchSources).not.toContain("precision_hint");

    // The same scorer and input assembly as every other surface.
    const scored = await scoreFileTransactionMatch(USER, { fileId: "f-invoice", transactionId });
    expect(scored.matchSources).not.toContain("precision_hint");
    expect(match!.confidence).toBe(scored.confidence);
    expect(await connectionsOf("f-invoice")).toEqual([]);
  });

  it("does not connect a fixed-price invoice from the month before", async () => {
    await storeInvoice("f-june", "2026-06-01");
    const transactionId = await importCharge("2026-07-01", { assignPartner: true });

    // Both strategies found it (same Partner, same amount); the matcher ran
    // on the pair once.
    const record = await searchRecordOf(transactionId);
    expect(attemptOf(record, "partner_files").fileIdsNominated).toEqual(["f-june"]);
    expect(attemptOf(record, "amount_files")).toMatchObject({ candidatesFound: 1, fileIdsNominated: [] });

    expect(await connectionsOf("f-june")).toEqual([]);
    const tx = (await db.collection("transactions").doc(transactionId).get()).data()!;
    expect(tx.fileIds).toEqual([]);
    expect(tx.isComplete).toBe(false);
    const match = matchFor(await fileOf("f-june"), transactionId);
    expect(match?.confidence ?? 0).toBeLessThan(85);
  });

  it("lets the matcher connect when amount, Partner and date agree", async () => {
    await storeInvoice("f-july", "2026-07-01");
    const transactionId = await importCharge("2026-07-01", { assignPartner: true });

    const connections = await connectionsOf("f-july");
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({ transactionId, connectionType: "auto_matched" });
    expect(connections[0].matchSources).not.toContain("precision_hint");

    const tx = (await db.collection("transactions").doc(transactionId).get()).data()!;
    expect(tx.fileIds).toEqual(["f-july"]);
    expect((await fileOf("f-july")).precisionSearchHint).toBeUndefined();

    // The Partner strategy runs first and its nomination connected.
    const record = await searchRecordOf(transactionId);
    const partner = attemptOf(record, "partner_files");
    expect(partner.fileIdsNominated).toEqual(["f-july"]);
    expect(partner.fileIdsConnected).toEqual(["f-july"]);
    expect(record.totalFilesConnected).toBe(1);
    expect(record.automationSource).toBe("partner_files");
  });

  it("makes a Transaction more than 30 days from the File's date a Match", async () => {
    await storeInvoice("f-term", "2026-07-01");
    // An invoice paid on a 45-day term: outside the matcher's own window.
    const transactionId = await importCharge("2026-08-15", { assignPartner: true });

    const match = matchFor(await fileOf("f-term"), transactionId);
    expect(match).toBeDefined();
    expect(match!.matchSources).not.toContain("precision_hint");
    expect(await connectionsOf("f-term")).toEqual([]);
  });

  it("reports a run that only nominated as no connection", async () => {
    await storeInvoice("f-invoice", "2026-07-01");
    const transactionId = await importCharge("2026-07-20");

    const record = await searchRecordOf(transactionId);
    const amount = attemptOf(record, "amount_files");
    expect(amount.fileIdsNominated).toEqual(["f-invoice"]);
    expect(amount.fileIdsConnected).toEqual([]);
    expect(record.totalFilesConnected).toBe(0);
    expect(record.automationSource).toBeNull();
  });

  it("does not queue an agentic search for a File with no Partner", async () => {
    // A receipt nobody could attribute. A nomination checks one pair; it does
    // not start an agentic search for every File it is made to. The free plan
    // has no AI budget, which would hide the difference.
    await db.collection("subscriptions").doc(USER).update({ adminOverride: "free_plan" });
    await db.collection("files").doc("f-unknown").set({
      userId: USER,
      fileName: "receipt.pdf",
      extractionComplete: false,
      transactionIds: [],
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
    await db.collection("files").doc("f-unknown").update({
      extractionComplete: true,
      extractedAmount: 4900,
      extractedCurrency: "EUR",
      extractedDate: Timestamp.fromDate(new Date("2026-07-01T00:00:00.000Z")),
      updatedAt: Timestamp.now(),
    });
    await drainTriggers();
    const workerRequests = () => db.collection(`users/${USER}/workerRequests`).get();
    const before = (await workerRequests()).size;
    expect((await fileOf("f-unknown")).partnerId ?? null).toBeNull();

    const transactionId = await importCharge("2026-07-20");

    const record = await searchRecordOf(transactionId);
    expect(attemptOf(record, "amount_files").fileIdsNominated).toEqual(["f-unknown"]);
    expect((await workerRequests()).size).toBe(before);
  });

  it("drops a hint a local-file strategy wrote before #589, and its Score with it", async () => {
    await storeInvoice("f-june", "2026-06-01");
    const transactionId = await importCharge("2026-07-01", {
      assignPartner: true,
      beforeSearch: async (id) => {
        // What the Partner strategy used to leave behind for this pair.
        await db.collection("files").doc("f-june").update({
          precisionSearchHint: {
            transactionId: id,
            searchStrategy: "partner_files",
            matchConfidence: 68,
            searchedAt: Timestamp.now(),
          },
        });
      },
    });

    const file = await fileOf("f-june");
    expect(file.precisionSearchHint).toBeUndefined();
    expect(matchFor(file, transactionId)?.matchSources ?? []).not.toContain("precision_hint");
    expect(await connectionsOf("f-june")).toEqual([]);
  });
});
