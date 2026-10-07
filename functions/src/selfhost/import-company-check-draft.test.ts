/**
 * The Partner matching and company check after an Import run when the app
 * imports, which it does through a draft: `createDraftImport` creates the
 * import record with no lines, `createImportRecord` completes it by an update
 * once the lines are written. A trigger on the record's creation sees only the
 * empty draft (the same gap #746 found for the receipt search).
 *
 * Drives the real import handlers and the real trigger; the agentic Partner
 * search it queues is only recorded, no worker runs.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";
import { PRESET_PARTNERS } from "../../../lib/data/preset-partners";

// REAL application code, unmodified:
import "../matching/onTransactionsImportedCompanyCheck";
import { bulkCreateTransactionsCallable } from "../imports/bulkCreateTransactions";
import { createDraftImportCallable } from "../imports/createDraftImport";
import { createImportRecordCallable } from "../imports/createImportRecord";

const db = getFirestore();
const USER = "company-check-user";
const AUTH = { uid: USER };
const amazon = PRESET_PARTNERS.find((p) => p.name === "Amazon.com, Inc.")!;

interface Charge {
  name: string;
  amount: number;
}

/** One line a Global Partner matches, one a company nobody knows yet. */
const AMAZON: Charge = { name: "Amazon EU S.a.r.l.", amount: -2999 };
const ACME: Charge = { name: "ACME HOSTING GMBH", amount: -4900 };

let importCount = 0;

/**
 * Import bank lines through the real handlers. `draft` is the app's own flow:
 * a draft import record first, completed once the lines are written. Without
 * it the record is created already completed, as older clients did.
 */
async function importCharges(charges: Charge[], opts: { draft?: boolean } = {}): Promise<Record<string, string>> {
  let job = `job-${++importCount}`;
  if (opts.draft) {
    const draft = await createDraftImportCallable.run({
      data: {
        sourceId: "src-n26",
        fileName: "n26.csv",
        csvHash: `hash-${job}`,
        csvStoragePath: `imports/${job}.csv`,
        csvDownloadUrl: `https://example.invalid/${job}.csv`,
        parseOptions: { delimiter: ";", hasHeader: true },
        detectedHeaders: ["Datum", "Betrag", "Empfänger"],
        sampleRows: [],
        totalRows: charges.length,
      },
      auth: AUTH,
    } as never);
    job = (draft as { importId: string }).importId;
    await drainTriggers();
    await __whenShimIdle();
  }

  const created = await bulkCreateTransactionsCallable.run({
    data: {
      sourceId: "src-n26",
      transactions: charges.map((charge, i) => ({
        sourceId: "src-n26",
        date: "2026-07-20T12:00:00.000Z",
        amount: charge.amount,
        currency: "EUR",
        name: charge.name,
        partner: charge.name,
        dedupeHash: `${job}-hash-${i}`,
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
      importedCount: charges.length,
      skippedCount: 0,
      errorCount: 0,
      totalRows: charges.length,
    },
    auth: AUTH,
  } as never);
  await drainTriggers();
  await __whenShimIdle();

  const ids = created.transactionIds as string[];
  return Object.fromEntries(charges.map((charge, i) => [charge.name, ids[i]]));
}

/** Whether the Partner matching assigned or suggested the Partner. */
async function matched(transactionId: string, partnerId: string): Promise<boolean> {
  const data = (await db.doc(`transactions/${transactionId}`).get()).data()!;
  const suggestions = (data.partnerSuggestions ?? []) as Array<{ partnerId: string }>;
  return data.partnerId === partnerId || suggestions.some((s) => s.partnerId === partnerId);
}

/** The company names the company check queued an agentic Partner search for. */
async function queuedCompanySearches(): Promise<string[]> {
  const snap = await db.collection(`users/${USER}/workerRequests`).get();
  return snap.docs
    .map((d) => d.data()!)
    .filter((r) => r.workerType === "partner_matching")
    .map((r) => (r.triggerContext as { companyName: string }).companyName);
}

async function companyCheckEntries(transactionId: string): Promise<unknown[]> {
  const data = (await db.doc(`transactions/${transactionId}`).get()).data()!;
  return ((data.automationHistory ?? []) as Array<{ type: string }>).filter((e) => e.type === "company_check");
}

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
  await db.collection("subscriptions").doc(USER).set({ userId: USER, automationMode: "active", planId: "free" });
  await db.collection("sources").doc("src-n26").set({
    userId: USER,
    name: "N26 Business",
    iban: "DE89370400440532013000",
    currency: "EUR",
    type: "manual",
    isActive: true,
  });
  await db.doc("globalPartners/amazon").set({ ...JSON.parse(JSON.stringify(amazon)), isActive: true });
  await drainTriggers().catch(() => undefined);
});

describe("Partner matching and company check after an Import", () => {
  it("run when a draft import is completed, as the app imports", async () => {
    const ids = await importCharges([AMAZON, ACME], { draft: true });

    expect(await matched(ids[AMAZON.name], "amazon")).toBe(true);
    expect(await queuedCompanySearches()).toEqual([ACME.name]);
    expect(await companyCheckEntries(ids[ACME.name])).toHaveLength(1);
  });

  it("run when the import record is created already completed", async () => {
    const ids = await importCharges([AMAZON, ACME]);

    expect(await matched(ids[AMAZON.name], "amazon")).toBe(true);
    expect(await queuedCompanySearches()).toEqual([ACME.name]);
    expect(await companyCheckEntries(ids[ACME.name])).toHaveLength(1);
  });

  it("do not run again when a completed import record changes later", async () => {
    const ids = await importCharges([ACME], { draft: true });
    const [importId] = (await db.collection("imports").where("userId", "==", USER).get()).docs.map((d) => d.id);

    await db.doc(`imports/${importId}`).update({ note: "touched" });
    await drainTriggers();
    await __whenShimIdle();

    expect(await queuedCompanySearches()).toEqual([ACME.name]);
    expect(await companyCheckEntries(ids[ACME.name])).toHaveLength(1);
  });
});
