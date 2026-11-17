/**
 * A Cash Payment added from a File (#789): the User (or an MCP client, or the
 * chat) turns an unconnected receipt into a Cash Payment in one step, and the
 * row is born connected to the File.
 *
 * Driven through the addCashPaymentFromFile callable (the web UI) and
 * handleTool (MCP `add_cash_payment_from_file`), against the self-host
 * database layer. Asserted is what the User or a later surface sees: the
 * stored row, its File Connection (the record and both lists), both activity
 * logs, and each refusal leaving nothing behind.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim, drainTriggers } from "./trigger-shim";

// REAL application code, unmodified:
import { createSourceCallable } from "../sources/createSource";
import { addCashPaymentFromFileCallable } from "../transactions/cashPayment";
import { connectionDocId } from "../fileConnections/rules";
import { handleTool } from "../tools/handlers";
import { TOOL_DEFINITIONS } from "../tools/definitions";
import { agentCaller } from "../tools/caller";

const db = getFirestore();
const USER = "cash-file-user";
const OTHER = "cash-file-other";
const AUTH = { uid: USER, token: {} };

const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));

async function cashBox(name = "Kassa", uid = USER): Promise<string> {
  const { sourceId } = (await createSourceCallable.run({
    data: { data: { name, accountKind: "cash", currency: "EUR", type: "manual" } },
    auth: { uid, token: {} },
  } as never)) as { sourceId: string };
  await drainTriggers();
  return sourceId;
}

function fromFile(data: Record<string, unknown>, auth: { uid: string; token: Record<string, unknown> } = AUTH) {
  return addCashPaymentFromFileCallable.run({ data, auth } as never) as Promise<{ transactionId: string }>;
}

async function stored(collection: string, id: string) {
  return (await db.collection(collection).doc(id).get()).data()!;
}

/** A cash receipt the extraction has read and the upload pipeline has finished with. */
async function receipt(id = "f-cafe", overrides: Record<string, unknown> = {}) {
  await db.collection("files").doc(id).set({
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
    extractedAdditionalFields: [{ key: "paymentMethod", label: "Zahlungsart", value: "cash" }],
    invoiceDirection: "incoming",
    transactionIds: [],
    transactionSuggestions: [],
    uploadedAt: day("2026-07-06"),
    ...overrides,
  });
  return id;
}

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
});

