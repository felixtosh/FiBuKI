/**
 * #667: two same-amount charges tied at the auto-connect threshold connect
 * neither. When two or more uncovered Transactions of the same amount, in the
 * same currency, would be auto-connected to one File, none is: they stay
 * suggestions, each with a refusal naming the tie. Held at the matcher's
 * selection first, then through every surface that auto-connects a File.
 *
 * The real-score fixture is the review's case on PR #662, moved to a 30-day
 * month: an invoice dated 01.04 with a net-30 Due Date, paid by card on 01.04,
 * the same amount charged again on 01.05. The 30-day match window keeps the
 * 01.04 charge out of a 01.03 File's reach on main (#614 widens it), so the
 * April/May pair is the shape that is reachable today. With a Partner match
 * both charges reach the threshold.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import {
  selectAutoConnects,
  storedSuggestionsOf,
  transactionsForFile,
  type Match,
  type MatcherFile,
  type TransactionsForFileResult,
} from "../matching/matcher";
import { SCORING_CONFIG } from "../matching/transactionScoring";
import { refreshTransactionMatchesCallable } from "../matching/refreshTransactionMatchesCallable";
import { matchFilesForPartnerInternal } from "../matching/matchFilesForPartner";
import { findReceiptForTransactionCallable } from "../workflows/findReceiptForTransactionCallable";
import type { FindReceiptResult } from "../workflows/findReceiptForTransaction";

const db = getFirestore();
const ME = "tie-me";
const THRESHOLD = SCORING_CONFIG.AUTO_MATCH_THRESHOLD;

const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));

async function seedInvoice(id: string, extra: Record<string, unknown> = {}) {
  await db.collection("files").doc(id).set({
    userId: ME,
    fileName: `${id}.pdf`,
    fileType: "application/pdf",
    extractionComplete: true,
    extractedAmount: 4990,
    extractedCurrency: "EUR",
    extractedDate: day("2026-04-01"),
    extractedDueDate: day("2026-05-01"),
    partnerId: "p",
    transactionIds: [],
    ...extra,
  });
}

async function seedCharge(id: string, date: string, extra: Record<string, unknown> = {}) {
  await db.collection("transactions").doc(id).set({
    userId: ME,
    sourceId: "src-1",
    amount: -4990,
    currency: "EUR",
    date: day(date),
    name: "ACME SAAS",
    partnerId: "p",
    fileIds: [],
    ...extra,
  });
}

/** The review's case: this month's charge and next month's, same amount. */
async function seedTie() {
  await seedInvoice("f");
  await seedCharge("t-apr", "2026-04-01");
  await seedCharge("t-may", "2026-05-01");
}

async function file(id: string): Promise<MatcherFile> {
  return { id, data: (await db.collection("files").doc(id).get()).data()! };
}

const connectionsOf = async (fileId: string) =>
  (await db.collection("fileConnections").where("fileId", "==", fileId).get()).docs.map((d) => d.data());

/** A Match at a chosen Confidence, for the cases a real score cannot pin to the point. */
function match(transactionId: string, confidence: number, amount = -4990, currency = "EUR"): Match {
  return {
    transactionId,
    fileId: "f",
    confidence,
    matchSources: ["amount_exact"],
    breakdown: { amount: 40, date: 25, partner: 0, iban: 0, reference: 0, hint: 0, hardFacts: 0 },
    preview: { date: day("2026-04-01"), amount, currency, name: "ACME SAAS", partner: null },
  } as unknown as Match;
}

function resultOf(matches: Match[], documentedAmounts = new Map<string, number>()): TransactionsForFileResult {
  return {
    ineligible: null,
    matches,
    totalCandidates: matches.length,
    windowSize: matches.length,
    connectedFiles: new Map(),
    documentedAmounts,
  };
}

const picked = (picks: Array<{ match: Match }>) => picks.map((p) => p.match.transactionId).sort();

beforeEach(async () => {
  await __resetFirestoreShim();
  await db.collection("partners").doc("p").set({ userId: ME, name: "Acme SaaS GmbH" });
});

