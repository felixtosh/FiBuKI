/**
 * #308 / #327 — one File/Transaction pair, one score, whichever surface asks.
 *
 * CLAUDE.md requires the agent's scorer and the UI's to agree. Four surfaces
 * score a pair:
 *
 *   - the matching trigger (`runTransactionMatching`), whose output the UI
 *     shows as the File's stored suggestions,
 *   - the connect dialog opened from a File (`findTransactionMatchesForFile`),
 *   - the connect window opened from a Transaction
 *     (`findFileMatchesForTransaction`, #555),
 *   - the agent's `score_file_transaction_match` (`scoreFileTransactionMatch`).
 *
 * Each fixture below exercises one input that a hand-built copy of the
 * scoring inputs has dropped before: the tip (#217), the Remainder (#239), the
 * bank-stated original amount (#112), the invoice number in the preserved raw
 * row (#137), the precision-search hint, and the assigned Partner's aliases
 * and learned weights, the published ECB rate for an old foreign-currency
 * pair (#555), and an undated File. All four surfaces run for real on the
 * self-host shim, and every pair the trigger suggests must score identically
 * on the other three.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";

import { runTransactionMatching } from "../matching/matchFileTransactions";
import { findTransactionMatchesForFile } from "../matching/findTransactionMatches";
import { findFileMatchesForTransactionCallable } from "../matching/findFileMatches";
import { storeEcbDays } from "../fx/ecbRateStore";
import { scoreFileTransactionMatch } from "../tools/handlers";
import { formatScoreBreakdown, type ScoreBreakdown } from "../matching/transactionScoring";

const db = getFirestore();
const USER = "parity-user";

const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));

interface Fixture {
  name: string;
  fileId: string;
  file: Record<string, unknown>;
  /** The Transaction this File belongs on — must reach the stored suggestions. */
  transactionId: string;
  transaction: Record<string, unknown>;
}

const FIXTURES: Fixture[] = [
  {
    name: "restaurant Beleg with a hand-set tip (#217)",
    fileId: "f-tip",
    file: {
      extractedAmount: 5080,
      extractedTipAmount: 320,
      extractedCurrency: "EUR",
      extractedDate: day("2026-02-20"),
      extractedPartner: "Gasthaus Zur Post",
    },
    transactionId: "t-tip",
    transaction: {
      amount: -5400,
      currency: "EUR",
      date: day("2026-02-20"),
      name: "GASTHAUS ZUR POST WIEN",
    },
  },
  {
    name: "USD invoice settled in EUR, bank states the original (#112)",
    fileId: "f-fx",
    file: {
      extractedAmount: 2400,
      extractedCurrency: "USD",
      extractedDate: day("2026-03-10"),
      extractedPartner: "Notion Labs Inc",
    },
    transactionId: "t-fx",
    transaction: {
      amount: -2077,
      currency: "EUR",
      date: day("2026-03-11"),
      name: "NOTION LABS",
      _original: {
        rawRow: {
          "Original Amount": "24.00",
          "Original Currency": "USD",
          "Exchange Rate": "0.8654166667",
        },
      },
    },
  },
  {
    name: "invoice number only in an unmapped CSV column (#137)",
    fileId: "f-rawrow",
    file: {
      extractedAmount: 9900,
      extractedCurrency: "EUR",
      extractedDate: day("2026-04-15"),
      extractedInvoiceNumber: "RE-2026-0042",
    },
    transactionId: "t-rawrow",
    transaction: {
      amount: -9900,
      currency: "EUR",
      date: day("2026-04-18"),
      name: "SEPA LASTSCHRIFT",
      _original: { rawRow: { Zahlungsreferenz: "Rechnung RE-2026-0042" } },
    },
  },
  {
    name: "second invoice onto a half-documented line (#239)",
    fileId: "f-remainder",
    file: {
      extractedAmount: 21420,
      extractedCurrency: "EUR",
      extractedDate: day("2026-05-05"),
    },
    transactionId: "t-remainder",
    transaction: {
      amount: -50000,
      currency: "EUR",
      date: day("2026-05-06"),
      name: "SAMMELUEBERWEISUNG",
    },
  },
  {
    name: "precision-search hint on a Partner with aliases and learned weights",
    fileId: "f-partner",
    file: {
      extractedAmount: 1500,
      extractedCurrency: "EUR",
      extractedDate: day("2026-06-01"),
      extractedPartner: "Acme GmbH",
      partnerId: "p-acme",
      precisionSearchHint: { transactionId: "t-partner", matchConfidence: 80 },
    },
    transactionId: "t-partner",
    transaction: {
      amount: -1450,
      currency: "EUR",
      date: day("2026-06-04"),
      name: "ACME BRAND STORE",
    },
  },
  {
    // USD sat at parity in 2022, 13% off the static anchor (#555).
    name: "2022 USD invoice, no bank-stated original, judged at that day's ECB rate",
    fileId: "f-ecb",
    file: {
      extractedAmount: 2400,
      extractedCurrency: "USD",
      extractedDate: day("2022-09-01"),
      extractedPartner: "Figma Inc",
    },
    transactionId: "t-ecb",
    transaction: {
      amount: -2390,
      currency: "EUR",
      date: day("2022-09-02"),
      name: "FIGMA",
    },
  },
  {
    name: "File with no extracted date",
    fileId: "f-undated",
    file: {
      extractedAmount: 4200,
      extractedCurrency: "EUR",
      extractedPartner: "Undated Supplier GmbH",
    },
    transactionId: "t-undated",
    transaction: {
      amount: -4200,
      currency: "EUR",
      date: day("2026-07-01"),
      name: "UNDATED SUPPLIER GMBH",
    },
  },
];

