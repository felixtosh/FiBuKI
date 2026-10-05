/**
 * #615, ADR-0013: one File paid by several Transactions is scored against
 * what is Outstanding, and an instalment connects itself only on printed
 * evidence.
 *
 * Driven through the matcher's own run, the one the upload trigger and
 * "Refresh matches" share (`runTransactionMatching`), on the self-host data
 * layer. Each case reads what was stored: the File Connections, their reason
 * and score breakdown, and the suggestions. Where a pair stays a suggestion,
 * its breakdown is read from the matcher's answer for the File.
 *
 *   npx vitest run --config vitest.selfhost.config.ts src/selfhost/outstanding-matching.test.ts --pool=forks --maxWorkers=1
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { connectFile } from "../fileConnections/writer";
import { instalmentWindowsOf, scorePair, selectAutoConnects, transactionsForFile } from "../matching/matcher";
import { connectFileToTransactionCallable } from "../files/connectFileToTransaction";
import { SCORING_CONFIG } from "../matching/transactionScoring";
import { refreshTransactionMatchesCallable } from "../matching/refreshTransactionMatchesCallable";
import { matchFilesForPartnerInternal } from "../matching/matchFilesForPartner";
import { findReceiptForTransactionCallable } from "../workflows/findReceiptForTransactionCallable";
import type { FindReceiptResult } from "../workflows/findReceiptForTransaction";

const db = getFirestore();
const ME = "outstanding-me";
const THRESHOLD = SCORING_CONFIG.AUTO_MATCH_THRESHOLD;
const INVOICE_NUMBER = "RE-2026-0042";

const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));

async function seedInvoice(id: string, extra: Record<string, unknown> = {}) {
  await db.collection("files").doc(id).set({
    userId: ME,
    fileName: `${id}.pdf`,
    fileType: "application/pdf",
    extractionComplete: true,
    extractedAmount: 120000,
    extractedCurrency: "EUR",
    extractedDate: day("2026-03-01"),
    extractedInvoiceNumber: INVOICE_NUMBER,
    documentType: "invoice",
    partnerId: "p",
    transactionIds: [],
    ...extra,
  });
}

async function seedPayment(id: string, amount: number, date: string, extra: Record<string, unknown> = {}) {
  await db.collection("transactions").doc(id).set({
    userId: ME,
    sourceId: "src-1",
    amount: -amount,
    currency: "EUR",
    date: day(date),
    name: "BAU GMBH",
    partnerId: "p",
    fileIds: [],
    ...extra,
  });
}

const connectByHand = (fileId: string, transactionId: string) =>
  connectFile(db as never, ME, { fileId, transactionId }, { origin: "manual" });

const refresh = (fileId: string) =>
  (refreshTransactionMatchesCallable as unknown as { run: (req: unknown) => Promise<unknown> }).run({
    data: { fileId },
    auth: { uid: ME, token: {} },
  });

async function connectionTo(fileId: string, transactionId: string) {
  const snap = await db
    .collection("fileConnections")
    .where("fileId", "==", fileId)
    .where("transactionId", "==", transactionId)
    .get();
  return snap.docs[0]?.data() ?? null;
}

async function matchFor(fileId: string, transactionId: string) {
  const data = (await db.collection("files").doc(fileId).get()).data()!;
  const result = await transactionsForFile(db as never, ME, { id: fileId, data });
  return result.matches.find((m) => m.transactionId === transactionId);
}

/** Why the matcher's selection keeps this pair a suggestion, or undefined. */
async function refusalFor(fileId: string, transactionId: string) {
  const data = (await db.collection("files").doc(fileId).get()).data()!;
  const file = { id: fileId, data };
  const { refusals } = await selectAutoConnects(db as never, ME, file, await transactionsForFile(db as never, ME, file));
  return refusals.find((r) => r.transactionId === transactionId)?.reason;
}

async function suggestedIds(fileId: string): Promise<string[]> {
  const data = (await db.collection("files").doc(fileId).get()).data()!;
  return ((data.transactionSuggestions ?? []) as Array<{ transactionId: string }>).map((s) => s.transactionId).sort();
}

