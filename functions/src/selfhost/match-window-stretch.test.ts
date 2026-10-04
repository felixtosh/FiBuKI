/**
 * #614 beyond the matcher's own window tests (matcher.test.ts): a hand edit
 * of a date re-scores the stored suggestions and connects nothing, the
 * one-time rematch of Files the stretch reaches further, and Partner
 * matching's File pool reaching a File the stretch makes possible.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";

// The real trigger, unmodified.
import "../matching/matchFileTransactions";
import { matchFilesForPartnerInternal } from "../matching/matchFilesForPartner";
import { rematchStretchedWindows } from "../matching/stretchedWindowRematch";

const db = getFirestore();
const ME = "stretch-me";
const OTHER = "stretch-other";
const DAY = "2026-09-10";

const isoPlus = (n: number) =>
  new Date(Date.parse(`${DAY}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const plus = (n: number) => Timestamp.fromDate(new Date(`${isoPlus(n)}T00:00:00Z`));

const STALE = {
  transactionId: "t-stale",
  confidence: 55,
  matchSources: ["amount_close"],
  preview: { date: plus(0), amount: -4990, currency: "EUR", name: "STALE", partner: null },
};

/** A File whose matching has finished, as the pipeline leaves it. */
async function seedFile(id: string, extra: Record<string, unknown> = {}) {
  await db.collection("files").doc(id).set({
    userId: ME,
    fileName: `${id}.pdf`,
    fileType: "application/pdf",
    extractionComplete: true,
    partnerMatchComplete: true,
    transactionMatchComplete: true,
    extractedAmount: 4990,
    extractedCurrency: "EUR",
    extractedDate: plus(0),
    extractedPartner: "Hetzner Online GmbH",
    transactionIds: [],
    transactionSuggestions: [STALE],
    ...extra,
  });
}

async function seedTx(id: string, extra: Record<string, unknown> = {}) {
  await db.collection("transactions").doc(id).set({
    userId: ME,
    amount: -4990,
    currency: "EUR",
    date: plus(45),
    name: "HETZNER ONLINE",
    fileIds: [],
    ...extra,
  });
}

const fileData = async (id: string) => (await db.collection("files").doc(id).get()).data()!;
const suggested = async (id: string) =>
  ((await fileData(id)).transactionSuggestions as Array<{ transactionId: string }>).map((s) => s.transactionId);
const connections = async () => (await db.collection("fileConnections").get()).docs.map((d) => d.data());

async function edit(id: string, update: Record<string, unknown>) {
  await db.collection("files").doc(id).update({ ...update, updatedAt: Timestamp.now() });
  await drainTriggers();
}

beforeEach(async () => {
  await __resetFirestoreShim();
  __resetTriggerShim();
  await seedTx("t-late");
});

describe("a hand edit of a date re-scores the stored suggestions (#614)", () => {
  it("a Due Date edit replaces them and connects nothing", async () => {
    await seedFile("f-1");
    await edit("f-1", { extractedDueDate: plus(45) });
    expect(await suggested("f-1")).toEqual(["t-late"]);
    expect(await connections()).toEqual([]);
    expect((await db.collection("transactions").doc("t-late").get()).data()!.fileIds).toEqual([]);
  });

  it("a File date edit replaces them", async () => {
    await seedFile("f-1");
    await edit("f-1", { extractedDate: plus(40) });
    expect(await suggested("f-1")).toEqual(["t-late"]);
    expect(await connections()).toEqual([]);
  });

  it("a Debit Date edit replaces them", async () => {
    await seedFile("f-1");
    await edit("f-1", { extractedDebitDate: plus(44) });
    expect(await suggested("f-1")).toEqual(["t-late"]);
    expect(await connections()).toEqual([]);
  });

  it("an edit of the legacy Due Date row replaces them", async () => {
    await seedFile("f-1");
    await edit("f-1", { extractedAdditionalFields: [{ label: "Zahlungstermin", value: isoPlus(45) }] });
    expect(await suggested("f-1")).toEqual(["t-late"]);
  });

  it("leaves them when the File has a manual File Connection", async () => {
    await seedTx("t-manual", { date: plus(0), amount: -100, fileIds: ["f-1"] });
    await seedFile("f-1", { transactionIds: ["t-manual"] });
    await db.collection("fileConnections").doc("fc-1").set({
      userId: ME,
      fileId: "f-1",
      transactionId: "t-manual",
      connectionType: "manual",
    });
    await edit("f-1", { extractedDueDate: plus(45) });
    expect(await suggested("f-1")).toEqual(["t-stale"]);
  });

  it("leaves them for an edit that moves no date", async () => {
    await seedFile("f-1", { extractedDueDate: plus(45) });
    await edit("f-1", { fileName: "renamed.pdf", extractedDueDate: plus(45) });
    expect(await suggested("f-1")).toEqual(["t-stale"]);
  });

  it("leaves them while matching is still to run", async () => {
    await seedFile("f-1", { transactionMatchComplete: false });
    await edit("f-1", { extractedDueDate: plus(45) });
    expect(await suggested("f-1")).toEqual(["t-stale"]);
  });
});

