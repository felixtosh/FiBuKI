/**
 * #103: an Import no longer bulk-pulls mail over the imported date range. It
 * queues per-Transaction mail search for the incomplete Transactions instead.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { handleTransactionsImported } from "../gmail/onTransactionsImported";
import { queueIncompleteTransactionSearch } from "../precision-search/queueIncompleteSearch";

const db = getFirestore();
const USER = "u1";

async function seedIntegration(overrides: Record<string, unknown> = {}) {
  await db.collection("emailIntegrations").doc("imap-1").set({
    userId: USER,
    provider: "imap",
    email: "u1@example.com",
    isActive: true,
    needsReauth: false,
    initialSyncComplete: true,
    syncedDateRange: {
      from: Timestamp.fromDate(new Date(Date.now() - 2 * 86400000)),
      to: Timestamp.fromDate(new Date()),
    },
    ...overrides,
  });
}

async function seedTransactions() {
  await db.collection("transactions").doc("t-old").set({
    userId: USER,
    isComplete: false,
    importJobId: "imp-1",
    date: Timestamp.fromDate(new Date("2025-02-01")),
  });
  await db.collection("transactions").doc("t-done").set({
    userId: USER,
    isComplete: true,
    importJobId: "imp-1",
    date: Timestamp.fromDate(new Date("2025-02-02")),
  });
}

async function all(collection: string) {
  return (await db.collection(collection).get()).docs.map((d) => d.data());
}

beforeEach(async () => {
  await __resetFirestoreShim();
});

describe("handleTransactionsImported", () => {
  it("queues per-Transaction search, never a bulk mail pull, for history outside the synced range", async () => {
    await seedIntegration();
    await seedTransactions();

    await handleTransactionsImported("imp-1", { userId: USER, importedCount: 2 });

    expect(await all("gmailSyncQueue")).toHaveLength(0);
    const searches = await all("precisionSearchQueue");
    expect(searches).toHaveLength(1);
    expect(searches[0]).toMatchObject({
      userId: USER,
      scope: "all_incomplete",
      triggeredBy: "import",
      triggeredByImportId: "imp-1",
      transactionsToProcess: 1,
      status: "pending",
    });
  });

  it("does nothing without a connected mailbox", async () => {
    await seedTransactions();
    await handleTransactionsImported("imp-1", { userId: USER, importedCount: 2 });
    expect(await all("precisionSearchQueue")).toHaveLength(0);
  });

  it("does nothing for an empty import", async () => {
    await seedIntegration();
    await seedTransactions();
    await handleTransactionsImported("imp-1", { userId: USER, importedCount: 0 });
    expect(await all("precisionSearchQueue")).toHaveLength(0);
  });
});

describe("queueIncompleteTransactionSearch", () => {
  it("does not stack a second search onto one already pending", async () => {
    await seedTransactions();
    const first = await queueIncompleteTransactionSearch(db as never, USER, "gmail_sync");
    const second = await queueIncompleteTransactionSearch(db as never, USER, "import");
    expect(first.queued).toBe(true);
    expect(second.queued).toBe(false);
    expect(await all("precisionSearchQueue")).toHaveLength(1);
  });

  it("queues nothing when every Transaction is complete", async () => {
    await db.collection("transactions").doc("t").set({ userId: USER, isComplete: true });
    expect((await queueIncompleteTransactionSearch(db as never, USER, "import")).queued).toBe(false);
  });
});
