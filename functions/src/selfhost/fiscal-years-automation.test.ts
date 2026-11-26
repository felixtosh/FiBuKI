/**
 * Automation leaves closed years alone (#803, spec #800, ADR-0018).
 *
 * A database holding untracked, closed and open records. Each automation
 * entry point runs over it through the real triggers, callables and workers
 * on the self-host in-memory database, and what is asserted is what the User
 * sees: a Partner or Category assigned, a File Connection made, a receipt
 * search recorded, a fact extracted. Records outside the open stretch keep
 * what they had; open ones are worked on as before. Learning still reads
 * closed records.
 *
 * Settings for every test: Tracked From 2024-01, Closed Through 2024-12. So
 * 2023 is untracked, 2024 closed, 2025 on open.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";

// REAL trigger modules and application code, unmodified:
import "../matching/matchFilePartner";
import "../matching/matchFileTransactions";
import "../gmail/onTransactionsImported";
import "../matching/onTransactionsImportedCompanyCheck";
import "../precision-search/precisionSearchQueue";
import "../matching/onPartnerCreate";
import "../matching/onCategoryCreate";
import { handleTool } from "../tools/handlers";
import { bulkCreateTransactionsCallable } from "../imports/bulkCreateTransactions";
import { createImportRecordCallable } from "../imports/createImportRecord";
import { queueReceiptSearchForTransaction } from "../workers/runReceiptSearchForTransaction";
import { runPartnerMatching } from "../matching/matchPartners";
import { matchCategoriesForUser } from "../matching/matchCategories";
import { extractQueuedFile } from "../extraction/extractQueuedFile";
import { rescoreUnconnectedFilesForPartners } from "../matching/rescorePartnerFiles";
import { rescoreConnections } from "../matching/matcher";

const db = getFirestore();
const USER = "fy-auto";
const AUTH = { uid: USER, token: {} };
const IBAN = "AT61 1904 3002 3457 3201";

const CLOSED_DAY = "2024-06-03";
const OPEN_DAY = "2025-06-03";

async function seedBase() {
  await handleTool(USER, "set_fiscal_years", { trackedFrom: "2024-01", closedThrough: "2024-12" });

  await db.collection("subscriptions").doc(USER).set({ userId: USER, automationMode: "active", planId: "free" });
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
  // A mailbox without a token: the email strategies find nothing, but the
  // receipt search runs and records itself on each Transaction it searched.
  await db.collection("emailIntegrations").doc("imap-1").set({
    userId: USER,
    provider: "imap",
    email: "fy@example.com",
    isActive: true,
    needsReauth: false,
    initialSyncComplete: true,
  });
}

interface Line {
  day: string;
  name?: string;
  partnerIban?: string | null;
}

/** Import bank lines through the real handler and run every trigger that follows. */
async function importLines(lines: Line[], job = "job-1"): Promise<string[]> {
  const created = await bulkCreateTransactionsCallable.run({
    data: {
      sourceId: "src-n26",
      transactions: lines.map((line, i) => ({
        sourceId: "src-n26",
        date: `${line.day}T12:00:00.000Z`,
        amount: -4900,
        currency: "EUR",
        name: line.name ?? "ACME HOSTING GMBH",
        partner: line.name ?? "Acme Hosting GmbH",
        partnerIban: line.partnerIban === undefined ? IBAN : line.partnerIban,
        dedupeHash: `hash-${job}-${i}`,
        importJobId: job,
        csvRowIndex: i,
        _original: { rawRow: {} },
      })),
    },
    auth: AUTH,
  } as never);
  await createImportRecordCallable.run({
    data: {
      importJobId: job,
      sourceId: "src-n26",
      fileName: "n26.csv",
      importedCount: lines.length,
      skippedCount: 0,
      errorCount: 0,
      totalRows: lines.length,
    },
    auth: AUTH,
  } as never);
  await drainTriggers();
  await __whenShimIdle();
  return created.transactionIds as string[];
}

async function tx(id: string) {
  return (await db.collection("transactions").doc(id).get()).data()!;
}

async function searchesOf(transactionId: string) {
  return (await db.collection("transactions").doc(transactionId).collection("searches").get()).docs;
}

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
  await seedBase();
});