describe("the one-time rematch of stretched windows (#614)", () => {
  beforeEach(async () => {
    // Stretched, unconnected: re-matched.
    await seedFile("f-stretched", { extractedDueDate: plus(45), transactionSuggestions: [] });
    // Not stretched: left alone.
    await seedFile("f-plain", { extractedDueDate: plus(10), transactionSuggestions: [] });
    // Stretched but connected: left alone.
    await seedTx("t-held", { date: plus(-300), amount: -1, name: "SPAR", fileIds: ["f-connected"] });
    await seedFile("f-connected", {
      extractedDueDate: plus(45),
      transactionIds: ["t-held"],
      transactionSuggestions: [],
    });
  });

  it("reports in a dry run and writes nothing", async () => {
    const report = await rematchStretchedWindows(db, { apply: false });
    expect(report).toMatchObject({ apply: false, filesScanned: 3, filesTouched: 1, newSuggestions: 1 });
    expect(report.scope).toEqual({ kind: "allUsers" });
    expect(report.users).toEqual([{ userId: ME, filesTouched: 1 }]);
    expect(report.changed.map((c) => c.fileId)).toEqual(["f-stretched"]);
    expect(await suggested("f-stretched")).toEqual([]);
    expect(await connections()).toEqual([]);
  });

  it("stores suggestions and auto-connects at the threshold, as an upload does", async () => {
    const dry = await rematchStretchedWindows(db, { apply: false });
    const report = await rematchStretchedWindows(db, { apply: true, allUsers: true });
    expect(report).toMatchObject({ apply: true, filesTouched: 1, newSuggestions: 1 });
    expect(report.autoConnects).toBe(1);
    expect(dry.autoConnects).toBe(1);
    expect(await suggested("f-stretched")).toEqual(["t-late"]);
    expect(await suggested("f-plain")).toEqual([]);
    const made = await connections();
    expect(made).toHaveLength(report.autoConnects);
    for (const c of made) expect(c).toMatchObject({ fileId: "f-stretched", transactionId: "t-late" });
  });

  it("selects an undated File with a Due Date, whose window moved to the Due Date ± 30", async () => {
    await seedFile("f-undated", {
      extractedDate: null,
      extractedDueDate: plus(45),
      transactionSuggestions: [],
    });
    // Undated without any anchor: its window is still the most recent Transactions, untouched.
    await seedFile("f-bare", { extractedDate: null, transactionSuggestions: [] });

    const dry = await rematchStretchedWindows(db, { apply: false });
    expect(dry).toMatchObject({ filesScanned: 5, filesTouched: 2 });
    expect(dry.changed.map((c) => c.fileId).sort()).toEqual(["f-stretched", "f-undated"]);
    expect(await suggested("f-undated")).toEqual([]);

    const report = await rematchStretchedWindows(db, { apply: true, userId: ME });
    expect(report).toMatchObject({ filesTouched: 2 });
    expect(report.users).toEqual([{ userId: ME, filesTouched: 2 }]);
    const undated = report.changed.find((c) => c.fileId === "f-undated");
    expect(undated?.newSuggestions).toEqual(["t-late"]);
    expect(await suggested("f-bare")).toEqual([]);
  });

  it("makes suggestions only for a User in passive mode", async () => {
    await db.collection("subscriptions").doc(ME).set({ userId: ME, automationMode: "passive" });
    const report = await rematchStretchedWindows(db, { apply: true, userId: ME });
    expect(report.autoConnects).toBe(0);
    expect(await suggested("f-stretched")).toEqual(["t-late"]);
    expect(await connections()).toEqual([]);
  });
});

