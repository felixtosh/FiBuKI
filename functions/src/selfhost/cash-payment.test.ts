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
import { handleTool } from "../tools/handlers";
import { TOOL_DEFINITIONS } from "../tools/definitions";
import { agentCaller } from "../tools/caller";
import { connectFileToTransactionCallable } from "../files/connectFileToTransaction";
import { calculateUvaCallable } from "../reports/calculateUvaCallable";
import { requestBmdExportCallable } from "../bmd-export/requestBmdExport";
import "../bmd-export/processBmdExportQueue";
import * as unzipper from "unzipper";
import { getStorage } from "./storage-shim";
import { waitFor } from "./test-helpers";

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

  it("stores money in as positive cents, with the User's description", async () => {
    const sourceId = await cashBox();
    const { transactionId } = await addByHand({
      sourceId,
      date: "2026-07-06",
      amount: 2000,
      name: "Bar kassiert",
      description: "Workshop, Teilnehmer bezahlt bar",
    });
    expect(await stored(transactionId)).toMatchObject({ amount: 2000, description: "Workshop, Teilnehmer bezahlt bar" });
  });

  it("appends one activity entry, by the User", async () => {
    const sourceId = await cashBox();
    const { transactionId } = await addByHand({ sourceId, date: "2026-07-06", amount: -450, name: "Parkschein" });

    const log = ((await stored(transactionId)).automationHistory ?? []) as Array<Record<string, unknown>>;
    const added = log.filter((e) => e.type === "cash_payment_added");
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ actor: "manual", status: "completed", level: "decision" });
    // Amounts read as every other activity entry writes them: a point, the currency, then the direction.
    expect(added[0].summary).toBe("Cash Payment added by hand: 4.50 EUR out");
  });

  it("takes a Partner the User owns, as the User's own choice", async () => {
    const sourceId = await cashBox();
    await db.collection("partners").doc("p-cafe").set({ userId: USER, name: "Cafe Central", aliases: [], ibans: [] });

    const { transactionId } = await addByHand({
      sourceId,
      date: "2026-07-06",
      amount: -900,
      name: "Kaffee mit Kunde",
      partnerId: "p-cafe",
    });

    expect(await stored(transactionId)).toMatchObject({
      partnerId: "p-cafe",
      partnerType: "user",
      partnerMatchedBy: "manual",
      partnerMatchConfidence: 100,
    });
  });

  it("refuses another User's Partner, and a Merged Partner naming its survivor", async () => {
    const sourceId = await cashBox();
    await db.collection("partners").doc("p-theirs").set({ userId: OTHER, name: "Theirs", aliases: [], ibans: [] });
    await db.collection("partners").doc("p-old").set({ userId: USER, name: "Old", mergedInto: "p-new", aliases: [], ibans: [] });

    const base = { sourceId, date: "2026-07-06", amount: -900, name: "Kaffee" };
    await expect(addByHand({ ...base, partnerId: "p-theirs" })).rejects.toMatchObject({ code: "not-found" });
    await expect(addByHand({ ...base, partnerId: "p-old" })).rejects.toMatchObject({
      message: expect.stringContaining("p-new"),
    });
    expect((await db.collection("transactions").get()).size).toBe(0);
  });

  it("keeps two identical Cash Payments on one day", async () => {
    const sourceId = await cashBox();
    const coffee = { sourceId, date: "2026-07-06", amount: -350, name: "Kaffee" };
    const a = await addByHand(coffee);
    const b = await addByHand(coffee);
    expect(a.transactionId).not.toBe(b.transactionId);
    expect((await db.collection("transactions").where("sourceId", "==", sourceId).get()).size).toBe(2);
  });

  it("counts against the transaction quota like an import, and is flagged once over it", async () => {
    const month = new Date().toISOString().slice(0, 7);
    const sourceId = await cashBox();
    await db.collection("subscriptions").doc(USER).set({
      plan: "free",
      transactionCountCurrentMonth: 0,
      transactionCountMonth: month,
    });

    const first = await addByHand({ sourceId, date: "2026-07-06", amount: -450, name: "Parkschein" });
    await __whenShimIdle();
    expect((await db.collection("subscriptions").doc(USER).get()).data()!.transactionCountCurrentMonth).toBe(1);
    expect((await stored(first.transactionId)).quotaExceeded ?? false).toBe(false);

    const { PLANS } = await import("../billing/config");
    await db.collection("subscriptions").doc(USER).update({ transactionCountCurrentMonth: PLANS.free.transactionLimit });
    const over = await addByHand({ sourceId, date: "2026-07-06", amount: -450, name: "Parkschein" });
    await __whenShimIdle();
    // Imported but flagged, as an import's over-limit rows are; not counted.
    expect((await stored(over.transactionId)).quotaExceeded).toBe(true);
    expect((await db.collection("subscriptions").doc(USER).get()).data()!.transactionCountCurrentMonth).toBe(
      PLANS.free.transactionLimit
    );
  });
});

