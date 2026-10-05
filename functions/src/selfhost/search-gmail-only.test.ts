/**
 * #680: the precision search's email strategies speak only the Gmail API, so
 * they consider Gmail Mail Integrations only.
 *
 * Before the fix, an IMAP mailbox counted as searchable: its token record has
 * no `expiresAt`, so every email strategy attempt threw reading it (fibuki.home
 * failed 2,284 attempts that way), and an IMAP mailbox needing reauth paused
 * the whole queue as "Gmail connected but needs reconnection".
 *
 * Drives the real import handler and the real search queue, as
 * local-file-nomination.test.ts does.
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

const db = getFirestore();
const USER = "stefan-test";
const AUTH = { uid: USER };

interface Attempt {
  strategy: string;
  error?: string;
}

async function seedBase() {
  await db.collection("subscriptions").doc(USER).set({
    userId: USER,
    automationMode: "active",
    planId: "free",
  });
  await db.collection("sources").doc("src-n26").set({
    userId: USER,
    name: "N26 Business",
    iban: "DE89370400440532013000",
    currency: "EUR",
    type: "manual",
    isActive: true,
  });
}

/** A connected mailbox with the token record its provider stores. */
async function mailbox(id: string, provider: "imap" | "gmail", opts: { needsReauth?: boolean } = {}) {
  await db.collection("emailIntegrations").doc(id).set({
    userId: USER,
    provider,
    email: `${id}@example.com`,
    isActive: true,
    needsReauth: opts.needsReauth ?? false,
    initialSyncComplete: true,
  });
  await db.collection("emailTokens").doc(id).set(
    provider === "imap"
      ? // An encrypted app password; no OAuth, so no expiry.
        { integrationId: id, userId: USER, provider, secret: "cipher", secretIv: "iv", updatedAt: Timestamp.now() }
      : {
          accessToken: "expired-token",
          refreshToken: "refresh-token",
          // Expired, so the search marks it for reauth instead of calling Gmail.
          expiresAt: Timestamp.fromDate(new Date("2026-01-01T00:00:00.000Z")),
        }
  );
}

/** Import one bank line through the real handler and run the search it queues. */
async function importCharge(): Promise<string> {
  const created = await bulkCreateTransactionsCallable.run({
    data: {
      sourceId: "src-n26",
      transactions: [
        {
          sourceId: "src-n26",
          date: "2026-07-20T12:00:00.000Z",
          amount: -4900,
          currency: "EUR",
          name: "ACME HOSTING GMBH",
          partner: "Acme Hosting GmbH",
          dedupeHash: "hash-1",
          importJobId: "job-1",
          csvRowIndex: 0,
          _original: { rawRow: {} },
        },
      ],
    },
    auth: AUTH,
  } as never);
  const transactionId = created.transactionIds[0] as string;

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

async function attemptsOf(transactionId: string): Promise<Attempt[]> {
  const searches = await db.collection("transactions").doc(transactionId).collection("searches").get();
  expect(searches.docs).toHaveLength(1);
  return searches.docs[0].data()!.attempts as Attempt[];
}

async function queueItems() {
  return (await db.collection("precisionSearchQueue").get()).docs.map((d) => d.data()!);
}

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
  await seedBase();
});

describe("#680: the precision search's email strategies use Gmail Mail Integrations only", () => {
  it("runs no email strategy for a user whose only mailbox is IMAP", async () => {
    await mailbox("imap-1", "imap");
    const transactionId = await importCharge();

    const attempts = await attemptsOf(transactionId);
    expect(attempts.map((a) => a.strategy).sort()).toEqual(["amount_files", "partner_files"]);
    expect(attempts.filter((a) => a.error)).toEqual([]);
    expect((await queueItems()).map((q) => [q.status, q.errors])).toEqual([["completed", []]]);
  });

  it("does not pause the queue for an IMAP mailbox that needs reauth", async () => {
    await mailbox("imap-1", "imap");
    await mailbox("imap-2", "imap", { needsReauth: true });
    const transactionId = await importCharge();

    expect((await queueItems()).map((q) => q.status)).toEqual(["completed"]);
    expect((await attemptsOf(transactionId)).filter((a) => a.error)).toEqual([]);
  });

  it("still runs the email strategies for a Gmail mailbox", async () => {
    await mailbox("imap-1", "imap");
    await mailbox("gmail-1", "gmail");
    const transactionId = await importCharge();

    const attempts = await attemptsOf(transactionId);
    expect(attempts.map((a) => a.strategy)).toEqual(
      expect.arrayContaining(["email_attachment", "email_invoice"])
    );
    expect(attempts.filter((a) => a.error)).toEqual([]);
    // The expired Gmail token was read, so the mailbox is now marked for reauth.
    expect((await db.collection("emailIntegrations").doc("gmail-1").get()).data()!.needsReauth).toBe(true);
  });
});