describe("adding a Cash Payment from a File in the web UI", () => {
  it("takes the File's day, gross amount as money out, and the extracted name, marked as added by hand", async () => {
    const sourceId = await cashBox();
    const fileId = await receipt();

    const { transactionId } = await fromFile({ fileId, sourceId });

    const row = await stored("transactions", transactionId);
    expect(row).toMatchObject({
      userId: USER,
      sourceId,
      amount: -900,
      currency: "EUR",
      name: "Cafe Central",
      addedByHand: true,
    });
    expect((row.date as Timestamp).toDate().toISOString()).toBe("2026-07-06T00:00:00.000Z");
  });

  it("is born connected to the File: the record, both lists, and an entry in both activity logs", async () => {
    const sourceId = await cashBox();
    const fileId = await receipt();

    const { transactionId } = await fromFile({ fileId, sourceId });
    await drainTriggers();

    const row = await stored("transactions", transactionId);
    const file = await stored("files", fileId);
    expect(row.fileIds).toEqual([fileId]);
    expect(row.isComplete).toBe(true);
    expect(file.transactionIds).toEqual([transactionId]);
    const record = await db.collection("fileConnections").doc(connectionDocId(fileId, transactionId)).get();
    expect(record.data()).toMatchObject({ userId: USER, fileId, transactionId, origin: "manual" });

    const txLog = (row.automationHistory ?? []) as Array<Record<string, unknown>>;
    expect(txLog.filter((e) => e.type === "cash_payment_added").map((e) => e.actor)).toEqual(["manual"]);
    expect(txLog.filter((e) => e.type === "file_connected").map((e) => e.fileId)).toEqual([fileId]);
    const fileLog = (file.automationHistory ?? []) as Array<Record<string, unknown>>;
    expect(fileLog.filter((e) => e.type === "transaction_connected").map((e) => e.transactionId)).toEqual([
      transactionId,
    ]);
  });

  it("lets the values the User sends win over the File's", async () => {
    const sourceId = await cashBox();
    const fileId = await receipt();
    await db.collection("partners").doc("p-mine").set({ userId: USER, name: "Mein Cafe", aliases: [], ibans: [] });

    const { transactionId } = await fromFile({
      fileId,
      sourceId,
      date: "2026-07-05",
      amount: -1050,
      name: "Kaffee mit Kunde",
      description: "mit Trinkgeld",
      partnerId: "p-mine",
    });

    const row = await stored("transactions", transactionId);
    expect(row).toMatchObject({
      amount: -1050,
      name: "Kaffee mit Kunde",
      description: "mit Trinkgeld",
      partnerId: "p-mine",
      partnerMatchedBy: "manual",
    });
    expect((row.date as Timestamp).toDate().toISOString()).toBe("2026-07-05T00:00:00.000Z");
  });

  it("takes money in from an outgoing invoice, and adds a printed tip to the gross amount", async () => {
    const sourceId = await cashBox();
    const sold = await receipt("f-sold", { invoiceDirection: "outgoing", extractedAmount: 12000 });
    const tipped = await receipt("f-tip", { extractedAmount: 900, extractedTipAmount: 100 });

    const a = await fromFile({ fileId: sold, sourceId });
    const b = await fromFile({ fileId: tipped, sourceId });

    expect((await stored("transactions", a.transactionId)).amount).toBe(12000);
    expect((await stored("transactions", b.transactionId)).amount).toBe(-1000);
  });

  it("takes the File's own Partner as the row's", async () => {
    const sourceId = await cashBox();
    await db.collection("partners").doc("p-cafe").set({ userId: USER, name: "Cafe Central", aliases: [], ibans: [] });
    const fileId = await receipt("f-cafe", { partnerId: "p-cafe", partnerType: "user" });

    const { transactionId } = await fromFile({ fileId, sourceId });

    expect(await stored("transactions", transactionId)).toMatchObject({ partnerId: "p-cafe", partnerType: "user" });
  });

  it("chooses the User's only Cash Box when none is named", async () => {
    const sourceId = await cashBox();
    const fileId = await receipt();

    const { transactionId } = await fromFile({ fileId });

    expect((await stored("transactions", transactionId)).sourceId).toBe(sourceId);
  });

  it("asks which Cash Box when there are several, and says there is none when there is none", async () => {
    const fileId = await receipt();
    await expect(fromFile({ fileId })).rejects.toMatchObject({
      code: "failed-precondition",
      message: expect.stringMatching(/no Cash Box/),
    });

    await cashBox("Kassa Wien");
    await cashBox("Kassa Graz");
    await expect(fromFile({ fileId })).rejects.toMatchObject({
      code: "invalid-argument",
      message: expect.stringMatching(/Kassa Wien.*Kassa Graz|Kassa Graz.*Kassa Wien/),
    });
    expect((await db.collection("transactions").get()).size).toBe(0);
  });
});

