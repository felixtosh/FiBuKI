/**
 * Correcting and deleting a Cash Payment (#790, ADR-0017): the User's own
 * entry, so the User may fix a typo in it or remove it, where an imported
 * Transaction stays locked.
 *
 * Driven through the correctCashPayment and deleteCashPayment callables (the
 * web UI) against the self-host database layer. What is asserted is what the
 * User or a later surface sees: the stored row, its activity entry, the Files
 * a delete leaves behind and their activity, and the refusals with their
 * messages.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim, drainTriggers } from "./trigger-shim";

// REAL application code, unmodified:
import { createSourceCallable } from "../sources/createSource";
import {
  addCashPaymentCallable,
  correctCashPaymentCallable,
  deleteCashPaymentCallable,
} from "../transactions/cashPayment";
import { connectFileToTransactionCallable } from "../files/connectFileToTransaction";
import { updateTransactionCallable } from "../transactions/updateTransaction";
import { TOOL_DEFINITIONS } from "../tools/definitions";

const db = getFirestore();
const USER = "cash-user";
const OTHER = "cash-other";
const AUTH = { uid: USER, token: {} };
type Auth = { uid: string; token: Record<string, unknown> };

async function cashBox(name = "Kassa", uid = USER): Promise<string> {
  const { sourceId } = (await createSourceCallable.run({
    data: { data: { name, accountKind: "cash", currency: "EUR", type: "manual" } },
    auth: { uid, token: {} },
  } as never)) as { sourceId: string };
  await drainTriggers();
  return sourceId;
}

async function addByHand(data: Record<string, unknown>): Promise<string> {
  const { transactionId } = (await addCashPaymentCallable.run({ data, auth: AUTH } as never)) as {
    transactionId: string;
  };
  await drainTriggers();
  return transactionId;
}

function correct(data: Record<string, unknown>, auth: Auth = AUTH) {
  return correctCashPaymentCallable.run({ data, auth } as never) as Promise<{ changed: boolean }>;
}

function remove(data: Record<string, unknown>, auth: Auth = AUTH) {
  return deleteCashPaymentCallable.run({ data, auth } as never) as Promise<{ deleted: true; filesDisconnected: number }>;
}

async function stored(transactionId: string) {
  return (await db.collection("transactions").doc(transactionId).get()).data()!;
}

const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));

/** A period the User has marked as filed, as Mark as filed records it. */
async function filed(periodKey: string, period: { year: number; period: number; type: "monthly" | "quarterly" }, uid = USER) {
  await db.collection("uvaFiledRecords").doc().set({
    userId: uid,
    periodKey,
    period,
    kennzahlen: {},
    calculated: {},
    editedByHand: false,
    source: "mark-as-filed",
    filedAt: Timestamp.now(),
    filedBy: uid,
    referenceNumber: null,
    note: null,
  });
}

/** A receipt the extraction has read and the upload pipeline has finished with. */
function receipt(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER,
    fileName: "cafe-central.jpg",
    fileType: "image/jpeg",
    extractionComplete: true,
    partnerMatchComplete: true,
    transactionMatchComplete: true,
    extractedAmount: 900,
    extractedCurrency: "EUR",
    extractedDate: day("2026-07-06"),
    extractedPartner: "Cafe Central",
    invoiceDirection: "incoming",
    transactionIds: [],
    transactionSuggestions: [],
    uploadedAt: day("2026-07-06"),
    ...overrides,
  };
}

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
});