beforeEach(async () => {
  await __resetFirestoreShim();
  await db.collection("partners").doc("p").set({ userId: ME, name: "Bau GmbH" });
});

describe("a File with one payment connected", () => {
  it("scores a second Transaction against the Outstanding amount, and connects it as an instalment when it closes it", async () => {
    await seedInvoice("f");
    await seedPayment("t-1", 40000, "2026-03-01");
    await connectByHand("f", "t-1");
    await seedPayment("t-2", 80000, "2026-03-03");

    const before = await matchFor("f", "t-2");
    expect(before?.breakdown.scoredAgainstOutstanding).toBe(80000);
    expect(before?.breakdown.amount).toBe(40);
    expect(before!.confidence).toBeGreaterThanOrEqual(THRESHOLD);

    await refresh("f");
    const stored = await connectionTo("f", "t-2");
    expect(stored).toMatchObject({ autoConnectReason: "instalment", connectionType: expect.any(String) });
    expect(stored?.scoreBreakdown).toMatchObject({ scoredAgainstOutstanding: 80000 });
  });

  it("never judges a Transaction the File is already on as a further payment", async () => {
    await seedInvoice("f");
    await seedPayment("t-1", 40000, "2026-03-01");
    await connectByHand("f", "t-1");
    const data = (await db.collection("files").doc("f").get()).data()!;
    const { match } = await scorePair(db as never, ME, { id: "f", data }, await db.collection("transactions").doc("t-1").get());
    expect(match.breakdown.scoredAgainstOutstanding).toBeUndefined();
    expect(match.breakdown.instalmentCandidate).toBeUndefined();
  });

  it("leaves it a suggestion when the Partner does not agree", async () => {
    await seedInvoice("f");
    await seedPayment("t-1", 40000, "2026-03-01");
    await connectByHand("f", "t-1");
    // Same day and cent-exact: at the threshold on the hard facts alone.
    await seedPayment("t-2", 80000, "2026-03-01", { partnerId: null, name: "SEPA GUTSCHRIFT" });

    const match = await matchFor("f", "t-2");
    expect(match?.breakdown.scoredAgainstOutstanding).toBe(80000);
    expect(match?.matchSources).not.toContain("partner");
    expect(match!.confidence).toBeGreaterThanOrEqual(THRESHOLD);
    expect(await refusalFor("f", "t-2")).toMatch(/Partner does not agree/);

    await refresh("f");
    expect(await connectionTo("f", "t-2")).toBeNull();
    expect(await suggestedIds("f")).toEqual(["t-2"]);
  });
});

describe("a File printing three instalments, nothing paid", () => {
  const schedule = [
    { amount: 40000, dueDate: day("2026-03-01"), label: "Rate 1/3" },
    { amount: 40000, dueDate: day("2026-04-01"), label: "Rate 2/3" },
    { amount: 40000, dueDate: day("2026-05-01"), label: "Rate 3/3" },
  ];

  it("connects a payment equal to instalment 1, and not a payment of another amount", async () => {
    await seedInvoice("f", { extractedInstalments: schedule });
    await seedPayment("t-rate", 40000, "2026-03-01");
    await seedPayment("t-other", 55000, "2026-03-02");

    expect((await matchFor("f", "t-rate"))?.breakdown.scoredAgainstInstalment).toBe(40000);

    await refresh("f");
    expect(await connectionTo("f", "t-rate")).toMatchObject({
      autoConnectReason: "instalment",
      scoreBreakdown: expect.objectContaining({ scoredAgainstInstalment: 40000 }),
    });
    expect(await connectionTo("f", "t-other")).toBeNull();
  });

  it("takes no further instalment once the File is paid in full", async () => {
    await seedInvoice("f", { extractedInstalments: schedule });
    await seedPayment("t-all", 120000, "2026-02-27");
    await connectByHand("f", "t-all");
    await seedPayment("t-next", 40000, "2026-03-01");

    const match = await matchFor("f", "t-next");
    expect(match?.breakdown.scoredAgainstInstalment).toBeUndefined();
    expect(match?.breakdown.scoredAgainstOutstanding).toBeUndefined();
    expect(match?.breakdown.amount).toBe(0);
    await refresh("f");
    expect(await connectionTo("f", "t-next")).toBeNull();
  });

  it("keeps the full-total Match for a File paid in one go", async () => {
    await seedInvoice("f", { extractedInstalments: schedule });
    await seedPayment("t-full", 120000, "2026-03-01");

    const match = await matchFor("f", "t-full");
    expect(match?.breakdown.scoredAgainstInstalment).toBeUndefined();
    await refresh("f");
    const stored = await connectionTo("f", "t-full");
    expect(stored).not.toBeNull();
    expect(stored?.autoConnectReason).toBeUndefined();
  });
});

