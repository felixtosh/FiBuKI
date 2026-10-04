/**
 * #139, the forwards half: a Transaction's Partner changing refreshes the
 * `transactionSuggestions` of the affected Partners' unconnected Files.
 *
 * Decision (Felix, 2026-09-27): once per affected Partner, unconnected Files
 * of the old and the new Partner, suggestions only. Since #613 the refresh
 * stores what the trigger stores, the Remainder included.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { rescoreUnconnectedFilesForPartners } from "../matching/rescorePartnerFiles";
import { transactionsForFile, storedSuggestionsOf } from "../matching/matcher";

const db = getFirestore();
const ME = "rescore-me";

const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));

type Suggestion = { transactionId: string; confidence: number; matchSources: string[] };

async function seedFile(id: string, extra: Record<string, unknown> = {}) {
  await db.collection("files").doc(id).set({
    userId: ME,
    fileName: `${id}.pdf`,
    partnerId: "p1",
    extractionComplete: true,
    transactionMatchComplete: true,
    extractedAmount: 1000,
    extractedCurrency: "EUR",
    extractedDate: day("2026-01-05"),
    extractedPartner: "Acme",
    transactionIds: [],
    transactionSuggestions: [],
    ...extra,
  });
}

const fileData = async (id: string) => (await db.collection("files").doc(id).get()).data()!;

beforeEach(async () => {
  await __resetFirestoreShim();
  await db.collection("partners").doc("p1").set({ userId: ME, name: "Acme GmbH", aliases: [] });
  await db.collection("transactions").doc("t1").set({
    userId: ME,
    amount: -1000,
    currency: "EUR",
    date: day("2026-01-06"),
    name: "Acme GmbH 4711",
    partnerId: "p1",
    fileIds: [],
  });
});

describe("rescoreUnconnectedFilesForPartners", () => {
  it("refreshes the suggestions of an unconnected File of the Partner, and nothing else", async () => {
    await seedFile("f1");

    const result = await rescoreUnconnectedFilesForPartners(db, ME, ["p1"]);

    expect(result.filesRescored).toBe(1);
    const after = await fileData("f1");
    const [top] = after.transactionSuggestions as Suggestion[];
    expect(top.transactionId).toBe("t1");
    // The whole point of #139: the Partner now on the Transaction counts.
    expect(top.matchSources).toContain("partner");
    // Suggestions only: no connection, pipeline flags untouched.
    expect(after.transactionIds).toEqual([]);
    expect(after.transactionMatchComplete).toBe(true);
    expect((await db.collection("fileConnections").get()).size).toBe(0);
  });

  it("leaves connected Files and Files still in the pipeline alone", async () => {
    await seedFile("f-connected", { transactionIds: ["t9"] });
    await seedFile("f-pending", { transactionMatchComplete: false });

    const result = await rescoreUnconnectedFilesForPartners(db, ME, ["p1"]);

    expect(result.filesRescored).toBe(0);
  });

  it("leaves Files the matcher never matches alone", async () => {
    await seedFile("f-deleted", { deletedAt: day("2026-01-01") });
    await seedFile("f-not-invoice", { isNotInvoice: true });
    await seedFile("f-foreign", { foreignRecipient: true });

    const result = await rescoreUnconnectedFilesForPartners(db, ME, ["p1"]);

    expect(result.filesRescored).toBe(0);
  });

  it("processes each affected Partner once", async () => {
    const result = await rescoreUnconnectedFilesForPartners(db, ME, ["p1", "p1", ""]);
    expect(result.partnersProcessed).toBe(1);
  });

  it("keeps the Remainder score the trigger stores (#613)", async () => {
    // A 500,00 line that already holds a 285,80 invoice; the 214,20 one
    // explains exactly what is left.
    await db.collection("transactions").doc("t-half").set({
      userId: ME,
      amount: -50000,
      currency: "EUR",
      date: day("2026-01-06"),
      name: "SAMMELUEBERWEISUNG",
      partnerId: "p1",
      fileIds: ["f-first"],
    });
    await seedFile("f-first", { extractedAmount: 28580, transactionIds: ["t-half"] });
    await db.collection("fileConnections").doc("c-first").set({
      userId: ME,
      fileId: "f-first",
      transactionId: "t-half",
    });
    await seedFile("f-second", { extractedAmount: 21420 });

    await rescoreUnconnectedFilesForPartners(db, ME, ["p1"]);

    const stored = (await fileData("f-second")).transactionSuggestions as Suggestion[];
    const onHalf = stored.find((s) => s.transactionId === "t-half");
    // The sweep used to score this pair against the full 500,00.
    expect(onHalf?.matchSources).toContain("amount_remainder");

    const trigger = storedSuggestionsOf(
      (await transactionsForFile(db, ME, { id: "f-second", data: await fileData("f-second") })).matches
    );
    expect(stored.map((s) => [s.transactionId, s.confidence])).toEqual(
      trigger.map((s) => [s.transactionId, s.confidence])
    );
  });
});