describe("an Import", () => {
  it("of closed and open rows searches receipts for the open rows only", async () => {
    const [closed, open] = await importLines([{ day: CLOSED_DAY }, { day: OPEN_DAY }]);

    expect(await searchesOf(open)).toHaveLength(1);
    expect(await searchesOf(closed)).toHaveLength(0);
  });

  it("of closed and open rows matches Partners for the open rows only", async () => {
    const [closed, open] = await importLines([{ day: CLOSED_DAY }, { day: OPEN_DAY }]);

    expect(await tx(open)).toMatchObject({ partnerId: "p-acme", partnerMatchedBy: "auto" });
    const untouched = await tx(closed);
    expect(untouched.partnerId).toBeNull();
    expect(untouched.partnerSuggestions ?? []).toEqual([]);
    expect(untouched.automationHistory ?? []).toEqual([]);
  });

  it("of closed and open rows looks up companies for the open rows only", async () => {
    const [closed, open] = await importLines([
      { day: CLOSED_DAY, name: "Brandneu Consulting GmbH", partnerIban: null },
      { day: OPEN_DAY, name: "Brandneu Consulting GmbH", partnerIban: null },
    ]);

    const requests = (await db.collection(`users/${USER}/workerRequests`).get()).docs.map((d) => d.data());
    expect(requests.map((r) => r.triggerContext.transactionId)).toEqual([open]);
    expect((await tx(closed)).automationHistory ?? []).toEqual([]);
  });

  it("of closed rows only triggers no automation at all", async () => {
    const [a, b] = await importLines([
      { day: CLOSED_DAY },
      { day: "2024-07-01", name: "Brandneu Consulting GmbH", partnerIban: null },
    ]);

    expect(await db.collection("precisionSearchQueue").get()).toHaveProperty("size", 0);
    expect(await db.collection(`users/${USER}/workerRequests`).get()).toHaveProperty("size", 0);
    for (const id of [a, b]) {
      const row = await tx(id);
      expect(row.partnerId).toBeNull();
      expect(row.automationHistory ?? []).toEqual([]);
      expect(await searchesOf(id)).toHaveLength(0);
    }
  });
});

/** A Transaction stored as an earlier Import left it. */
async function seedTransaction(id: string, day: string, extra: Record<string, unknown> = {}) {
  await db.collection("transactions").doc(id).set({
    userId: USER,
    sourceId: "src-n26",
    date: Timestamp.fromDate(new Date(`${day}T00:00:00.000Z`)),
    amount: -4900,
    currency: "EUR",
    name: "ACME HOSTING GMBH",
    partner: "Acme Hosting GmbH",
    partnerIban: IBAN,
    fileIds: [],
    isComplete: false,
    partnerId: null,
    partnerType: null,
    partnerSuggestions: [],
    noReceiptCategoryId: null,
    ...extra,
  });
}

describe("receipt search for one Transaction", () => {
  it("skips a closed Transaction and still queues an open one", async () => {
    await seedTransaction("t-closed", CLOSED_DAY);
    await seedTransaction("t-open", OPEN_DAY);

    const closed = await queueReceiptSearchForTransaction({ transactionId: "t-closed", userId: USER });
    const open = await queueReceiptSearchForTransaction({ transactionId: "t-open", userId: USER });

    expect(closed).toMatchObject({ skipped: true, skipReason: "closed" });
    expect(open.skipped).toBeFalsy();
    const requests = (await db.collection(`users/${USER}/workerRequests`).get()).docs.map((d) => d.data());
    expect(requests.map((r) => r.triggerContext.transactionId)).toEqual(["t-open"]);
    expect((await tx("t-closed")).automationHistory ?? []).toEqual([]);
  });
});

