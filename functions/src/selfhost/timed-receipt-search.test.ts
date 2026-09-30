/**
 * #103 option D: one timed receipt search per open Transaction, at the moment
 * the Partner's invoice is expected to have arrived. Run against the real
 * Postgres-backed shim.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import {
  runTimedReceiptSearches,
  timedSearchDueDate,
  TIMED_SEARCH_MAX_PER_USER,
  TIMED_SEARCH_STAMP,
} from "../precision-search/timedReceiptSearch";

const db = getFirestore();
const USER = "u1";
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-30T04:30:00+02:00");

function daysAgo(n: number): Timestamp {
  return Timestamp.fromDate(new Date(NOW.getTime() - n * DAY));
}

async function mailbox(userId = USER) {
  await db.collection("emailIntegrations").add({
    userId,
    provider: "gmail",
    email: `${userId}@example.com`,
    isActive: true,
    needsReauth: false,
  });
}

/** A Partner whose invoice follows the payment by `lagDays` (negative delay). */
async function partner(id: string, delay: number | null, variance = 1) {
  await db.collection("partners").doc(id).set({
    userId: USER,
    name: id,
    ...(delay === null
      ? {}
      : {
          billingCycle: {
            effective: [
              { source: "learned", frequencyDays: 30, invoiceToTransactionDelay: delay, delayVariance: variance },
            ],
          },
        }),
  });
}

async function tx(id: string, partnerId: string, ageDays: number, extra: Record<string, unknown> = {}) {
  await db.collection("transactions").doc(id).set({
    userId: USER,
    partnerId,
    amount: -4990,
    date: daysAgo(ageDays),
    isComplete: false,
    fileIds: [],
    ...extra,
  });
}

let searched: string[];
const deps = () => ({
  now: NOW,
  queueSearch: vi.fn(async ({ transactionId }: { transactionId: string }) => {
    searched.push(transactionId);
  }),
});

beforeEach(async () => {
  await __resetFirestoreShim();
  searched = [];
});

describe("timedSearchDueDate", () => {
  const paid = new Date("2026-09-01T00:00:00Z");

  it("waits out the lag, the variance and a day of grace when the invoice follows the payment", () => {
    // Delay -5: the invoice arrives five days after the money moved.
    expect(timedSearchDueDate(paid, -5, 2).toISOString()).toBe("2026-09-09T00:00:00.000Z");
  });

  it("still looks once shortly after payment when the invoice normally precedes it", () => {
    expect(timedSearchDueDate(paid, 14, 1).toISOString()).toBe("2026-09-03T00:00:00.000Z");
  });

  it("assumes two days of variance when none was learned", () => {
    expect(timedSearchDueDate(paid, -3, undefined).toISOString()).toBe("2026-09-07T00:00:00.000Z");
  });
});

describe("runTimedReceiptSearches", () => {
  it("searches an open Transaction once its Partner's invoice is due, and stamps it", async () => {
    await mailbox();
    await partner("amazon", -4, 1);
    await tx("t-due", "amazon", 7);

    const report = await runTimedReceiptSearches(deps());

    expect(report).toMatchObject({ users: 1, considered: 1, queued: 1, notDue: 0, unknownDelay: 0 });
    expect(searched).toEqual(["t-due"]);
    const after = (await db.collection("transactions").doc("t-due").get()).data()!;
    expect(after[TIMED_SEARCH_STAMP]).toBeDefined();
  });

  it("does not search before the invoice is due", async () => {
    await mailbox();
    await partner("amazon", -10, 2);
    await tx("t-early", "amazon", 5);

    const report = await runTimedReceiptSearches(deps());

    expect(report.notDue).toBe(1);
    expect(searched).toEqual([]);
  });

  it("never searches the same Transaction twice", async () => {
    await mailbox();
    await partner("amazon", -4, 1);
    await tx("t-due", "amazon", 7);

    await runTimedReceiptSearches(deps());
    const second = await runTimedReceiptSearches(deps());

    expect(second.queued).toBe(0);
    expect(searched).toEqual(["t-due"]);
  });

  it("leaves a Partner without a learned delay to the other channels", async () => {
    await mailbox();
    await partner("unknown", null);
    await tx("t-unknown", "unknown", 20);

    const report = await runTimedReceiptSearches(deps());

    expect(report.unknownDelay).toBe(1);
    expect(searched).toEqual([]);
    const after = (await db.collection("transactions").doc("t-unknown").get()).data()!;
    expect(after[TIMED_SEARCH_STAMP]).toBeUndefined();
  });

  it("skips Transactions that are documented, income, Partner-less, or older than the lookback", async () => {
    await mailbox();
    await partner("amazon", -4, 1);
    await tx("t-file", "amazon", 7, { fileIds: ["f1"] });
    await tx("t-cat", "amazon", 7, { noReceiptCategoryId: "bank-fees" });
    await tx("t-income", "amazon", 7, { amount: 4990 });
    await tx("t-nopartner", "", 7, { partnerId: null });
    await tx("t-old", "amazon", 60);

    const report = await runTimedReceiptSearches(deps());

    expect(report.considered).toBe(0);
    expect(searched).toEqual([]);
  });

  it("skips users without a mailbox or in passive mode", async () => {
    await partner("amazon", -4, 1);
    await tx("t-nomail", "amazon", 7);
    expect((await runTimedReceiptSearches(deps())).users).toBe(0);

    await mailbox();
    await db.collection("subscriptions").doc(USER).set({ automationMode: "passive" });
    expect((await runTimedReceiptSearches(deps())).users).toBe(0);
    expect(searched).toEqual([]);
  });

  it("bounds the AI spend per user per run", async () => {
    await mailbox();
    await partner("amazon", -1, 0);
    for (let i = 0; i < TIMED_SEARCH_MAX_PER_USER + 5; i++) {
      await tx(`t-${i}`, "amazon", 10);
    }

    const report = await runTimedReceiptSearches(deps());

    expect(report.queued).toBe(TIMED_SEARCH_MAX_PER_USER);
  });
});
