/**
 * #103: connecting, reconnecting or resuming a mailbox activates it for
 * per-Transaction receipt search. No Sync is ever queued.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { activateMailIntegration } from "../mail/activateMailIntegration";

const db = getFirestore();
const USER = "u1";

async function all(collection: string) {
  return (await db.collection(collection).get()).docs.map((d) => d.data());
}

beforeEach(async () => {
  await __resetFirestoreShim();
  await db.collection("emailIntegrations").doc("g1").set({
    userId: USER,
    provider: "gmail",
    email: "felix@example.com",
    isActive: true,
    needsReauth: false,
    isPaused: true,
    initialSyncStartedAt: Timestamp.now(),
  });
  await db.collection("transactions").doc("t1").set({ userId: USER, isComplete: false });
});

describe("activateMailIntegration", () => {
  it("marks the mailbox ready, unpaused, and queues the per-Transaction search", async () => {
    const res = await activateMailIntegration({
      integrationId: "g1",
      userId: USER,
      email: "felix@example.com",
      reason: "mail_service_connected",
    });

    expect(res).toEqual({ searchQueued: true, transactionsToProcess: 1 });
    const integration = (await db.collection("emailIntegrations").doc("g1").get()).data()!;
    expect(integration.initialSyncComplete).toBe(true);
    expect(integration.isPaused).toBe(false);
    expect(integration.initialSyncStartedAt).toBeUndefined();
    const searches = await all("precisionSearchQueue");
    expect(searches).toHaveLength(1);
    expect(searches[0]).toMatchObject({ triggeredBy: "mail_service_connected", integrationId: "g1" });
  });

  it("never queues a Sync", async () => {
    await activateMailIntegration({ integrationId: "g1", userId: USER, email: "x", reason: "mail_service_resumed" });
    expect(await all("gmailSyncQueue")).toHaveLength(0);
  });

  it("notifies where the app reads, unless told not to", async () => {
    await activateMailIntegration({ integrationId: "g1", userId: USER, email: "x", reason: "mail_service_connected" });
    await activateMailIntegration({ integrationId: "g1", userId: USER, email: "x", reason: "mail_service_resumed", notify: false });
    const notes = await all(`users/${USER}/notifications`);
    expect(notes).toHaveLength(1);
    expect(notes[0].readAt).toBeNull();
  });

  it("is safe to run twice: the second search is not stacked", async () => {
    await activateMailIntegration({ integrationId: "g1", userId: USER, email: "x", reason: "mail_service_connected" });
    const second = await activateMailIntegration({ integrationId: "g1", userId: USER, email: "x", reason: "mail_service_connected", notify: false });
    expect(second.searchQueued).toBe(false);
    expect(await all("precisionSearchQueue")).toHaveLength(1);
  });
});