describe("Partner and Category matching", () => {
  it("asked for every Transaction leaves closed ones alone", async () => {
    await seedTransaction("t-closed", CLOSED_DAY);
    await seedTransaction("t-open", OPEN_DAY);

    await runPartnerMatching(USER, { matchAll: true });

    expect((await tx("t-open")).partnerId).toBe("p-acme");
    expect(await tx("t-closed")).toMatchObject({ partnerId: null, partnerSuggestions: [] });
  });

  it("assigns a No-document Category to open Transactions only", async () => {
    await db.collection("noReceiptCategories").doc("c-bank").set({
      userId: USER,
      templateId: "bank-fees",
      name: "Bank fees",
      matchedPartnerIds: ["p-acme"],
      learnedPatterns: [],
      manualRemovals: [],
      isActive: true,
    });
    await seedTransaction("t-closed", CLOSED_DAY, { partnerId: "p-acme", partnerType: "user" });
    await seedTransaction("t-open", OPEN_DAY, { partnerId: "p-acme", partnerType: "user" });

    await matchCategoriesForUser(USER, undefined, true);

    expect((await tx("t-open")).noReceiptCategoryId).toBe("c-bank");
    const closed = await tx("t-closed");
    expect(closed.noReceiptCategoryId ?? null).toBeNull();
    expect(closed.categorySuggestions ?? []).toEqual([]);
  });

  it("run by a new Partner leaves closed Transactions alone", async () => {
    const zetaIban = "DE02120300000000202051";
    await seedTransaction("t-closed", CLOSED_DAY, { name: "ZETA CLOUD", partner: "Zeta Cloud", partnerIban: zetaIban });
    await seedTransaction("t-open", OPEN_DAY, { name: "ZETA CLOUD", partner: "Zeta Cloud", partnerIban: zetaIban });

    await db.collection("partners").doc("p-zeta").set({
      userId: USER,
      name: "Zeta Cloud",
      aliases: [],
      ibans: [zetaIban],
      isActive: true,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
    await drainTriggers();
    await __whenShimIdle();

    expect((await tx("t-open")).partnerId).toBe("p-zeta");
    expect(await tx("t-closed")).toMatchObject({ partnerId: null, partnerSuggestions: [] });
  });

  it("run by a new Category leaves closed Transactions alone", async () => {
    await seedTransaction("t-closed", CLOSED_DAY, { partnerId: "p-acme", partnerType: "user" });
    await seedTransaction("t-open", OPEN_DAY, { partnerId: "p-acme", partnerType: "user" });

    await db.collection("noReceiptCategories").doc("c-bank").set({
      userId: USER,
      templateId: "bank-fees",
      name: "Bank fees",
      matchedPartnerIds: ["p-acme"],
      learnedPatterns: [],
      manualRemovals: [],
      isActive: true,
    });
    await drainTriggers();
    await __whenShimIdle();

    expect((await tx("t-open")).noReceiptCategoryId).toBe("c-bank");
    const closed = await tx("t-closed");
    expect(closed.noReceiptCategoryId ?? null).toBeNull();
    expect(closed.categorySuggestions ?? []).toEqual([]);
  });
});

/** A File as an upload leaves it, its date given by the uploader when `day` is set. */
async function uploadFile(id: string, day: string | null) {
  await db.collection("files").doc(id).set({
    userId: USER,
    fileName: `${id}.pdf`,
    fileType: "application/pdf",
    storagePath: `files/${USER}/${id}.pdf`,
    extractionComplete: false,
    transactionIds: [],
    extractedDate: day ? Timestamp.fromDate(new Date(`${day}T00:00:00.000Z`)) : null,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });
}

async function file(id: string) {
  return (await db.collection("files").doc(id).get()).data()!;
}

describe("extraction", () => {
  it("writes no fact on a closed File or one before Tracked From, and still reads an open one", async () => {
    await uploadFile("f-closed", CLOSED_DAY);
    await uploadFile("f-untracked", "2023-03-01");
    await uploadFile("f-open", OPEN_DAY);

    expect(await extractQueuedFile("f-closed", { skipClassification: false })).toBe("closed");
    expect(await extractQueuedFile("f-untracked", { skipClassification: false })).toBe("closed");
    // No bytes are stored, so reading the open one fails: it was attempted.
    expect(await extractQueuedFile("f-open", { skipClassification: false })).toBe("failed");

    for (const id of ["f-closed", "f-untracked"]) {
      const stored = await file(id);
      expect(stored).toMatchObject({ extractionComplete: true, extractionError: null });
      expect(Object.keys(stored).filter((k) => k.startsWith("extracted") && k !== "extractedDate")).toEqual([]);
      expect(stored.classificationComplete).toBeUndefined();
    }
  });
});

/** Extraction reads the document of an undated upload: its facts land and the matching chain runs. */
async function extractAs(id: string, day: string) {
  await db.collection("files").doc(id).update({
    extractionComplete: true,
    extractedPartner: "Acme Hosting GmbH",
    extractedIban: IBAN,
    extractedAmount: 4900,
    extractedCurrency: "EUR",
    extractedDate: Timestamp.fromDate(new Date(`${day}T00:00:00.000Z`)),
    extractedText: "Acme Hosting GmbH Rechnung Managed Server 49,00 EUR",
    updatedAt: Timestamp.now(),
  });
  await drainTriggers();
  await __whenShimIdle();
}

async function connectionsOf(fileId: string) {
  return (await db.collection("fileConnections").where("fileId", "==", fileId).get()).docs.map((d) => d.data());
}

describe("Partner matching and auto-connect of a File", () => {
  it("leave a File dated in the Closed stretch alone, with no connection to an open Transaction", async () => {
    await seedTransaction("t-closed", "2024-12-30");
    await seedTransaction("t-open", "2025-01-02");
    await uploadFile("f-closed", null);

    await extractAs("f-closed", "2024-12-30");

    const stored = await file("f-closed");
    expect(stored).toMatchObject({ partnerMatchComplete: true, transactionMatchComplete: true });
    expect(stored.partnerId ?? null).toBeNull();
    expect(stored.partnerSuggestions ?? []).toEqual([]);
    expect(stored.transactionSuggestions ?? []).toEqual([]);
    expect(await connectionsOf("f-closed")).toEqual([]);
  });

  it("treat a File dated before Tracked From like a closed one", async () => {
    await seedTransaction("t-open", "2025-01-02");
    await uploadFile("f-old", null);

    await extractAs("f-old", "2023-12-30");

    const stored = await file("f-old");
    expect(stored).toMatchObject({ partnerMatchComplete: true, transactionMatchComplete: true });
    expect(stored.partnerId ?? null).toBeNull();
    expect(await connectionsOf("f-old")).toEqual([]);
  });

  it("connect an open File to an open Transaction, never to a closed one", async () => {
    await seedTransaction("t-closed", "2024-12-31");
    await uploadFile("f-january", null);
    await extractAs("f-january", "2025-01-02");

    expect((await file("f-january")).partnerId).toBe("p-acme");
    expect(await connectionsOf("f-january")).toEqual([]);

    await seedTransaction("t-open", "2025-03-03");
    await uploadFile("f-march", null);
    await extractAs("f-march", "2025-03-03");

    expect((await connectionsOf("f-march")).map((c) => c.transactionId)).toEqual(["t-open"]);
  });
});

describe("learning", () => {
  it("still reads closed records: an alias learned from a closed File matches an open Transaction", async () => {
    await db.collection("partners").doc("p-beta").set({
      userId: USER,
      name: "Beta Werkstatt GmbH",
      aliases: [],
      ibans: [],
      isActive: true,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
    await db.collection("files").doc("f-old").set({
      userId: USER,
      fileName: "beta-2024.pdf",
      extractionComplete: true,
      partnerMatchComplete: true,
      transactionMatchComplete: true,
      extractedPartner: "Beta KFZ Service",
      extractedDate: Timestamp.fromDate(new Date(`${CLOSED_DAY}T00:00:00.000Z`)),
      transactionIds: [],
      partnerId: null,
    });
    await drainTriggers();
    // The User's own assignment, made while 2024 was still open.
    await db.collection("files").doc("f-old").update({ partnerId: "p-beta", partnerType: "user", partnerMatchedBy: "manual" });
    await drainTriggers();
    await __whenShimIdle();
    expect((await db.collection("partners").doc("p-beta").get()).data()!.aliases).toContain("Beta KFZ Service");

    const beta = { name: "BETA KFZ SERVICE", partner: "Beta KFZ Service", partnerIban: null };
    await seedTransaction("t-closed", "2024-08-01", beta);
    await seedTransaction("t-open", OPEN_DAY, beta);
    await runPartnerMatching(USER, {});

    expect((await tx("t-open")).partnerSuggestions.map((s: { partnerId: string }) => s.partnerId)).toContain("p-beta");
    expect(await tx("t-closed")).toMatchObject({ partnerId: null, partnerSuggestions: [] });
  });
});

describe("automation a callable or a tool starts", () => {
  async function seedOther() {
    await db.collection("partners").doc("p-other").set({
      userId: USER,
      name: "Other Werkstatt GmbH",
      aliases: [],
      ibans: [],
      isActive: true,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
  }

  it("the whole-account re-match rewrites an open Transaction's Partner, never a closed one's", async () => {
    await seedOther();
    const wrong = { partnerId: "p-other", partnerType: "user", partnerMatchedBy: "auto", partnerMatchConfidence: 90 };
    await seedTransaction("t-closed", CLOSED_DAY, wrong);
    await seedTransaction("t-open", OPEN_DAY, wrong);

    const result = await handleTool(USER, "rematch_assigned_partners", { dryRun: false });

    expect(await tx("t-open")).toMatchObject({ partnerId: "p-acme", partnerMatchedBy: "auto" });
    const closed = await tx("t-closed");
    expect(closed).toMatchObject({ partnerId: "p-other", partnerMatchConfidence: 90, partnerSuggestions: [] });
    expect(closed.automationHistory ?? []).toEqual([]);
    expect(result).toMatchObject({ transactionsWritten: 1, actions: { reassign: 1, skip_outside_open: 1 } });
  });

  it("the File re-score after a Partner change refreshes an open File's suggestions, never a closed one's", async () => {
    await seedTransaction("t-closed", CLOSED_DAY, { partnerId: "p-acme", partnerType: "user" });
    await seedTransaction("t-open", OPEN_DAY, { partnerId: "p-acme", partnerType: "user" });
    const stale = [{ transactionId: "t-gone", confidence: 12, matchSources: [] }];
    for (const [id, day] of [["f-closed", CLOSED_DAY], ["f-untracked", "2023-06-01"], ["f-open", OPEN_DAY]]) {
      await db.collection("files").doc(id).set({
        userId: USER,
        fileName: `${id}.pdf`,
        partnerId: "p-acme",
        extractionComplete: true,
        transactionMatchComplete: true,
        extractedAmount: 4900,
        extractedCurrency: "EUR",
        extractedPartner: "Acme Hosting GmbH",
        extractedDate: Timestamp.fromDate(new Date(`${day}T00:00:00.000Z`)),
        transactionIds: [],
        transactionSuggestions: stale,
      });
    }

    const result = await rescoreUnconnectedFilesForPartners(db, USER, ["p-acme"]);

    expect(result.filesRescored).toBe(1);
    expect((await file("f-open")).transactionSuggestions.map((s: { transactionId: string }) => s.transactionId)).toContain("t-open");
    for (const id of ["f-closed", "f-untracked"]) {
      const stored = await file(id);
      expect(stored.transactionSuggestions).toEqual(stale);
      expect(stored.automationHistory ?? []).toEqual([]);
    }
  });

  it("the billing-cycle re-score leaves the score of a File Connection on a closed Transaction alone", async () => {
    await seedTransaction("t-closed", CLOSED_DAY, { partnerId: "p-acme", partnerType: "user" });
    await seedTransaction("t-open", OPEN_DAY, { partnerId: "p-acme", partnerType: "user" });
    for (const [txId, day] of [["t-closed", CLOSED_DAY], ["t-open", OPEN_DAY]]) {
      const fileId = `f-${txId}`;
      await db.collection("files").doc(fileId).set({
        userId: USER,
        fileName: `${fileId}.pdf`,
        partnerId: "p-acme",
        extractionComplete: true,
        transactionMatchComplete: true,
        extractedAmount: 4900,
        extractedCurrency: "EUR",
        extractedDate: Timestamp.fromDate(new Date(`${day}T00:00:00.000Z`)),
        transactionIds: [txId],
      });
      await db.collection("fileConnections").doc(`c-${txId}`).set({
        userId: USER,
        fileId,
        transactionId: txId,
        matchConfidence: 7,
        matchSources: [],
      });
    }
    const txDocs = (await db.collection("transactions").where("userId", "==", USER).get()).docs;

    const result = await rescoreConnections(db, USER, "p-acme", txDocs);

    expect(result.rescored).toBe(1);
    const closed = (await db.collection("fileConnections").doc("c-t-closed").get()).data()!;
    expect(closed.matchConfidence).toBe(7);
    expect(closed.rescoredAt).toBeUndefined();
    expect((await db.collection("fileConnections").doc("c-t-open").get()).data()!.rescoredAt).toBeDefined();
  });
});