describe("correcting a Cash Payment the User added by hand", () => {
  it("changes its day, amount, direction, name and description", async () => {
    const sourceId = await cashBox();
    const transactionId = await addByHand({ sourceId, date: "2026-07-06", amount: -450, name: "Parkschien" });

    await correct({
      transactionId,
      date: "2026-07-05",
      amount: 4500,
      name: "Parkschein",
      description: "Rückerstattung",
    });

    const row = await stored(transactionId);
    expect(row).toMatchObject({ amount: 4500, name: "Parkschein", description: "Rückerstattung", addedByHand: true });
    expect((row.date as Timestamp).toDate().toISOString()).toBe("2026-07-05T00:00:00.000Z");
  });

  it("appends one activity entry by the User, saying what was before and after", async () => {
    const sourceId = await cashBox();
    const transactionId = await addByHand({ sourceId, date: "2026-07-06", amount: -450, name: "Parkschien" });

    await correct({ transactionId, amount: -540, name: "Parkschein" });

    const log = ((await stored(transactionId)).automationHistory ?? []) as Array<Record<string, unknown>>;
    const corrected = log.filter((e) => e.type === "cash_payment_corrected");
    expect(corrected).toHaveLength(1);
    expect(corrected[0]).toMatchObject({ actor: "manual", status: "completed" });
    expect(corrected[0].summary).toContain("4,50 EUR out");
    expect(corrected[0].summary).toContain("5,40 EUR out");
    expect(corrected[0].summary).toContain("Parkschein");
  });

  it("writes nothing when every value given is already the stored one", async () => {
    const sourceId = await cashBox();
    const transactionId = await addByHand({ sourceId, date: "2026-07-06", amount: -450, name: "Parkschein" });
    const before = await stored(transactionId);

    expect(await correct({ transactionId, date: "2026-07-06", amount: -450, name: " Parkschein " })).toEqual({
      changed: false,
    });

    expect(await stored(transactionId)).toEqual(before);
  });
});

describe("deleting a Cash Payment the User added by hand", () => {
  it("removes the row", async () => {
    const sourceId = await cashBox();
    const transactionId = await addByHand({ sourceId, date: "2026-07-06", amount: -450, name: "Doppelt" });

    expect(await remove({ transactionId })).toMatchObject({ deleted: true, filesDisconnected: 0 });

    expect((await db.collection("transactions").doc(transactionId).get()).exists).toBe(false);
  });

  it("takes its File Connections apart and leaves the Files, each with the disconnect in its activity log", async () => {
    const sourceId = await cashBox();
    const transactionId = await addByHand({ sourceId, date: "2026-07-06", amount: -900, name: "Cafe Central" });
    await db.collection("files").doc("f-cafe").set(receipt());
    await connectFileToTransactionCallable.run({ data: { fileId: "f-cafe", transactionId }, auth: AUTH } as never);
    await drainTriggers();

    expect(await remove({ transactionId })).toMatchObject({ filesDisconnected: 1 });
    await drainTriggers();

    const file = (await db.collection("files").doc("f-cafe").get()).data()!;
    expect(file.transactionIds).toEqual([]);
    expect(file.deletedAt ?? null).toBeNull();
    const log = (file.automationHistory ?? []) as Array<Record<string, unknown>>;
    const gone = log.filter((e) => e.type === "transaction_disconnected" && e.transactionId === transactionId);
    expect(gone).toHaveLength(1);
    expect(gone[0]).toMatchObject({ actor: "manual" });
    expect(gone[0].summary).toContain("Cash Payment");
    const records = await db.collection("fileConnections").where("transactionId", "==", transactionId).get();
    expect(records.empty).toBe(true);
  });

  it("leaves no File suggesting the deleted row", async () => {
    const sourceId = await cashBox();
    await db.collection("files").doc("f-cafe").set(receipt());
    const transactionId = await addByHand({ sourceId, date: "2026-07-06", amount: -900, name: "Cafe Central" });
    const suggested = (await db.collection("files").doc("f-cafe").get()).data()!.transactionSuggestions as Array<{
      transactionId: string;
    }>;
    expect(suggested.map((s) => s.transactionId)).toContain(transactionId);

    await remove({ transactionId });
    await drainTriggers();

    const after = (await db.collection("files").doc("f-cafe").get()).data()!.transactionSuggestions as Array<{
      transactionId: string;
    }>;
    expect(after.map((s) => s.transactionId)).not.toContain(transactionId);
  });
});

