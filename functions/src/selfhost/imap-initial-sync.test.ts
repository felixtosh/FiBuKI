/**
 * Hardening test — startImapInitialSync on the selfhost shim.
 *
 * The regression this guards: on a self-host deployment the IMAP connect route
 * runs in the web container, so the `emailIntegrations` write it makes can
 * never reach the trigger bus that lives in the API container. Nothing queued
 * the initial sync, and a connected mailbox sat idle forever while reporting
 * success. The enqueue therefore has to be callable directly from the route,
 * which is what this module exists for.
 *
 * Covers the date-range derivation (transaction span ± 7 days, and the
 * no-transactions fallback), the shape the sync worker expects to poll, and
 * the idempotency guard that keeps route and trigger from stacking two syncs
 * onto one mailbox.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { startImapInitialSync } from "../gmail/startImapInitialSync";

const db = getFirestore();
const USER = "stefan-test";
const INTEGRATION = "integration-1";

async function seedIntegration(id = INTEGRATION) {
  await db.collection("emailIntegrations").doc(id).set({
    userId: USER,
    provider: "imap",
    email: "stefan@example.com",
    isActive: true,
    needsReauth: false,
    imapMailbox: "INBOX",
  });
}

async function seedTransaction(isoDate: string) {
  await db.collection("transactions").add({
    userId: USER,
    date: Timestamp.fromDate(new Date(isoDate)),
    amount: 100,
  });
}

async function queueItems(integrationId = INTEGRATION) {
  const snap = await db
    .collection("gmailSyncQueue")
    .where("integrationId", "==", integrationId)
    .get();
  return snap.docs.map((d) => d.data());
}

describe("startImapInitialSync", () => {
  beforeEach(async () => {
    __resetFirestoreShim();
    await seedIntegration();
  });

  it("queues a pending initial sync the worker can pick up", async () => {
    await seedTransaction("2026-03-01T00:00:00Z");

    const result = await startImapInitialSync({
      integrationId: INTEGRATION,
      userId: USER,
      email: "stefan@example.com",
    });

    expect(result.queued).toBe(true);

    const items = await queueItems();
    expect(items).toHaveLength(1);
    // Shape the sync worker polls for — status/type drive its query.
    expect(items[0]).toMatchObject({
      userId: USER,
      integrationId: INTEGRATION,
      type: "initial",
      status: "pending",
      retryCount: 0,
      maxRetries: 3,
    });
  });

  it("pads the transaction span by seven days either side", async () => {
    await seedTransaction("2026-03-10T00:00:00Z");
    await seedTransaction("2026-06-20T00:00:00Z");

    const result = await startImapInitialSync({
      integrationId: INTEGRATION,
      userId: USER,
      email: "stefan@example.com",
    });

    expect(result.dateFrom?.toISOString().slice(0, 10)).toBe("2026-03-03");
    expect(result.dateTo?.toISOString().slice(0, 10)).toBe("2026-06-27");
  });

  it("falls back to a 90-day window when the user has no transactions", async () => {
    const result = await startImapInitialSync({
      integrationId: INTEGRATION,
      userId: USER,
      email: "stefan@example.com",
    });

    expect(result.queued).toBe(true);
    const spanDays =
      (result.dateTo!.getTime() - result.dateFrom!.getTime()) / (24 * 60 * 60 * 1000);
    expect(Math.round(spanDays)).toBe(90);
  });

  it("marks the integration as started so the sync route stops double-queueing", async () => {
    await startImapInitialSync({
      integrationId: INTEGRATION,
      userId: USER,
      email: "stefan@example.com",
    });

    const snap = await db.collection("emailIntegrations").doc(INTEGRATION).get();
    expect(snap.data()?.initialSyncStartedAt).toBeDefined();
    expect(snap.data()?.isPaused).toBe(false);
  });

  it("is idempotent — route and trigger both firing queues one sync, not two", async () => {
    const first = await startImapInitialSync({
      integrationId: INTEGRATION,
      userId: USER,
      email: "stefan@example.com",
    });
    const second = await startImapInitialSync({
      integrationId: INTEGRATION,
      userId: USER,
      email: "stefan@example.com",
    });

    expect(first.queued).toBe(true);
    expect(second.queued).toBe(false);
    expect(await queueItems()).toHaveLength(1);
  });

  it("queues again once the previous sync has finished", async () => {
    await startImapInitialSync({
      integrationId: INTEGRATION,
      userId: USER,
      email: "stefan@example.com",
    });

    const snap = await db
      .collection("gmailSyncQueue")
      .where("integrationId", "==", INTEGRATION)
      .get();
    await snap.docs[0].ref.update({ status: "completed" });

    const again = await startImapInitialSync({
      integrationId: INTEGRATION,
      userId: USER,
      email: "stefan@example.com",
    });
    expect(again.queued).toBe(true);
    expect(await queueItems()).toHaveLength(2);
  });

  it("does not see another mailbox's in-flight sync", async () => {
    await seedIntegration("integration-2");

    await startImapInitialSync({
      integrationId: INTEGRATION,
      userId: USER,
      email: "stefan@example.com",
    });
    const other = await startImapInitialSync({
      integrationId: "integration-2",
      userId: USER,
      email: "yazzbert@example.com",
    });

    expect(other.queued).toBe(true);
    expect(await queueItems("integration-2")).toHaveLength(1);
  });

  it("notifies the user that the mailbox is syncing", async () => {
    await startImapInitialSync({
      integrationId: INTEGRATION,
      userId: USER,
      email: "stefan@example.com",
    });

    const snap = await db
      .collection("notifications")
      .where("userId", "==", USER)
      .get();
    expect(snap.docs.map((d) => d.data().type)).toContain("mail_service_connected");
  });
});
