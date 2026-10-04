/**
 * #308 / #327 / #613 — one File/Transaction pair, one score, from either end.
 *
 * Every surface reaches the matcher (`matching/matcher.ts`; the guard in
 * matching/__tests__/scoringInputs-guard.test.ts holds that), so parity is
 * held at the matcher: each fixture's pair must score identically
 *
 *   - for the File (`transactionsForFile`, what the trigger stores and the
 *     connect dialog opened from a File ranks),
 *   - for the Transaction (`filesForTransaction`, the connect window opened
 *     from a Transaction, find-receipt and the agent's local search),
 *   - by id (`scorePair`, the MCP tool and the agent's batch scorer),
 *
 * and the trigger must store that score.
 *
 * Each fixture exercises one input that a hand-built copy of the scoring
 * inputs has dropped before: the tip (#217), the Remainder (#239), the
 * bank-stated original amount (#112), the invoice number in the preserved raw
 * row (#137), the precision-search hint, the assigned Partner's aliases and
 * learned weights, the published ECB rate for an old foreign-currency pair
 * (#555), and an undated File.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";

import { runTransactionMatching } from "../matching/matchFileTransactions";
import { filesForTransaction, scorePair, transactionsForFile } from "../matching/matcher";
import { storeEcbDays } from "../fx/ecbRateStore";

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

const fileOf = async (id: string) => ({ id, data: (await db.collection("files").doc(id).get()).data()! });
const txOf = (id: string) => db.collection("transactions").doc(id).get();
const sorted = (sources: string[]) => [...sources].sort();

/** The pair's score for the File, for the Transaction, and by id. */
async function fromEachEnd(fileId: string, transactionId: string) {
  const forFile = (await transactionsForFile(db, USER, await fileOf(fileId))).matches.find(
    (m) => m.transactionId === transactionId
  );
  const forTx = (await filesForTransaction(db, USER, await txOf(transactionId))).matches.find(
    (m) => m.fileId === fileId
  );
  const byId = (await scorePair(db, USER, await fileOf(fileId), await txOf(transactionId))).match;
  return { forFile, forTx, byId };
}

beforeEach(async () => {
  await __resetFirestoreShim();
  __resetTriggerShim();
  await seed();
});

describe("a pair scores the same from either end, and the trigger stores that score", () => {
  for (const fixture of FIXTURES) {
    it(fixture.name, async () => {
      await runTransactionMatching(fixture.fileId, (await fileOf(fixture.fileId)).data);
      const suggestions = (await fileOf(fixture.fileId)).data.transactionSuggestions as Array<{
        transactionId: string;
        confidence: number;
        matchSources: string[];
      }>;
      // Not vacuous: the pair the fixture is about reached the UI.
      expect(suggestions.map((s) => s.transactionId)).toContain(fixture.transactionId);

      for (const suggestion of suggestions) {
        const { forFile, forTx, byId } = await fromEachEnd(fixture.fileId, suggestion.transactionId);
        expect(forFile, `for the File: ${suggestion.transactionId} missing`).toBeDefined();
        expect(forTx, `for the Transaction: ${fixture.fileId} missing`).toBeDefined();
        const shape = (m: { confidence: number; matchSources: string[]; breakdown: unknown }) => ({
          confidence: m.confidence,
          matchSources: sorted(m.matchSources),
          breakdown: m.breakdown,
        });
        expect(shape(forTx!)).toEqual(shape(forFile!));
        expect(shape(byId)).toEqual(shape(forFile!));
        expect({ confidence: suggestion.confidence, matchSources: sorted(suggestion.matchSources) }).toEqual({
          confidence: forFile!.confidence,
          matchSources: sorted(forFile!.matchSources),
        });
      }
    });
  }
});

describe("each input reaches the score", () => {
  const sourcesOf = async (fileId: string, transactionId: string) =>
    (await fromEachEnd(fileId, transactionId)).forTx!.matchSources;

  it("the invoice number found only in the preserved raw row (#137)", async () => {
    expect(await sourcesOf("f-rawrow", "t-rawrow")).toContain("reference");
  });

  it("the bank-stated original amount (#112)", async () => {
    // Without it the pair falls back to the FX-plausibility band: amount_close.
    expect(await sourcesOf("f-fx", "t-fx")).toContain("amount_exact");
  });

  it("the Remainder the connected invoice leaves open (#239)", async () => {
    const sources = await sourcesOf("f-remainder", "t-remainder");
    expect(sources).toContain("amount_remainder");
    expect(sources).toContain("amount_exact");
  });

  it("the precision-search hint", async () => {
    expect(await sourcesOf("f-partner", "t-partner")).toContain("precision_hint");
  });
});

describe("a foreign-currency pair is judged at the published rate (#555)", () => {
  const amountOf = async () => (await fromEachEnd("f-ecb", "t-ecb")).forTx!.breakdown.amount;

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
