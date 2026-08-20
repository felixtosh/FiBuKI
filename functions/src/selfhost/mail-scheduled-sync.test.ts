/**
 * Hardening test — the daily scheduled mail sync must keep IMAP mailboxes
 * current, not only Gmail ones.
 *
 * The regression this guards: `queueScheduledMailSyncs` selected integrations
 * with `provider == "gmail"`, so an IMAP mailbox received its initial sync and
 * was never queued again. The worker (`gmailSyncQueue`) already resolves both
 * providers per queue item; only the enqueue side was Gmail-only. The same
 * filter lived in the after-import gap sync (`onTransactionsImported`), which
 * shares the constant under test here.
 *
 * Covers: an IMAP mailbox that has drifted behind "now" is queued exactly like
 * a Gmail one; a mailbox still in its initial sync, a paused mailbox and one
 * needing re-auth are left alone; and a mailbox already fully synced to now
 * produces no duplicate item.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { queueScheduledMailSyncs } from "../gmail/scheduledGmailSync";
import { SYNCABLE_MAIL_PROVIDERS } from "../mail/constants";

const db = getFirestore();
const USER = "stefan-test";
const DAY = 24 * 60 * 60 * 1000;

async function seedIntegration(
  id: string,
  provider: string,
  overrides: Record<string, unknown> = {}
) {
  await db.collection("emailIntegrations").doc(id).set({
    userId: USER,
    provider,
    email: `${id}@example.com`,
    isActive: true,
    needsReauth: false,
    initialSyncComplete: true,
    // Synced up to three days ago — a gap to "now" exists for every seed
    // unless a test overrides it.
    syncedDateRange: {
      from: Timestamp.fromDate(new Date(Date.now() - 120 * DAY)),
      to: Timestamp.fromDate(new Date(Date.now() - 3 * DAY)),
    },
    ...overrides,
  });
}

async function seedTransaction(daysAgo: number) {
  await db.collection("transactions").add({
    userId: USER,
    date: Timestamp.fromDate(new Date(Date.now() - daysAgo * DAY)),
    amount: 100,
  });
}

async function queueItems(integrationId: string) {
  const snap = await db
    .collection("gmailSyncQueue")
    .where("integrationId", "==", integrationId)
    .get();
  return snap.docs.map((d) => d.data());
}

describe("queueScheduledMailSyncs", () => {
  beforeEach(async () => {
    __resetFirestoreShim();
    await seedTransaction(100);
    await seedTransaction(10);
  });

  it("names both providers the worker can serve", () => {
    expect([...SYNCABLE_MAIL_PROVIDERS].sort()).toEqual(["gmail", "imap"]);
  });

  it("queues an IMAP mailbox that has drifted behind now, exactly like a Gmail one", async () => {
    await seedIntegration("gmail-1", "gmail");
    await seedIntegration("imap-1", "imap");

    const result = await queueScheduledMailSyncs();

    expect(result).toEqual({ queued: 2, skipped: 0 });
    const imapItems = await queueItems("imap-1");
    expect(imapItems).toHaveLength(1);
    expect(imapItems[0]).toMatchObject({
      userId: USER,
      integrationId: "imap-1",
      type: "scheduled",
      status: "pending",
      retryCount: 0,
      maxRetries: 3,
    });
    // The gap starts where the last sync stopped and runs to now.
    const item = imapItems[0] as { dateFrom: Timestamp; dateTo: Timestamp };
    expect(item.dateFrom.toMillis()).toBeGreaterThan(Date.now() - 4 * DAY);
    expect(item.dateTo.toMillis()).toBeGreaterThan(Date.now() - 60 * 1000);
    expect(await queueItems("gmail-1")).toHaveLength(1);
  });

  it("leaves a mailbox alone while its initial sync is still running", async () => {
    await seedIntegration("imap-initial", "imap", { initialSyncComplete: false });

    const result = await queueScheduledMailSyncs();

    expect(result.queued).toBe(0);
    expect(await queueItems("imap-initial")).toHaveLength(0);
  });

  it("skips a paused mailbox and one that needs re-auth", async () => {
    await seedIntegration("imap-paused", "imap", { isPaused: true });
    await seedIntegration("imap-reauth", "imap", { needsReauth: true });

    const result = await queueScheduledMailSyncs();

    expect(result.queued).toBe(0);
    expect(await queueItems("imap-paused")).toHaveLength(0);
    expect(await queueItems("imap-reauth")).toHaveLength(0);
  });

  it("does not stack a second item onto a mailbox that already has one pending", async () => {
    await seedIntegration("imap-1", "imap");
    await db.collection("gmailSyncQueue").add({
      userId: USER,
      integrationId: "imap-1",
      type: "scheduled",
      status: "pending",
    });

    const result = await queueScheduledMailSyncs();

    expect(result).toEqual({ queued: 0, skipped: 1 });
    expect(await queueItems("imap-1")).toHaveLength(1);
  });

  it("ignores providers outside the syncable set", async () => {
    await seedIntegration("other-1", "exchange");

    const result = await queueScheduledMailSyncs();

    expect(result).toEqual({ queued: 0, skipped: 0 });
    expect(await queueItems("other-1")).toHaveLength(0);
  });
});