describe("a part payment the bank reference names", () => {
  it("is a suggestion with no amount mismatch, never an auto-connect", async () => {
    await seedInvoice("f");
    await seedPayment("t-part", 30000, "2026-03-01", { reference: `${INVOICE_NUMBER} Teilzahlung` });

    const match = await matchFor("f", "t-part");
    expect(match?.breakdown.instalmentCandidate).toBe(true);
    expect(match?.breakdown.amount).toBeGreaterThan(0);
    expect(match!.confidence).toBe(THRESHOLD - 1);

    await refresh("f");
    expect(await connectionTo("f", "t-part")).toBeNull();
    expect(await suggestedIds("f")).toEqual(["t-part"]);
  });
});

describe("a part payment nothing prints or cites", () => {
  it("is scored against the full total, as before", async () => {
    await seedInvoice("f");
    await seedPayment("t-part", 30000, "2026-03-01");

    const match = await matchFor("f", "t-part");
    expect(match?.breakdown.amount).toBe(0);
    expect(match?.breakdown.scoredAgainstOutstanding).toBeUndefined();
    expect(match?.breakdown.scoredAgainstInstalment).toBeUndefined();
    expect(match?.breakdown.instalmentCandidate).toBeUndefined();

    await refresh("f");
    expect(await connectionTo("f", "t-part")).toBeNull();
  });
});

describe("two equal instalments in one window", () => {
  // Rate 1 due on the invoice day, Rate 2 a fortnight later: both charges sit
  // inside the payment window and reach the threshold.
  const schedule = [
    { amount: 40000, dueDate: day("2026-03-01"), label: "Rate 1/3" },
    { amount: 40000, dueDate: day("2026-03-15"), label: "Rate 2/3" },
    { amount: 40000, dueDate: day("2026-04-01"), label: "Rate 3/3" },
  ];
  const seed = () => seedInvoice("f", { extractedInstalments: schedule, extractedDueDate: day("2026-03-15") });

  it("connects the one booked nearest its printed due date", async () => {
    await seed();
    await seedPayment("t-near", 40000, "2026-03-01");
    await seedPayment("t-far", 40000, "2026-03-13");
    const near = await matchFor("f", "t-near");
    const far = await matchFor("f", "t-far");
    expect(near!.confidence).toBeGreaterThanOrEqual(THRESHOLD);
    expect(far!.confidence).toBeGreaterThanOrEqual(THRESHOLD);
    expect(await refusalFor("f", "t-far")).toMatch(/tie/);
    expect(await refusalFor("f", "t-near")).toBeUndefined();

    await refresh("f");
    expect(await connectionTo("f", "t-near")).toMatchObject({ autoConnectReason: "instalment" });
    expect(await connectionTo("f", "t-far")).toBeNull();
  });

  it("connects neither when both are as near to a printed due date", async () => {
    await seed();
    await seedPayment("t-a", 40000, "2026-03-02");
    await seedPayment("t-b", 40000, "2026-03-14");
    expect((await matchFor("f", "t-a"))!.confidence).toBeGreaterThanOrEqual(THRESHOLD);
    expect((await matchFor("f", "t-b"))!.confidence).toBeGreaterThanOrEqual(THRESHOLD);
    expect(await refusalFor("f", "t-a")).toMatch(/tie/);
    expect(await refusalFor("f", "t-b")).toMatch(/tie/);

    await refresh("f");
    expect(await connectionTo("f", "t-a")).toBeNull();
    expect(await connectionTo("f", "t-b")).toBeNull();
    expect(await suggestedIds("f")).toEqual(["t-a", "t-b"]);
  });
});

