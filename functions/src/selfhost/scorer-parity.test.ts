/**
 * #308 / #327 — one File/Transaction pair, one score, whichever surface asks.
 *
 * CLAUDE.md requires the agent's scorer and the UI's to agree. Three surfaces
 * score a pair:
 *
 *   - the matching trigger (`runTransactionMatching`), whose output the UI
 *     shows as the File's stored suggestions,
 *   - the connect dialog (`findTransactionMatchesForFile`),
 *   - the agent's `score_file_transaction_match` (`scoreFileTransactionMatch`).
 *
 * Each fixture below exercises one input that a hand-built copy of the
 * scoring inputs has dropped before: the tip (#217), the Remainder (#239), the
 * bank-stated original amount (#112), the invoice number in the preserved raw
 * row (#137), the precision-search hint, and the assigned Partner's aliases
 * and learned weights. All three surfaces run for real on the self-host shim,
 * and every pair the trigger suggests must score identically on the other two.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";

import { runTransactionMatching } from "../matching/matchFileTransactions";
import { findTransactionMatchesForFile } from "../matching/findTransactionMatches";
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
];

async function seed() {
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

const sorted = (sources: string[]) => [...sources].sort();

beforeEach(async () => {
  await __resetFirestoreShim();
  __resetTriggerShim();
  await seed();
});

describe("the trigger, the connect dialog and the agent tool score a pair identically", () => {
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

        expect(inDialog, `dialog is missing ${suggestion.transactionId}`).toBeDefined();
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