describe("adding a Cash Payment over MCP add_cash_payment", () => {
  it("is defined as a write that takes the Cash Box, the day, signed cents and the text", () => {
    const def = TOOL_DEFINITIONS.find((d) => d.name === "add_cash_payment")!;
    expect(def.annotation).toBe("write");
    expect(def.inputSchema.required).toEqual(["sourceId", "date", "amount", "name"]);
    expect(Object.keys(def.inputSchema.properties).sort()).toEqual(
      ["amount", "date", "description", "name", "partnerId", "sourceId"].sort()
    );
  });

  it("stores the row as the UI does, with the activity actor ai and an API Partner assignment", async () => {
    const sourceId = await cashBox();
    await db.collection("partners").doc("p-cafe").set({ userId: USER, name: "Cafe Central", aliases: [], ibans: [] });

    const res = (await handleTool(USER, "add_cash_payment", {
      sourceId,
      date: "2026-07-06",
      amount: -900,
      name: "Kaffee mit Kunde",
      partnerId: "p-cafe",
    })) as { success: boolean; transactionId: string };
    expect(res.success).toBe(true);

    const row = await stored(res.transactionId);
    expect(row).toMatchObject({ amount: -900, addedByHand: true, partnerId: "p-cafe", partnerMatchedBy: "api" });
    const added = (row.automationHistory as Array<Record<string, unknown>>).filter((e) => e.type === "cash_payment_added");
    expect(added).toHaveLength(1);
    expect(added[0].actor).toBe("ai");
  });

  it("records the chat agent as ai, read from the server's caller", async () => {
    const sourceId = await cashBox();
    await db.collection("partners").doc("p-cafe").set({ userId: USER, name: "Cafe Central", aliases: [], ibans: [] });

    const res = (await handleTool(
      USER,
      "add_cash_payment",
      { sourceId, date: "2026-07-06", amount: -900, name: "Kaffee", partnerId: "p-cafe" },
      agentCaller(null)
    )) as { transactionId: string };
    const row = await stored(res.transactionId);
    expect(row.partnerMatchedBy).toBe("ai");
    expect((row.automationHistory as Array<Record<string, unknown>>)[0].actor).toBe("ai");
  });

  it("never takes the actor from an argument", async () => {
    const sourceId = await cashBox();
    const res = (await handleTool(USER, "add_cash_payment", {
      sourceId,
      date: "2026-07-06",
      amount: -450,
      name: "Parkschein",
      actor: "manual",
      author: "manual",
      addedBy: "manual",
    })) as { transactionId: string };
    const added = ((await stored(res.transactionId)).automationHistory as Array<Record<string, unknown>>).filter(
      (e) => e.type === "cash_payment_added"
    );
    expect(added[0].actor).toBe("ai");
  });

  it("refuses a Bank Account that is not a Cash Box, and another User's Cash Box", async () => {
    const theirs = await cashBox("Their Kassa", OTHER);
    const { sourceId: bank } = (await handleTool(USER, "create_source", {
      name: "Erste",
      iban: "AT611904300234573201",
    })) as { sourceId: string };
    const base = { date: "2026-07-06", amount: -450, name: "Parkschein" };

    await expect(handleTool(USER, "add_cash_payment", { ...base, sourceId: bank })).rejects.toThrow(/not a Cash Box/);
    await expect(handleTool(USER, "add_cash_payment", { ...base, sourceId: theirs })).rejects.toThrow(/not found/);
    expect((await db.collection("transactions").get()).size).toBe(0);
  });
});

const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));