describe("an undocumented Transaction that wants the File as much (ADR-0008's guard)", () => {
  it("keeps the instalment a suggestion", async () => {
    await seedInvoice("f");
    await seedPayment("t-1", 40000, "2026-03-01");
    await connectByHand("f", "t-1");
    await seedPayment("t-close", 80000, "2026-03-01");
    // Fifty cents off the Outstanding amount, but naming the invoice: it
    // scores as high as the exact close.
    await seedPayment("t-rival", 79950, "2026-03-01", { reference: INVOICE_NUMBER });
    const close = await matchFor("f", "t-close");
    const rival = await matchFor("f", "t-rival");
    expect(rival!.confidence).toBeGreaterThanOrEqual(close!.confidence);
    expect(await refusalFor("f", "t-close")).toMatch(/undocumented Transaction/);

    await refresh("f");
    expect(await connectionTo("f", "t-close")).toBeNull();
    expect(await connectionTo("f", "t-rival")).toBeNull();
  });
});

describe("a Receipt Link pair on the first payment", () => {
  it("counts once toward the Outstanding amount", async () => {
    await seedInvoice("f");
    await seedInvoice("r", {
      extractedAmount: 40000,
      extractedInvoiceNumber: "Q-1",
      extractedPaidInvoiceNumber: INVOICE_NUMBER,
      documentType: "receipt",
      receiptLink: { fileId: "f", setBy: "user" },
    });
    await seedPayment("t-1", 40000, "2026-03-01");
    await connectByHand("f", "t-1");
    if (!(await connectionTo("r", "t-1"))) await connectByHand("r", "t-1");
    await seedPayment("t-2", 80000, "2026-03-03");

    // 400 of the pair's 1 200 is paid, not 400 of 1 600.
    expect((await matchFor("f", "t-2"))?.breakdown.scoredAgainstOutstanding).toBe(80000);
  });
});

describe("every surface that auto-connects keeps the rule", () => {
  const schedule = [
    { amount: 40000, dueDate: day("2026-03-01"), label: "Rate 1/3" },
    { amount: 80000, dueDate: day("2026-06-01"), label: "Rate 2/2" },
  ];

  it("Partner matching connects a printed instalment as an instalment", async () => {
    await seedInvoice("f", { extractedInstalments: schedule });
    await seedPayment("t-rate", 40000, "2026-03-01");
    const result = await matchFilesForPartnerInternal(ME, "p", ["t-rate"]);
    expect(result.autoMatched).toBe(1);
    expect(await connectionTo("f", "t-rate")).toMatchObject({ autoConnectReason: "instalment" });
  });

  it("Partner matching leaves an amount near a printed instalment a suggestion", async () => {
    await seedInvoice("f", { extractedInstalments: schedule });
    await seedPayment("t-near", 39900, "2026-03-01");
    const match = await matchFor("f", "t-near");
    expect(match?.breakdown.scoredAgainstInstalment).toBe(40000);
    expect(match!.confidence).toBeGreaterThanOrEqual(THRESHOLD);

    const result = await matchFilesForPartnerInternal(ME, "p", ["t-near"]);
    expect(result.autoMatched).toBe(0);
    expect(await connectionTo("f", "t-near")).toBeNull();
  });

  it("find-receipt leaves a close of the Outstanding amount the Partner does not agree with unconnected", async () => {
    await seedInvoice("f");
    await seedPayment("t-1", 40000, "2026-03-01");
    await connectByHand("f", "t-1");
    await seedPayment("t-2", 80000, "2026-03-01", { partnerId: null, name: "SEPA GUTSCHRIFT" });
    expect((await matchFor("f", "t-2"))!.confidence).toBeGreaterThanOrEqual(THRESHOLD);

    const result = await (
      findReceiptForTransactionCallable as unknown as { run: (req: unknown) => Promise<FindReceiptResult> }
    ).run({ data: { transactionId: "t-2" }, auth: { uid: ME, token: {} } });
    expect(result.status).not.toBe("connected");
    expect(await connectionTo("f", "t-2")).toBeNull();
  });
});

