/**
 * Hardening test — bulkCreateTransactions callable on the selfhost shim.
 *
 * First callable running through the https-shim: the UNMODIFIED
 * createCallable() wrapper (auth check, usage logging, error wrapping)
 * plus the real import handler, invoked via `.run(request)` exactly like
 * firebase-functions' own unit-test convention. The selfhost HTTP host
 * (work item 3) will mount these same objects behind routes.
 *
 * Covers: auth rejection, source-ownership check, batch-chunked doc
 * creation with UTC-midnight date normalization, the soft transaction
 * quota (over-limit rows imported but flagged), balance-info persistence
 * on the source, fire-and-forget functionCalls usage logging, and billing
 * counter increment.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";
import { HttpsError } from "./https-shim";
import { waitFor } from "./test-helpers";

// REAL application code, unmodified:
import { bulkCreateTransactionsCallable } from "../imports/bulkCreateTransactions";

const db = getFirestore();
const USER = "stefan-test";
const CURRENT_MONTH = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;

function csvTx(i: number, overrides: Record<string, unknown> = {}) {
  return {
    sourceId: "src-n26",
    date: "2026-07-05T22:00:00.000Z",
    amount: -1000 - i,
    currency: "EUR",
    name: `Vendor ${i}`,
    dedupeHash: `hash-${i}`,
    importJobId: "job-1",
    csvRowIndex: i,
    _original: { date: "05.07.2026", amount: `-10,${i}0`, rawRow: {} },
    ...overrides,
  };
}

function call(data: unknown, auth?: { uid: string; token?: Record<string, unknown> }) {
  return bulkCreateTransactionsCallable.run({ data, auth } as never);
}

beforeEach(async () => {
  // Let fire-and-forget writes from the previous test (usage logs, billing
  // increments) land BEFORE the reset, so they can't bleed into this test.
  await new Promise((r) => setTimeout(r, 20));
  await __resetFirestoreShim();
  __resetTriggerShim();
  await db.collection("sources").doc("src-n26").set({
    userId: USER,
    name: "N26 Business",
    type: "manual",
    isActive: true,
  });
  await drainTriggers();
});

describe("selfhost hardening: bulkCreateTransactions callable via https-shim", () => {
  it("rejects unauthenticated calls through the unmodified createCallable wrapper", async () => {
    await expect(call({ transactions: [csvTx(1)], sourceId: "src-n26" })).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  it("rejects imports into another user's source", async () => {
    await db.collection("sources").doc("src-other").set({
      userId: "someone-else",
      name: "Foreign",
      type: "manual",
      isActive: true,
    });

    await expect(
      call(
        { transactions: [csvTx(1, { sourceId: "src-other" })], sourceId: "src-other" },
        { uid: USER },
      ),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("creates transactions with normalized dates and logs the invocation", async () => {
    const res = await call(
      { transactions: [csvTx(1), csvTx(2), csvTx(3)], sourceId: "src-n26" },
      { uid: USER },
    );

    expect(res.success).toBe(true);
    expect(res.count).toBe(3);
    expect(res.quotaExceeded).toBe(false);
    expect(res.transactionIds).toHaveLength(3);

    const tx = (await db.collection("transactions").doc(res.transactionIds[0]).get()).data()!;
    expect(tx.userId).toBe(USER);
    expect(tx.dedupeHash).toBe("hash-1");
    expect(tx.isComplete).toBe(false);
    expect(tx.partnerId).toBeNull();
    // 2026-07-05T22:00 UTC stays July 5 at UTC midnight (no timezone drift)
    const date = tx.date as Timestamp;
    expect(date.toDate().toISOString()).toBe("2026-07-05T00:00:00.000Z");

    // Fire-and-forget usage logging into functionCalls
    await waitFor(async () => {
      const logs = await db
        .collection("functionCalls")
        .where("functionName", "==", "bulkCreateTransactions")
        .where("status", "==", "success")
        .get();
      return logs.size === 1;
    });
  });

  it("imports past the soft quota, flags over-limit rows, bills only within-quota rows", async () => {
    await db.collection("subscriptions").doc(USER).set({
      userId: USER,
      plan: "free", // limit 50
      transactionCountCurrentMonth: 48,
      transactionCountMonth: CURRENT_MONTH,
    });
    await drainTriggers();

    const res = await call(
      { transactions: [1, 2, 3, 4, 5].map((i) => csvTx(i)), sourceId: "src-n26" },
      { uid: USER },
    );

    expect(res.count).toBe(5); // soft limit: everything imported
    expect(res.quotaExceeded).toBe(true);
    expect(res.overLimitCount).toBe(3); // 50 - 48 = 2 slots remain
    expect(res.overLimitTransactionIds).toHaveLength(3);

    const flagged = (
      await db.collection("transactions").doc(res.overLimitTransactionIds[0]).get()
    ).data()!;
    expect(flagged.quotaExceeded).toBe(true);
    const within = (await db.collection("transactions").doc(res.transactionIds[0]).get()).data()!;
    expect(within.quotaExceeded ?? null).toBeNull();

    // Fire-and-forget billing increment counts only the 2 within-quota rows
    await waitFor(async () => {
      const sub = (await db.collection("subscriptions").doc(USER).get()).data()!;
      return sub.transactionCountCurrentMonth === 50;
    });
  });

  it("admin token bypasses the quota entirely", async () => {
    await db.collection("subscriptions").doc(USER).set({
      userId: USER,
      plan: "free",
      transactionCountCurrentMonth: 50,
      transactionCountMonth: CURRENT_MONTH,
    });
    await drainTriggers();

    const res = await call(
      { transactions: [csvTx(1)], sourceId: "src-n26" },
      { uid: USER, token: { admin: true } },
    );
    expect(res.quotaExceeded).toBe(false);
    expect(res.overLimitCount).toBe(0);
  });

  it("persists balance info on the source (opening balance only when earlier)", async () => {
    await call(
      {
        transactions: [csvTx(1)],
        sourceId: "src-n26",
        balanceInfo: {
          openingBalance: 100000,
          openingBalanceDate: "2026-01-01T00:00:00.000Z",
          latestBalance: 250000,
          latestBalanceDate: "2026-07-01T00:00:00.000Z",
        },
      },
      { uid: USER },
    );

    let source = (await db.collection("sources").doc("src-n26").get()).data()!;
    expect(source.openingBalance).toBe(100000);
    expect(source.openingBalanceSource).toBe("csv_derived");
    expect(source.latestBalance).toBe(250000);

    // Later opening date must NOT overwrite; latest balance always updates.
    await call(
      {
        transactions: [csvTx(2)],
        sourceId: "src-n26",
        balanceInfo: {
          openingBalance: 999999,
          openingBalanceDate: "2026-03-01T00:00:00.000Z",
          latestBalance: 260000,
          latestBalanceDate: "2026-07-10T00:00:00.000Z",
        },
      },
      { uid: USER },
    );

    source = (await db.collection("sources").doc("src-n26").get()).data()!;
    expect(source.openingBalance).toBe(100000); // unchanged
    expect(source.latestBalance).toBe(260000);
  });

  it("wraps invalid input as a typed HttpsError and logs the failure", async () => {
    await expect(
      call(
        { transactions: [csvTx(1, { date: "not-a-date" })], sourceId: "src-n26" },
        { uid: USER },
      ),
    ).rejects.toSatisfy((e: unknown) => e instanceof HttpsError && e.code === "invalid-argument");

    await waitFor(async () => {
      const logs = await db
        .collection("functionCalls")
        .where("functionName", "==", "bulkCreateTransactions")
        .where("status", "==", "error")
        .get();
      return logs.size === 1;
    });
  });
});