describe("the matcher's auto-connect selection (#667)", () => {
  it("connects neither of two same-amount charges at the threshold, and keeps both as suggestions", async () => {
    await seedTie();
    const f = await file("f");
    const result = await transactionsForFile(db, ME, f);
    const scored = Object.fromEntries(result.matches.map((m) => [m.transactionId, m.confidence]));
    expect(scored["t-apr"]).toBeGreaterThanOrEqual(THRESHOLD);
    expect(scored["t-may"]).toBeGreaterThanOrEqual(THRESHOLD);

    const { picks, refusals } = await selectAutoConnects(db, ME, f, result);

    expect(picks).toEqual([]);
    expect(refusals.map((r) => r.transactionId).sort()).toEqual(["t-apr", "t-may"]);
    for (const r of refusals) expect(r.reason).toMatch(/tie/);
    expect(storedSuggestionsOf(result.matches).map((s) => s.transactionId).sort()).toEqual(["t-apr", "t-may"]);
  });

  it("connects the one at the threshold when the other same-amount charge is a point below it", async () => {
    await seedInvoice("f");
    const { picks, refusals } = await selectAutoConnects(
      db,
      ME,
      await file("f"),
      resultOf([match("t-85", THRESHOLD), match("t-84", THRESHOLD - 1)])
    );
    expect(picked(picks)).toEqual(["t-85"]);
    expect(refusals).toEqual([]);
  });

  it("connects both of two different amounts at the threshold, as before", async () => {
    await seedInvoice("f");
    const { picks } = await selectAutoConnects(
      db,
      ME,
      await file("f"),
      resultOf([match("t-a", THRESHOLD), match("t-b", THRESHOLD, -5990)])
    );
    expect(picked(picks)).toEqual(["t-a", "t-b"]);
  });

  it("is no tie across currencies", async () => {
    await seedInvoice("f");
    const { picks } = await selectAutoConnects(
      db,
      ME,
      await file("f"),
      resultOf([match("t-eur", THRESHOLD), match("t-usd", THRESHOLD, -4990, "USD")])
    );
    expect(picked(picks)).toEqual(["t-eur", "t-usd"]);
  });

  it("does not count a Transaction its Files already cover towards a tie", async () => {
    await seedInvoice("f");
    const { picks, refusals } = await selectAutoConnects(
      db,
      ME,
      await file("f"),
      resultOf([match("t-open", THRESHOLD), match("t-covered", THRESHOLD)], new Map([["t-covered", 4990]]))
    );
    expect(picked(picks)).toEqual(["t-open"]);
    expect(refusals).toEqual([expect.objectContaining({ transactionId: "t-covered", reason: expect.stringMatching(/covered/) })]);
  });
});

describe("every surface that auto-connects a File applies the tie rule (#667)", () => {
  it("the upload trigger, run as refresh matches", async () => {
    await seedTie();
    await (
      refreshTransactionMatchesCallable as unknown as { run: (req: unknown) => Promise<unknown> }
    ).run({ data: { fileId: "f" }, auth: { uid: ME, token: {} } });

    expect(await connectionsOf("f")).toEqual([]);
    const stored = (await db.collection("files").doc("f").get()).data()!.transactionSuggestions as Array<{
      transactionId: string;
    }>;
    expect(stored.map((s) => s.transactionId).sort()).toEqual(["t-apr", "t-may"]);
  });

  it("Partner matching", async () => {
    await seedTie();
    const result = await matchFilesForPartnerInternal(ME, "p", ["t-apr", "t-may"]);
    expect(result.autoMatched).toBe(0);
    expect(await connectionsOf("f")).toEqual([]);
  });

  it("the find-receipt workflow, from either charge", async () => {
    await seedTie();
    for (const transactionId of ["t-apr", "t-may"]) {
      const result = await (
        findReceiptForTransactionCallable as unknown as { run: (req: unknown) => Promise<FindReceiptResult> }
      ).run({ data: { transactionId }, auth: { uid: ME, token: {} } });
      expect(result.status).not.toBe("connected");
    }
    expect(await connectionsOf("f")).toEqual([]);
  });

  it("Partner matching still connects a File whose one charge is alone at the threshold", async () => {
    await seedInvoice("f");
    await seedCharge("t-apr", "2026-04-01");
    const result = await matchFilesForPartnerInternal(ME, "p", ["t-apr"]);
    expect(result.autoMatched).toBe(1);
    expect(await connectionsOf("f")).toEqual([expect.objectContaining({ transactionId: "t-apr" })]);
  });
});
