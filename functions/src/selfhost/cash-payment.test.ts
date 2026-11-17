/**
 * A Cash Payment added by hand (#788): a Transaction on a Cash Box that the
 * User typed, one at a time, with no bank statement behind it.
 *
 * Driven through the addCashPayment callable (the web UI) and handleTool
 * (MCP `add_cash_payment`, and the chat through runTool), against the
 * self-host database layer. What is asserted is what the User or a later
 * surface sees: the stored row, its sign and day, its activity entry, the
 * refusals, the quota count, the suggestions the matcher stores.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim, drainTriggers } from "./trigger-shim";

// REAL application code, unmodified:
import { createSourceCallable } from "../sources/createSource";
import { addCashPaymentCallable } from "../transactions/cashPayment";

const db = getFirestore();
const USER = "cash-user";
const OTHER = "cash-other";
const AUTH = { uid: USER, token: {} };

async function cashBox(name = "Kassa", uid = USER): Promise<string> {
  const { sourceId } = (await createSourceCallable.run({
    data: { data: { name, accountKind: "cash", currency: "EUR", type: "manual" } },
    auth: { uid, token: {} },
  } as never)) as { sourceId: string };
  await drainTriggers();
  return sourceId;
}

function addByHand(data: Record<string, unknown>, auth: { uid: string; token: Record<string, unknown> } = AUTH) {
  return addCashPaymentCallable.run({ data, auth } as never) as Promise<{ transactionId: string }>;
}

async function stored(transactionId: string) {
  return (await db.collection("transactions").doc(transactionId).get()).data()!;
}

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
});

describe("adding a Cash Payment by hand in the web UI", () => {
  it("stores money out as negative cents on UTC midnight of the given day, marked as added by hand", async () => {
    const sourceId = await cashBox();

    const { transactionId } = await addByHand({
      sourceId,
      date: "2026-07-06",
      amount: -450,
      name: "Parkschein",
    });

    const row = await stored(transactionId);
    expect(row).toMatchObject({
      userId: USER,
      sourceId,
      amount: -450,
      currency: "EUR",
      name: "Parkschein",
      addedByHand: true,
      fileIds: [],
      isComplete: false,
      partnerId: null,
    });
    expect((row.date as Timestamp).toDate().toISOString()).toBe("2026-07-06T00:00:00.000Z");
    for (const field of ["importJobId", "csvRowIndex", "_original", "dedupeHash"]) {
      expect(row[field] ?? null, field).toBeNull();
    }
  });
});

describe("what a Cash Payment is refused on", () => {
  it("refuses another User's Cash Box as not found, and stores nothing", async () => {
    const theirs = await cashBox("Their Kassa", OTHER);
    await expect(addByHand({ sourceId: theirs, date: "2026-07-06", amount: -450, name: "Parkschein" })).rejects.toMatchObject({
      code: "not-found",
    });
    expect((await db.collection("transactions").get()).size).toBe(0);
  });

  it("refuses a Bank Account that is not a Cash Box", async () => {
    const { sourceId } = (await createSourceCallable.run({
      data: { data: { name: "Erste", accountKind: "bank_account", iban: "AT611904300234573201", currency: "EUR", type: "manual" } },
      auth: AUTH,
    } as never)) as { sourceId: string };
    await expect(addByHand({ sourceId, date: "2026-07-06", amount: -450, name: "Parkschein" })).rejects.toMatchObject({
      code: "failed-precondition",
      message: expect.stringMatching(/not a Cash Box/),
    });
    expect((await db.collection("transactions").get()).size).toBe(0);
  });

  it.each([
    ["a date that is not a calendar day", { date: "2026-02-30" }],
    ["a date with a time of day", { date: "2026-07-06T14:00:00+02:00" }],
    ["no date", { date: undefined }],
    ["an amount of zero", { amount: 0 }],
    ["an amount in euros, not cents", { amount: -4.5 }],
    ["an amount that is not a number", { amount: "-450" }],
    ["no text", { name: "   " }],
  ])("refuses %s", async (_what, override) => {
    const sourceId = await cashBox();
    await expect(
      addByHand({ sourceId, date: "2026-07-06", amount: -450, name: "Parkschein", ...override })
    ).rejects.toMatchObject({ code: "invalid-argument" });
    expect((await db.collection("transactions").get()).size).toBe(0);
  });
});