describe("a payment in another currency than the File", () => {
  it("makes no Outstanding: a further Transaction is scored against the full total", async () => {
    await seedInvoice("f", { extractedCurrency: "USD" });
    await seedPayment("t-eur", 36000, "2026-03-01");
    await connectByHand("f", "t-eur");
    await seedPayment("t-usd", 80000, "2026-03-03", { currency: "USD" });

    const match = await matchFor("f", "t-usd");
    expect(match?.breakdown.scoredAgainstOutstanding).toBeUndefined();
    expect(match?.breakdown.amount).toBe(0);
  });
});

/**
 * #716: a later instalment's date is scored against its printed due date, and
 * the File's window reaches that date.
 */
const SIX_MONTH_PLAN = [
  { amount: 40000, dueDate: day("2026-03-01"), label: "Rate 1/3" },
  { amount: 40000, dueDate: day("2026-06-01"), label: "Rate 2/3" },
  { amount: 40000, dueDate: day("2026-09-01"), label: "Rate 3/3" },
];

/** The plan's File with its first two instalments paid. */
async function seedTwoPaid() {
  await seedInvoice("f", { extractedInstalments: SIX_MONTH_PLAN });
  await seedPayment("t-1", 40000, "2026-03-01");
  await connectByHand("f", "t-1");
  await seedPayment("t-2", 40000, "2026-06-01");
  await connectByHand("f", "t-2");
}

const findReceipt = (transactionId: string) =>
  (findReceiptForTransactionCallable as unknown as { run: (req: unknown) => Promise<FindReceiptResult> }).run({
    data: { transactionId },
    auth: { uid: ME, token: {} },
  });

describe("a later instalment of a six-month plan (#716)", () => {
  it("auto-connects the third payment, booked near its printed due date, as an instalment", async () => {
    await seedTwoPaid();
    // The Wednesday after a due date on a Tuesday: within the settlement lag.
    await seedPayment("t-3", 40000, "2026-09-02");

    const match = await matchFor("f", "t-3");
    expect(match?.breakdown).toMatchObject({ scoredAgainstOutstanding: 40000, scoredAgainstDueDate: "2026-09-01" });
    expect(match?.matchSources).toContain("date_exact");
    expect(match!.confidence).toBeGreaterThanOrEqual(THRESHOLD);

    await refresh("f");
    expect(await connectionTo("f", "t-3")).toMatchObject({
      autoConnectReason: "instalment",
      scoreBreakdown: expect.objectContaining({ scoredAgainstDueDate: "2026-09-01" }),
    });
  });

  it("scores the same payment lower when it is booked far from that due date, and does not connect it", async () => {
    await seedTwoPaid();
    await seedPayment("t-near", 40000, "2026-09-01");
    const near = await matchFor("f", "t-near");
    await db.collection("transactions").doc("t-near").delete();

    // Four weeks late: still around the due date, so still a candidate.
    await seedPayment("t-late", 40000, "2026-09-28");
    // Right after the invoice: before #716 its date rode the invoice date.
    await seedPayment("t-early", 40000, "2026-03-04");
    const late = await matchFor("f", "t-late");
    const early = await matchFor("f", "t-early");

    expect(late?.breakdown.scoredAgainstDueDate).toBe("2026-09-01");
    expect(late!.breakdown.date).toBeLessThan(near!.breakdown.date);
    expect(late!.confidence).toBeLessThan(THRESHOLD);
    expect(early?.breakdown.scoredAgainstDueDate).toBe("2026-09-01");
    expect(early!.breakdown.date).toBe(0);
    expect(early!.confidence).toBeLessThan(THRESHOLD);

    await refresh("f");
    expect(await connectionTo("f", "t-late")).toBeNull();
    expect(await connectionTo("f", "t-early")).toBeNull();
  });

  it("dates a first payment equal to a printed instalment against that instalment's due date", async () => {
    await seedInvoice("f", { extractedInstalments: SIX_MONTH_PLAN });
    await seedPayment("t-rate", 40000, "2026-06-02");

    const match = await matchFor("f", "t-rate");
    expect(match?.breakdown).toMatchObject({ scoredAgainstInstalment: 40000, scoredAgainstDueDate: "2026-06-01" });
    await refresh("f");
    expect(await connectionTo("f", "t-rate")).toMatchObject({ autoConnectReason: "instalment" });
  });

  it("keeps the File's own dates for a payment that does not close the Outstanding amount", async () => {
    await seedInvoice("f", { extractedInstalments: SIX_MONTH_PLAN });
    await seedPayment("t-1", 40000, "2026-03-01");
    await connectByHand("f", "t-1");
    // A second instalment against 800 Outstanding: no printed row is known to be it.
    await seedPayment("t-2", 40000, "2026-03-05");

    const match = await matchFor("f", "t-2");
    expect(match?.breakdown.scoredAgainstOutstanding).toBe(80000);
    expect(match?.breakdown.scoredAgainstDueDate).toBeUndefined();
  });
});