/** The ECB published 1 EUR = 1.0000 USD on the 2022 fixture's payment day. */
const ECB_DAY = { date: "2022-09-02", rates: { USD: 1.0 } };

async function seed() {
  await storeEcbDays(db, [ECB_DAY]);

  // Passive: the trigger stores suggestions and connects nothing, so every
  // fixture is still unconnected when the other two surfaces score it.
  await db.collection("subscriptions").doc(USER).set({
    userId: USER,
    automationMode: "passive",
    planId: "free",
  });

  await db.collection("partners").doc("p-acme").set({
    userId: USER,
    name: "Acme GmbH",
    aliases: ["ACME BRAND STORE"],
    scoringWeights: { amountWeight: 0.8, dateWeight: 1.2, partnerWeight: 1.5 },
    isActive: true,
  });

  for (const f of FIXTURES) {
    await db.collection("transactions").doc(f.transactionId).set({
      userId: USER,
      sourceId: "src-1",
      fileIds: [],
      ...f.transaction,
    });
    await db.collection("files").doc(f.fileId).set({
      userId: USER,
      fileName: `${f.fileId}.pdf`,
      extractionComplete: true,
      transactionIds: [],
      ...f.file,
    });
  }

  // The Remainder fixture's line already holds a 285,80 invoice.
  await db.collection("files").doc("f-remainder-first").set({
    userId: USER,
    fileName: "first-half.pdf",
    extractionComplete: true,
    extractedAmount: 28580,
    extractedCurrency: "EUR",
    extractedDate: day("2026-05-05"),
    transactionIds: ["t-remainder"],
  });
  await db.collection("fileConnections").doc("c-remainder-first").set({
    userId: USER,
    fileId: "f-remainder-first",
    transactionId: "t-remainder",
  });
  await db.collection("transactions").doc("t-remainder").update({
    fileIds: ["f-remainder-first"],
  });
}

type DialogMatch = {
  transactionId: string;
  confidence: number;
  matchSources: string[];
  breakdown: ScoreBreakdown;
};

const dialog = findTransactionMatchesForFile as unknown as (req: {
  auth: { uid: string };
  data: Record<string, unknown>;
}) => Promise<{ matches: DialogMatch[] }>;

type WindowMatch = DialogMatch & { fileId: string; scoredAgainstRemainder: boolean };

/** The Connect File window opened from a Transaction (#555). */
const connectWindow = (data: Record<string, unknown>) =>
  (
    findFileMatchesForTransactionCallable as unknown as {
      run: (req: unknown) => Promise<{ matches: WindowMatch[] }>;
    }
  ).run({ data, auth: { uid: USER, token: {} } });

const sorted = (sources: string[]) => [...sources].sort();

beforeEach(async () => {
  await __resetFirestoreShim();
  __resetTriggerShim();
  await seed();
});