describe("adding a Cash Payment from a File over MCP add_cash_payment_from_file", () => {
  it("is defined as a write that takes the File, and optionally the Cash Box and overrides", () => {
    const def = TOOL_DEFINITIONS.find((d) => d.name === "add_cash_payment_from_file")!;
    expect(def.annotation).toBe("write");
    expect(def.inputSchema.required).toEqual(["fileId"]);
    expect(Object.keys(def.inputSchema.properties).sort()).toEqual(
      ["amount", "date", "description", "fileId", "name", "partnerId", "sourceId"].sort()
    );
  });

  it("connects as MCP and logs the actor ai on both sides, whatever an argument claims", async () => {
    await cashBox();
    const fileId = await receipt();

    const res = (await handleTool(USER, "add_cash_payment_from_file", { fileId, actor: "manual", origin: "manual" })) as {
      success: boolean;
      transactionId: string;
    };
    expect(res.success).toBe(true);
    await drainTriggers();

    const row = await stored("transactions", res.transactionId);
    expect(row).toMatchObject({ amount: -900, addedByHand: true, fileIds: [fileId] });
    const record = await db.collection("fileConnections").doc(connectionDocId(fileId, res.transactionId)).get();
    expect(record.data()?.origin).toBe("mcp");
    const log = row.automationHistory as Array<Record<string, unknown>>;
    expect(log.filter((e) => e.type === "cash_payment_added" || e.type === "file_connected").map((e) => e.actor)).toEqual([
      "ai",
      "ai",
    ]);
  });

  it("connects as the chat agent when the server's caller is the agent", async () => {
    await cashBox();
    const fileId = await receipt();

    const res = (await handleTool(USER, "add_cash_payment_from_file", { fileId }, agentCaller(null))) as {
      transactionId: string;
    };
    const record = await db.collection("fileConnections").doc(connectionDocId(fileId, res.transactionId)).get();
    expect(record.data()?.origin).toBe("agent");
  });

  it("is refused on a File already connected, with the same message as the UI", async () => {
    await cashBox();
    const fileId = await receipt("f-done", { transactionIds: ["t-bank"] });
    await expect(handleTool(USER, "add_cash_payment_from_file", { fileId })).rejects.toThrow(/already connected/);
    expect((await db.collection("transactions").get()).size).toBe(0);
  });
});

describe("what a Cash Payment from a File is refused on, leaving no row", () => {
  async function noRows() {
    expect((await db.collection("transactions").get()).size).toBe(0);
  }

  it("a File already connected to a Transaction", async () => {
    const sourceId = await cashBox();
    const fileId = await receipt("f-done", { transactionIds: ["t-bank"] });

    await expect(fromFile({ fileId, sourceId })).rejects.toMatchObject({
      code: "failed-precondition",
      message: expect.stringMatching(/already connected/),
    });
    await noRows();
  });

  it("another User's File, as not found", async () => {
    const sourceId = await cashBox();
    const fileId = await receipt("f-theirs", { userId: OTHER });

    await expect(fromFile({ fileId, sourceId })).rejects.toMatchObject({ code: "not-found" });
    await noRows();
    expect((await stored("files", fileId)).transactionIds).toEqual([]);
  });

  it("another User's Cash Box, as not found", async () => {
    const theirs = await cashBox("Their Kassa", OTHER);
    const fileId = await receipt();

    await expect(fromFile({ fileId, sourceId: theirs })).rejects.toMatchObject({ code: "not-found" });
    await noRows();
  });

  it("a Bank Account that is not a Cash Box", async () => {
    const { sourceId } = (await createSourceCallable.run({
      data: { data: { name: "Erste", accountKind: "bank_account", iban: "AT611904300234573201", currency: "EUR", type: "manual" } },
      auth: AUTH,
    } as never)) as { sourceId: string };
    const fileId = await receipt();

    await expect(fromFile({ fileId, sourceId })).rejects.toMatchObject({
      code: "failed-precondition",
      message: expect.stringMatching(/not a Cash Box/),
    });
    await noRows();
  });

  it("a File with no amount and none sent", async () => {
    const sourceId = await cashBox();
    const fileId = await receipt("f-blank", { extractedAmount: null });

    await expect(fromFile({ fileId, sourceId })).rejects.toMatchObject({ code: "invalid-argument" });
    await noRows();
  });

  it("a Copy, through the File Connection writer's own rule", async () => {
    const sourceId = await cashBox();
    await receipt("f-original");
    const fileId = await receipt("f-copy", { copyOfFileId: "f-original" });

    await expect(fromFile({ fileId, sourceId })).rejects.toMatchObject({ code: "failed-precondition" });
    await noRows();
  });
});