describe("a File printing no instalments (#716)", () => {
  it("keeps its window: a payment closing the Outstanding amount six months on is no candidate", async () => {
    await seedInvoice("f");
    await seedPayment("t-1", 40000, "2026-03-01");
    await connectByHand("f", "t-1");
    await seedPayment("t-near", 80000, "2026-03-03");
    await seedPayment("t-far", 80000, "2026-09-01");

    const near = await matchFor("f", "t-near");
    expect(near?.breakdown.scoredAgainstOutstanding).toBe(80000);
    expect(near?.breakdown.scoredAgainstDueDate).toBeUndefined();
    expect(await matchFor("f", "t-far")).toBeUndefined();
  });
});

describe("the windows a File's printed instalments add (#716)", () => {
  it("are each due date ± 30 days, none for a File printing none, and none for a misread year", () => {
    expect(instalmentWindowsOf({ extractedDate: day("2026-03-01") })).toEqual([]);
    const windows = instalmentWindowsOf({
      extractedDate: day("2026-03-01"),
      extractedInstalments: [
        { amount: 40000, dueDate: day("2026-06-01"), label: null },
        { amount: 40000, dueDate: null, label: null },
        // A wrong year either way is a misread.
        { amount: 40000, dueDate: day("2025-06-01"), label: null },
        { amount: 40000, dueDate: day("2027-06-01"), label: null },
      ],
    });
    expect(windows).toHaveLength(1);
    const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    expect(dayOf(windows[0].start + 12 * 3600 * 1000)).toBe("2026-05-02");
    expect(dayOf(windows[0].end)).toBe("2026-07-01");
  });
});

describe("find-receipt on a later instalment (#716)", () => {
  it("stamps the connection as an instalment", async () => {
    await seedTwoPaid();
    await seedPayment("t-3", 40000, "2026-09-01");

    expect(await findReceipt("t-3")).toMatchObject({ status: "connected", fileId: "f" });
    expect(await connectionTo("f", "t-3")).toMatchObject({ autoConnectReason: "instalment" });
  });

  it("stamps nothing on a full-amount connect", async () => {
    await seedInvoice("f");
    await seedPayment("t-full", 120000, "2026-03-01");
    expect((await findReceipt("t-full")).status).toBe("connected");
    const stored = await connectionTo("f", "t-full");
    expect(stored).not.toBeNull();
    expect(stored?.autoConnectReason).toBeUndefined();
  });

  it("takes no reason from a client of the connect callable", async () => {
    await seedInvoice("f");
    await seedPayment("t-1", 40000, "2026-03-01");
    await (connectFileToTransactionCallable as unknown as { run: (req: unknown) => Promise<unknown> }).run({
      data: { fileId: "f", transactionId: "t-1", connectionType: "auto_matched", autoConnectReason: "instalment" },
      auth: { uid: ME, token: {} },
    });
    const stored = await connectionTo("f", "t-1");
    expect(stored).not.toBeNull();
    expect(stored?.autoConnectReason).toBeUndefined();
  });
});