describe("what a correction or a delete is refused on", () => {
  /** A CSV row imported into a Cash Box: it has a statement line behind it. */
  async function importedIntoCashBox(): Promise<string> {
    const sourceId = await cashBox();
    await db.collection("transactions").doc("t-csv").set({
      userId: USER,
      sourceId,
      date: day("2026-07-06"),
      amount: -450,
      currency: "EUR",
      name: "Parkschein",
      importJobId: "imp-1",
      csvRowIndex: 3,
      dedupeHash: "abc",
      fileIds: [],
      isComplete: false,
    });
    return "t-csv";
  }

  it("refuses a CSV row imported into a Cash Box, and changes nothing", async () => {
    const transactionId = await importedIntoCashBox();
    const before = await stored(transactionId);

    await expect(correct({ transactionId, amount: -999 })).rejects.toMatchObject({
      code: "failed-precondition",
      message: expect.stringContaining("added by hand"),
    });
    await expect(remove({ transactionId })).rejects.toMatchObject({ code: "failed-precondition" });

    expect(await stored(transactionId)).toEqual(before);
  });

  it("refuses another User's Cash Payment as not found", async () => {
    const theirs = await cashBox("Their Kassa", OTHER);
    const { transactionId } = (await addCashPaymentCallable.run({
      data: { sourceId: theirs, date: "2026-07-06", amount: -450, name: "Theirs" },
      auth: { uid: OTHER, token: {} },
    } as never)) as { transactionId: string };
    await drainTriggers();

    await expect(correct({ transactionId, amount: -1 })).rejects.toMatchObject({ code: "not-found" });
    await expect(remove({ transactionId })).rejects.toMatchObject({ code: "not-found" });
    expect((await db.collection("transactions").doc(transactionId).get()).exists).toBe(true);
  });

  it("refuses a Cash Payment in a quarter whose UVA is filed, naming the quarter", async () => {
    const sourceId = await cashBox();
    const transactionId = await addByHand({ sourceId, date: "2026-07-06", amount: -450, name: "Parkschein" });
    await filed("2026-Q3", { year: 2026, period: 3, type: "quarterly" });

    await expect(correct({ transactionId, amount: -540 })).rejects.toMatchObject({
      code: "failed-precondition",
      message: expect.stringContaining("2026-Q3"),
    });
    await expect(remove({ transactionId })).rejects.toMatchObject({
      code: "failed-precondition",
      message: expect.stringContaining("2026-Q3"),
    });
    expect(await stored(transactionId)).toMatchObject({ amount: -450 });
  });

  it("refuses a Cash Payment in a month whose UVA is filed, naming the month", async () => {
    const sourceId = await cashBox();
    const transactionId = await addByHand({ sourceId, date: "2026-07-06", amount: -450, name: "Parkschein" });
    await filed("2026-M07", { year: 2026, period: 7, type: "monthly" });

    await expect(remove({ transactionId })).rejects.toMatchObject({
      message: expect.stringContaining("2026-M07"),
    });
  });

  it("refuses moving a Cash Payment into a filed period, naming that period", async () => {
    const sourceId = await cashBox();
    const transactionId = await addByHand({ sourceId, date: "2026-10-02", amount: -450, name: "Parkschein" });
    await filed("2026-Q3", { year: 2026, period: 3, type: "quarterly" });

    await expect(correct({ transactionId, date: "2026-09-30" })).rejects.toMatchObject({
      code: "failed-precondition",
      message: expect.stringContaining("2026-Q3"),
    });
    expect(((await stored(transactionId)).date as Timestamp).toDate().toISOString()).toBe("2026-10-02T00:00:00.000Z");
  });

  it("leaves the general Transaction update as strict as before: it refuses the amount on a Cash Payment too", async () => {
    const sourceId = await cashBox();
    const transactionId = await addByHand({ sourceId, date: "2026-07-06", amount: -450, name: "Parkschein" });

    await expect(
      updateTransactionCallable.run({ data: { id: transactionId, data: { amount: -1 } }, auth: AUTH } as never)
    ).rejects.toBeTruthy();
    expect(await stored(transactionId)).toMatchObject({ amount: -450 });
  });

  it("offers no MCP or REST tool that deletes a Cash Payment", () => {
    const names = TOOL_DEFINITIONS.map((d) => d.name);
    expect(names.filter((n) => /cash/i.test(n) && /delete|remove/i.test(n))).toEqual([]);
  });

  it("is not stopped by another User's filed period", async () => {
    const sourceId = await cashBox();
    const transactionId = await addByHand({ sourceId, date: "2026-07-06", amount: -450, name: "Parkschein" });
    await filed("2026-Q3", { year: 2026, period: 3, type: "quarterly" }, OTHER);

    await expect(correct({ transactionId, amount: -540 })).resolves.toEqual({ changed: true });
  });
});
