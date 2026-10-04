/**
 * #613: one fixture per divergence a surface had from the matcher, each
 * driven through the surface itself. The rules are held at the matcher's
 * interface in matcher.test.ts; these show each old path now follows them.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { findTransactionMatchesForFile } from "../matching/findTransactionMatches";
import { findFileMatchesForTransactionCallable } from "../matching/findFileMatches";
import { findReceiptForTransactionCallable } from "../workflows/findReceiptForTransactionCallable";
import { findPartnerBatchTransactionsCallable } from "../matching/findPartnerBatchTransactions";
import type { FindReceiptResult } from "../workflows/findReceiptForTransaction";
import { matchFilesForPartnerInternal } from "../matching/matchFilesForPartner";
import { rescoreConnections, UNDATED_RECENT_TRANSACTIONS } from "../matching/matcher";
import { storeEcbDays } from "../fx/ecbRateStore";

const db = getFirestore();
const ME = "surfaces-me";

const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));
const DAY = "2026-03-10";

type Match = { transactionId: string; confidence: number; matchSources: string[]; hidden?: string };
type FileMatch = { fileId: string; confidence: number; hidden?: string };

function dialog(data: Record<string, unknown>) {
  return (
    findTransactionMatchesForFile as unknown as (req: unknown) => Promise<{
      matches: Match[];
      ineligible?: string;
    }>
  )({ auth: { uid: ME }, data });
}

function connectWindow(data: Record<string, unknown>) {
  return (
    findFileMatchesForTransactionCallable as unknown as {
      run: (req: unknown) => Promise<{ matches: FileMatch[] }>;
    }
  ).run({ data, auth: { uid: ME, token: {} } });
}

function findReceipt(transactionId: string) {
  return (
    findReceiptForTransactionCallable as unknown as {
      run: (req: unknown) => Promise<FindReceiptResult>;
    }
  ).run({ data: { transactionId }, auth: { uid: ME, token: {} } });
}

async function seedFile(id: string, extra: Record<string, unknown> = {}) {
  await db.collection("files").doc(id).set({
    userId: ME,
    fileName: `${id}.pdf`,
    fileType: "application/pdf",
    extractionComplete: true,
    extractedAmount: 12345,
    extractedCurrency: "EUR",
    extractedDate: day(DAY),
    transactionIds: [],
    ...extra,
  });
}

async function seedTx(id: string, extra: Record<string, unknown> = {}) {
  await db.collection("transactions").doc(id).set({
    userId: ME,
    amount: -12345,
    currency: "EUR",
    date: day(DAY),
    name: "SEPA 4711",
    fileIds: [],
    ...extra,
  });
}

const connectionsOf = async (fileId: string) =>
  (await db.collection("fileConnections").where("fileId", "==", fileId).get()).docs.map((d) => d.data());

beforeEach(async () => {
  await __resetFirestoreShim();
  await seedTx("t");
});

describe("the connect dialog opened from a File", () => {
  it("never shows a pair the Transaction rejected, unless searched for, then marked", async () => {
    await seedFile("f");
    await seedTx("t", { rejectedFileIds: ["f"] });
    expect((await dialog({ fileId: "f" })).matches).toEqual([]);
    const searched = await dialog({ fileId: "f", searchQuery: "SEPA" });
    expect(searched.matches).toEqual([expect.objectContaining({ transactionId: "t", hidden: "rejected" })]);
  });

  it("holds an over-quota Transaction back", async () => {
    await seedFile("f");
    await seedTx("t", { quotaExceeded: true });
    expect((await dialog({ fileId: "f" })).matches).toEqual([]);
  });

  it("offers nothing for a deleted File", async () => {
    await seedFile("f", { deletedAt: day(DAY) });
    expect(await dialog({ fileId: "f" })).toMatchObject({ matches: [], ineligible: "deleted" });
  });

  it("scores a File that is not stored yet with its tip and hint", async () => {
    // 120,25 printed plus a 3,20 tip is what the card was charged.
    const info = {
      extractedAmount: 12025,
      extractedTipAmount: 320,
      extractedCurrency: "EUR",
      extractedDate: `${DAY}T00:00:00.000Z`,
      precisionSearchHint: { transactionId: "t" },
    };
    const [top] = (await dialog({ fileInfo: info })).matches;
    expect(top.transactionId).toBe("t");
    expect(top.matchSources).toEqual(expect.arrayContaining(["amount_exact", "precision_hint"]));
  });
});

describe("the connect window opened from a Transaction", () => {
  it("offers an undated File only for the most recent Transactions, as the trigger does", async () => {
    await seedFile("f-undated", { extractedDate: null });
    await seedTx("t", { date: day("2020-01-01") });
    for (let i = 0; i < UNDATED_RECENT_TRANSACTIONS; i++) {
      await seedTx(`t-new-${i}`, { amount: -100 - i });
    }
    expect((await connectWindow({ transactionId: "t" })).matches).toEqual([]);
  });

  it("never offers a File addressed to someone else, so find-receipt cannot connect it", async () => {
    await seedFile("f-foreign", { foreignRecipient: true });
    expect((await connectWindow({ transactionId: "t" })).matches).toEqual([]);
    expect((await findReceipt("t")).status).not.toBe("connected");
    expect(await connectionsOf("f-foreign")).toEqual([]);
  });
});

describe("Partner matching", () => {
  beforeEach(async () => {
    await db.collection("partners").doc("p").set({ userId: ME, name: "Acme GmbH" });
  });

  it("does not connect at the old 85 on weak evidence", async () => {
    // A 123,45 USD invoice against a 123,45 EUR charge. The old formula read
    // that as an exact amount (40), plus the same day (25), the same Partner
    // (20) and a PDF (5): 90, auto-connected. The matcher judges the amount
    // across currencies and leaves it a suggestion.
    await seedTx("t", { partnerId: "p" });
    await seedFile("f", { partnerId: "p", extractedCurrency: "USD" });

    const result = await matchFilesForPartnerInternal(ME, "p", ["t"]);

    expect(result.autoMatched).toBe(0);
    expect(await connectionsOf("f")).toEqual([]);
  });

  it("connects what the upload trigger would", async () => {
    await seedTx("t", { partnerId: "p" });
    await seedFile("f", { partnerId: "p" });

    const result = await matchFilesForPartnerInternal(ME, "p", ["t"]);

    expect(result.autoMatched).toBe(1);
    expect(await connectionsOf("f")).toEqual([
      expect.objectContaining({ transactionId: "t", connectionType: "auto_matched" }),
    ]);
  });

  it("does not score a Partner's File outside the date window", async () => {
    // The old sweep had no window for the Partner's own Files: an exact
    // amount three months off still scored 65, a suggestion.
    await seedTx("t", { partnerId: "p", date: day("2026-06-10") });
    await seedFile("f", { partnerId: "p" });

    const result = await matchFilesForPartnerInternal(ME, "p", ["t"]);

    expect(result).toMatchObject({ autoMatched: 0, suggested: 0 });
  });
});

describe("the agent's Partner batch pool", () => {
  const pool = (fileIds: string[]) =>
    (
      findPartnerBatchTransactionsCallable as unknown as {
        run: (req: unknown) => Promise<{ transactions: Array<{ transactionId: string; confidence: number | null }> }>;
      }
    ).run({ data: { partnerId: "p", fileIds }, auth: { uid: ME, token: {} } });

  beforeEach(async () => {
    await db.collection("partners").doc("p").set({ userId: ME, name: "Acme GmbH" });
  });

  it("is the matcher's window, not its own 45 days, and keeps out a rejected pair", async () => {
    await seedFile("f", { partnerId: "p" });
    await seedTx("t", { partnerId: "p" });
    // 40 days off: inside the old 45-day pool, outside the window.
    await seedTx("t-40", { partnerId: "p", date: day("2026-04-19") });
    await seedTx("t-rejected", { partnerId: "p", rejectedFileIds: ["f"] });
    await seedTx("t-other-partner", { partnerId: "p-other" });

    const { transactions } = await pool(["f"]);

    expect(transactions.map((t) => t.transactionId)).toEqual(["t"]);
    expect(transactions[0].confidence).toBeGreaterThanOrEqual(85);
  });

  it("includes what a batch File is already on, so the worker can rebalance it", async () => {
    await seedFile("f", { partnerId: "p", transactionIds: ["t-old"] });
    await seedTx("t-old", { partnerId: "p", date: day("2025-01-01"), fileIds: ["f"] });

    const { transactions } = await pool(["f"]);

    expect(transactions).toContainEqual({ transactionId: "t-old", confidence: null });
  });
});

describe("re-scoring a connection", () => {
  it("judges a foreign-currency pair at the ECB rate (#555)", async () => {
    // USD sat at parity in 2022, 13% off the static anchor.
    await storeEcbDays(db, [{ date: "2022-09-02", rates: { USD: 1.0 } }]);
    await db.collection("partners").doc("p").set({ userId: ME, name: "Figma Inc" });
    await seedTx("t-ecb", { partnerId: "p", amount: -2390, date: day("2022-09-02"), name: "FIGMA" });
    await seedFile("f-ecb", {
      extractedAmount: 2400,
      extractedCurrency: "USD",
      extractedDate: day("2022-09-01"),
      transactionIds: ["t-ecb"],
    });
    await db.collection("fileConnections").doc("c-ecb").set({
      userId: ME,
      fileId: "f-ecb",
      transactionId: "t-ecb",
      matchConfidence: 0,
    });

    await rescoreConnections(db, ME, "p", [await db.collection("transactions").doc("t-ecb").get()]);

    const record = (await db.collection("fileConnections").doc("c-ecb").get()).data()!;
    // 23.90 / 24.00 is 0.4% off the published rate: the tight band, not 20.
    expect(record.scoreBreakdown.amount).toBe(30);
  });
});