describe("the trigger, both connect windows and the agent tool score a pair identically", () => {
  for (const fixture of FIXTURES) {
    it(fixture.name, async () => {
      const fileData = (await db.collection("files").doc(fixture.fileId).get()).data()!;
      await runTransactionMatching(fixture.fileId, fileData);

      const stored = (await db.collection("files").doc(fixture.fileId).get()).data()!;
      const suggestions = stored.transactionSuggestions as Array<{
        transactionId: string;
        confidence: number;
        matchSources: string[];
      }>;
      // Not vacuous: the pair the fixture is about reached the UI.
      expect(suggestions.map((s) => s.transactionId)).toContain(fixture.transactionId);

      const { matches } = await dialog({ auth: { uid: USER }, data: { fileId: fixture.fileId } });

      for (const suggestion of suggestions) {
        const inDialog = matches.find((m) => m.transactionId === suggestion.transactionId);
        const fromAgent = await scoreFileTransactionMatch(USER, {
          fileId: fixture.fileId,
          transactionId: suggestion.transactionId,
        });

        // No search term: the window ranks before anything is typed.
        const { matches: fromTransaction } = await connectWindow({
          transactionId: suggestion.transactionId,
          limit: 100,
        });
        const inWindow = fromTransaction.find((m) => m.fileId === fixture.fileId);

        expect(inDialog, `dialog is missing ${suggestion.transactionId}`).toBeDefined();
        expect(inWindow, `window is missing ${fixture.fileId}`).toBeDefined();
        expect({
          confidence: inWindow!.confidence,
          matchSources: sorted(inWindow!.matchSources),
          breakdown: inWindow!.breakdown,
        }).toEqual({
          confidence: suggestion.confidence,
          matchSources: sorted(suggestion.matchSources),
          breakdown: inDialog!.breakdown,
        });
        expect({
          confidence: inDialog!.confidence,
          matchSources: sorted(inDialog!.matchSources),
        }).toEqual({
          confidence: suggestion.confidence,
          matchSources: sorted(suggestion.matchSources),
        });
        expect({
          confidence: fromAgent.confidence,
          matchSources: sorted(fromAgent.matchSources),
          breakdown: fromAgent.breakdown,
        }).toEqual({
          confidence: suggestion.confidence,
          matchSources: sorted(suggestion.matchSources),
          breakdown: formatScoreBreakdown(inDialog!.breakdown),
        });
      }
    });
  }
});

describe("score_file_transaction_match sees what the trigger sees (#327)", () => {
  it("scores the invoice number found only in the preserved raw row", async () => {
    const result = await scoreFileTransactionMatch(USER, {
      fileId: "f-rawrow",
      transactionId: "t-rawrow",
    });
    expect(result.matchSources).toContain("reference");
  });

  it("scores a foreign-currency pair off the bank-stated original amount", async () => {
    const result = await scoreFileTransactionMatch(USER, {
      fileId: "f-fx",
      transactionId: "t-fx",
    });
    // Before #327 the tool fell back to the FX-plausibility band: amount_close.
    expect(result.matchSources).toContain("amount_exact");
  });

  it("scores against the Remainder the connected invoice leaves open", async () => {
    const result = await scoreFileTransactionMatch(USER, {
      fileId: "f-remainder",
      transactionId: "t-remainder",
    });
    expect(result.matchSources).toContain("amount_remainder");
    expect(result.matchSources).toContain("amount_exact");
  });

  it("scores the precision-search hint", async () => {
    const result = await scoreFileTransactionMatch(USER, {
      fileId: "f-partner",
      transactionId: "t-partner",
    });
    expect(result.matchSources).toContain("precision_hint");
  });
});

describe("the Connect File window opened from a Transaction (#555)", () => {
  it("ranks a File no typed text would have found", async () => {
    // The old window searched for the Transaction's name first, and nothing
    // on this File says SAMMELUEBERWEISUNG.
    const { matches } = await connectWindow({ transactionId: "t-remainder" });
    const hit = matches.find((m) => m.fileId === "f-remainder");
    expect(hit?.matchSources).toContain("amount_remainder");
    expect(hit?.scoredAgainstRemainder).toBe(true);
  });

  it("keeps a rejected pair out of the ranked list and lets a search reach it", async () => {
    await db.collection("files").doc("f-tip").update({
      dismissedTransactionIds: ["t-tip"],
    });
    const ranked = await connectWindow({ transactionId: "t-tip" });
    expect(ranked.matches.map((m) => m.fileId)).not.toContain("f-tip");

    const searched = await connectWindow({ transactionId: "t-tip", searchQuery: "gasthaus" });
    expect(searched.matches.map((m) => m.fileId)).toContain("f-tip");
  });

  it("honours a Rejection written on the Transaction's side too", async () => {
    await db.collection("transactions").doc("t-tip").update({ rejectedFileIds: ["f-tip"] });
    const ranked = await connectWindow({ transactionId: "t-tip" });
    expect(ranked.matches.map((m) => m.fileId)).not.toContain("f-tip");
  });
});

describe("a foreign-currency pair is judged at the published rate (#555)", () => {
  const amountOf = async () => {
    const { matches } = await connectWindow({ transactionId: "t-ecb" });
    return matches.find((m) => m.fileId === "f-ecb")!.breakdown.amount;
  };

  it("anchors on the ECB rate for the Transaction's date", async () => {
    // 23.90 / 24.00 is 0.4% off the published 1.0000: the tight band.
    expect(await amountOf()).toBe(30);
  });

  it("falls back to the static anchor where the store does not reach", async () => {
    await db.collection("fxReferenceRates").doc("2022-09").delete();
    // 13% off the static USD anchor: the loose band.
    expect(await amountOf()).toBe(20);
  });
});