describe("the one-time rematch's scope: one user, or every user said explicitly (#614)", () => {
  beforeEach(async () => {
    await seedFile("f-mine", { extractedDueDate: plus(45), transactionSuggestions: [] });
    // Another user of the same tenant, with the same kind of File and Transaction.
    await db.collection("transactions").doc("t-other").set({
      userId: OTHER,
      amount: -4990,
      currency: "EUR",
      date: plus(45),
      name: "HETZNER ONLINE",
      fileIds: [],
    });
    await seedFile("f-other", { userId: OTHER, extractedDueDate: plus(45), transactionSuggestions: [] });
  });

  it("refuses an apply that names no scope, and writes nothing", async () => {
    await expect(rematchStretchedWindows(db, { apply: true })).rejects.toThrow(/needs a scope/);
    expect(await suggested("f-mine")).toEqual([]);
    expect(await suggested("f-other")).toEqual([]);
    expect(await connections()).toEqual([]);
  });

  it("refuses a user and every user at once", async () => {
    await expect(rematchStretchedWindows(db, { apply: false, userId: ME, allUsers: true })).rejects.toThrow(
      /exclude each other/
    );
  });

  it("with a user, reads and connects only that user's Files", async () => {
    const report = await rematchStretchedWindows(db, { apply: true, userId: ME });
    expect(report.scope).toEqual({ kind: "user", userId: ME });
    expect(report).toMatchObject({ filesScanned: 1, filesTouched: 1 });
    expect(report.users).toEqual([{ userId: ME, filesTouched: 1 }]);
    expect(await suggested("f-mine")).toEqual(["t-late"]);
    expect(await suggested("f-other")).toEqual([]);
    const made = await connections();
    expect(made.length).toBeGreaterThan(0);
    for (const c of made) expect(c).toMatchObject({ fileId: "f-mine", transactionId: "t-late" });
  });

  it("with every user said, covers each user's Files against that user's own Transactions", async () => {
    const report = await rematchStretchedWindows(db, { apply: true, allUsers: true });
    expect(report.scope).toEqual({ kind: "allUsers" });
    expect([...report.users].sort((a, b) => a.userId.localeCompare(b.userId))).toEqual([
      { userId: OTHER, filesTouched: 1 },
      { userId: ME, filesTouched: 1 },
    ].sort((a, b) => a.userId.localeCompare(b.userId)));
    expect(await suggested("f-mine")).toEqual(["t-late"]);
    expect(await suggested("f-other")).toEqual(["t-other"]);
  });

  it("states in a dry run which users it covers", async () => {
    const report = await rematchStretchedWindows(db, { apply: false });
    expect(report.scope).toEqual({ kind: "allUsers" });
    expect(report.users.map((u) => u.userId).sort()).toEqual([OTHER, ME].sort());
    expect(await connections()).toEqual([]);
  });
});

describe("Partner matching's File pool (#614)", () => {
  it("reaches an unassigned File dated more than 30 days before the Transaction its Due Date stretches to", async () => {
    await db.collection("partners").doc("p-1").set({
      userId: ME,
      name: "Hetzner Online GmbH",
      aliases: ["Hetzner"],
      isActive: true,
    });
    await seedTx("t-late", { partnerId: "p-1" });
    await seedFile("f-1", { extractedDueDate: plus(45), transactionSuggestions: [] });

    const result = await matchFilesForPartnerInternal(ME, "p-1");
    expect(result.autoMatched + result.suggested).toBeGreaterThan(0);
  });

  it("does not reach it without the stretch", async () => {
    await db.collection("partners").doc("p-1").set({
      userId: ME,
      name: "Hetzner Online GmbH",
      aliases: ["Hetzner"],
      isActive: true,
    });
    await seedTx("t-late", { partnerId: "p-1" });
    await seedFile("f-1", { transactionSuggestions: [] });

    const result = await matchFilesForPartnerInternal(ME, "p-1");
    expect(result.autoMatched + result.suggested).toBe(0);
  });
});