/** A receipt the extraction has read and the upload pipeline has finished with. */
function cafeReceipt(overrides: Record<string, unknown> = {}) {
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

describe("after a Cash Payment is added: the same matching an imported row gets", () => {
  it("runs Partner matching when no Partner was given", async () => {
    const sourceId = await cashBox();
    await db.collection("partners").doc("p-cafe").set({
      userId: USER,
      name: "Cafe Central",
      aliases: ["Cafe Central"],
      ibans: [],
      isActive: true,
    });

    const { transactionId } = await addByHand({ sourceId, date: "2026-07-06", amount: -900, name: "Cafe Central" });
    await drainTriggers();

    const row = await stored(transactionId);
    const suggested = ((row.partnerSuggestions ?? []) as Array<{ partnerId: string }>).map((s) => s.partnerId);
    expect(row.partnerId === "p-cafe" || suggested.includes("p-cafe")).toBe(true);
  });

  it("puts the Cash Payment into the suggestions of an unconnected File the matcher pairs it with", async () => {
    const sourceId = await cashBox();
    await db.collection("files").doc("f-cafe").set(cafeReceipt());

    const { transactionId } = await addByHand({ sourceId, date: "2026-07-06", amount: -900, name: "Cafe Central" });
    await drainTriggers();

    const file = (await db.collection("files").doc("f-cafe").get()).data()!;
    expect((file.transactionSuggestions as Array<{ transactionId: string }>)[0]?.transactionId).toBe(transactionId);
  });

  it("leaves a File connected elsewhere alone", async () => {
    const sourceId = await cashBox();
    await db.collection("files").doc("f-done").set(cafeReceipt({ transactionIds: ["t-elsewhere"] }));

    await addByHand({ sourceId, date: "2026-07-06", amount: -900, name: "Cafe Central" });
    await drainTriggers();

    expect((await db.collection("files").doc("f-done").get()).data()!.transactionSuggestions).toEqual([]);
  });

  it("is the top suggestion for a File uploaded after it, through the matcher's own callable", async () => {
    const sourceId = await cashBox();
    const { transactionId } = await addByHand({ sourceId, date: "2026-07-06", amount: -900, name: "Cafe Central" });
    await drainTriggers();
    await db.collection("files").doc("f-later").set(cafeReceipt({ fileName: "later.jpg" }));

    const { findTransactionMatchesForFile } = await import("../matching/findTransactionMatches");
    const res = (await (findTransactionMatchesForFile as unknown as {
      run: (req: unknown) => Promise<{ matches: Array<{ transactionId: string }> }>;
    }).run({ data: { fileId: "f-later" }, auth: AUTH })) as { matches: Array<{ transactionId: string }> };
    expect(res.matches[0]?.transactionId).toBe(transactionId);
  });
});

describe("a Cash Payment counts like a bank row: the UVA and the BMD export agree on it", () => {
  /** 12,00 paid in cash in March 2026, its invoice File (20% VAT, 2,00) connected by the User. */
  async function cashPaymentWithInvoice() {
    const sourceId = await cashBox();
    const { transactionId } = await addByHand({ sourceId, date: "2026-03-15", amount: -1200, name: "BUEROMARKT" });
    await db.collection("files").doc("f-invoice").set(
      cafeReceipt({
        fileName: "bueromarkt-rechnung.pdf",
        extractedAmount: 1200,
        extractedVatAmount: 200,
        extractedVatPercent: 20,
        extractedDate: day("2026-03-15"),
        extractedPartner: "Bueromarkt",
      })
    );
    await connectFileToTransactionCallable.run({
      data: { fileId: "f-invoice", transactionId },
      auth: AUTH,
    } as never);
    await drainTriggers();
    return transactionId;
  }

  it("the UVA for its quarter claims its input VAT", async () => {
    await cashPaymentWithInvoice();
    const { result } = (await calculateUvaCallable.run({
      data: { period: { year: 2026, period: 1, type: "quarterly" } },
      auth: AUTH,
    } as never)) as { result: { totalInputVat: number } };
    expect(result.totalInputVat).toBe(200);
  });

  it("the BMD export books the row", async () => {
    await cashPaymentWithInvoice();
    const res = (await requestBmdExportCallable.run({
      data: { dateFrom: "2026-01-01", dateTo: "2026-12-31", onlyWithFiles: true, includeFiles: false },
      auth: AUTH,
    } as never)) as { exportId: string };
    const exportRef = db.collection("bmdExports").doc(res.exportId);
    await waitFor(async () => ["completed", "failed"].includes((await exportRef.get()).data()!.status as string));
    const run = (await exportRef.get()).data()!;
    expect(run.status).toBe("completed");

    const [zip] = await getStorage().bucket().file(run.storagePath as string).download();
    const dir = await unzipper.Open.buffer(zip);
    const buchungen = (await dir.files.find((f) => f.path === "buchungen.csv")!.buffer()).toString("utf8");
    const rows = buchungen.split("\n").slice(1).filter(Boolean);
    expect(rows).toHaveLength(1);
    const cols = rows[0].split(";");
    // betrag 12,00 gross, steuer 2,00 at 20%
    expect([cols[6], cols[8], cols[9]]).toEqual(["12,00", "2,00", "20"]);
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
