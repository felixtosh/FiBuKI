/**
 * The one matcher (#613), at its interface: which pairs are possible, held
 * back or out of the date window, from both directions, with and without a
 * User's search. Every surface goes through these functions, so a rule held
 * here holds for all of them.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import {
  filesForTransaction,
  pairsAmong,
  scorePair,
  storedSuggestionsOf,
  transactionsForFile,
  transactionsForFiles,
  unsavedFileData,
  UNDATED_RECENT_TRANSACTIONS,
  type MatcherFile,
} from "../matching/matcher";

const db = getFirestore();
const ME = "matcher-me";

const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));
const DAY = "2026-09-10";

async function seedFile(id: string, extra: Record<string, unknown> = {}) {
  await db.collection("files").doc(id).set({
    userId: ME,
    fileName: `${id}.pdf`,
    fileType: "application/pdf",
    extractionComplete: true,
    extractedAmount: 4990,
    extractedCurrency: "EUR",
    extractedDate: day(DAY),
    extractedPartner: "Hetzner Online GmbH",
    transactionIds: [],
    ...extra,
  });
}

async function seedTx(id: string, extra: Record<string, unknown> = {}) {
  await db.collection("transactions").doc(id).set({
    userId: ME,
    amount: -4990,
    currency: "EUR",
    date: day(DAY),
    name: "HETZNER ONLINE",
    fileIds: [],
    ...extra,
  });
}

async function file(id: string): Promise<{ id: string; data: FirebaseFirestore.DocumentData }> {
  return { id, data: (await db.collection("files").doc(id).get()).data()! };
}

const tx = (id: string) => db.collection("transactions").doc(id).get();

/** What each direction offers for the pair f-1 / t-1, without and with a search. */
async function bothDirections(search?: string) {
  const fromFile = await transactionsForFile(db, ME, await file("f-1"), { search });
  const fromTx = await filesForTransaction(db, ME, await tx("t-1"), { search });
  return {
    fromFile: fromFile.matches.find((m) => m.transactionId === "t-1"),
    fromTx: fromTx.matches.find((m) => m.fileId === "f-1"),
    ineligible: fromFile.ineligible,
  };
}

beforeEach(async () => {
  await __resetFirestoreShim();
  await seedTx("t-1");
});

describe("a plain pair", () => {
  it("is offered from both ends with the same score", async () => {
    await seedFile("f-1");
    const { fromFile, fromTx } = await bothDirections();
    expect(fromFile).toBeDefined();
    expect(fromTx).toBeDefined();
    expect(fromTx!.confidence).toBe(fromFile!.confidence);
    expect(fromTx!.breakdown).toEqual(fromFile!.breakdown);
    expect(fromFile!.hidden).toBeUndefined();
    expect((await scorePair(db, ME, await file("f-1"), await tx("t-1"))).match.confidence).toBe(
      fromFile!.confidence
    );
  });
});

describe("never possible, in every mode", () => {
  const CASES: Array<[string, Record<string, unknown>, string]> = [
    ["a deleted File", { deletedAt: day(DAY) }, "deleted"],
    ["a purged File", { purgedAt: day(DAY) }, "deleted"],
    ["a non-invoice", { isNotInvoice: true }, "not-invoice"],
    ["a File addressed to someone else", { foreignRecipient: true }, "foreign-recipient"],
    ["a Copy of a live original", { copyOfFileId: "f-original" }, "copy"],
  ];

  for (const [name, extra, reason] of CASES) {
    it(name, async () => {
      await seedFile("f-original", { extractedAmount: 1 });
      await seedFile("f-1", extra);
      for (const search of [undefined, "hetzner"]) {
        const { fromFile, fromTx, ineligible } = await bothDirections(search);
        expect({ search, fromFile, fromTx, ineligible }).toEqual({
          search,
          fromFile: undefined,
          fromTx: undefined,
          ineligible: reason,
        });
      }
      expect(await pairsAmong(db, ME, [await file("f-1")], [await tx("t-1")])).toEqual([]);
      expect((await scorePair(db, ME, await file("f-1"), await tx("t-1"))).ineligible).toBe(reason);
    });
  }

  it("a Copy whose original is gone is an ordinary File again", async () => {
    await seedFile("f-1", { copyOfFileId: "f-gone" });
    expect((await bothDirections()).fromFile).toBeDefined();
  });
});

describe("held back from suggestions and auto-connect, shown marked in a search", () => {
  const CASES: Array<[string, () => Promise<void>, string]> = [
    ["a Rejection on the File", () => seedFile("f-1", { dismissedTransactionIds: ["t-1"] }), "rejected"],
    [
      "a Rejection record on the File",
      () => seedFile("f-1", { dismissedTransactions: [{ transactionId: "t-1" }] }),
      "rejected",
    ],
    [
      "a Rejection on the Transaction",
      async () => {
        await seedFile("f-1");
        await seedTx("t-1", { rejectedFileIds: ["f-1"] });
      },
      "rejected",
    ],
    [
      "a Rejection record on the Transaction",
      async () => {
        await seedFile("f-1");
        await seedTx("t-1", { rejectedFiles: [{ fileId: "f-1" }] });
      },
      "rejected",
    ],
    [
      "an over-quota Transaction",
      async () => {
        await seedFile("f-1");
        await seedTx("t-1", { quotaExceeded: true });
      },
      "over-quota",
    ],
  ];

  for (const [name, seed, reason] of CASES) {
    it(name, async () => {
      await seed();
      const ranked = await bothDirections();
      expect({ fromFile: ranked.fromFile, fromTx: ranked.fromTx }).toEqual({
        fromFile: undefined,
        fromTx: undefined,
      });
      expect(await pairsAmong(db, ME, [await file("f-1")], [await tx("t-1")])).toEqual([]);
      const [batch] = await transactionsForFiles(db, ME, [await file("f-1")]);
      expect(batch.matches).toEqual([]);

      const searched = await bothDirections("hetzner");
      expect(searched.fromFile?.hidden).toBe(reason);
      expect(searched.fromTx?.hidden).toBe(reason);
      // A search result never becomes a stored suggestion.
      expect(storedSuggestionsOf([searched.fromFile!])).toEqual([]);
      expect((await scorePair(db, ME, await file("f-1"), await tx("t-1"))).hidden).toBe(reason);
    });
  }

  it("an undone Rejection no longer counts", async () => {
    await seedFile("f-1", {
      dismissedTransactions: [{ transactionId: "t-1", undismissedAt: day(DAY) }],
    });
    await seedTx("t-1", { rejectedFiles: [{ fileId: "f-1", unrejectedAt: day(DAY) }] });
    const { fromFile, fromTx } = await bothDirections();
    expect(fromFile?.hidden).toBeUndefined();
    expect(fromTx?.hidden).toBeUndefined();
  });
});

describe("the date window", () => {
  it("reaches 30 days either side of the File's date and no further", async () => {
    await seedFile("f-1");
    await seedTx("t-1", { date: day("2026-10-10") });
    expect(await bothDirections()).toMatchObject({ fromFile: expect.anything(), fromTx: expect.anything() });

    await seedTx("t-1", { date: day("2026-10-11") });
    expect(await bothDirections()).toMatchObject({ fromFile: undefined, fromTx: undefined });
  });

  it("is lifted by a User's search", async () => {
    await seedFile("f-1");
    await seedTx("t-1", { date: day("2025-01-10") });
    const { fromFile, fromTx } = await bothDirections("hetzner");
    expect(fromFile).toBeDefined();
    expect(fromTx).toBeDefined();
  });

  it("always reaches the hinted Transaction", async () => {
    await seedFile("f-1", { precisionSearchHint: { transactionId: "t-1" } });
    await seedTx("t-1", { date: day("2026-12-20") });
    const { fromFile, fromTx } = await bothDirections();
    expect(fromFile).toBeDefined();
    expect(fromTx).toBeDefined();
  });

  it("always reaches a nominated Transaction (#589)", async () => {
    await seedFile("f-1");
    await seedTx("t-1", { date: day("2026-12-20") });
    const result = await transactionsForFile(db, ME, await file("f-1"), {
      nominatedTransactionIds: ["t-1"],
    });
    expect(result.matches.map((m) => m.transactionId)).toEqual(["t-1"]);
  });

  it(`scores an undated File against the ${UNDATED_RECENT_TRANSACTIONS} most recent Transactions`, async () => {
    await seedFile("f-1", { extractedDate: null });
    // t-1 is the oldest; the newer ones push it out of the recent set.
    await seedTx("t-1", { date: day("2020-01-01") });
    const fromTxBefore = await filesForTransaction(db, ME, await tx("t-1"));
    expect(fromTxBefore.matches.map((m) => m.fileId)).toEqual(["f-1"]);

    for (let i = 0; i < UNDATED_RECENT_TRANSACTIONS; i++) {
      await seedTx(`t-new-${i}`, { amount: -100 - i, date: day("2026-01-01") });
    }
    const { fromFile, fromTx } = await bothDirections();
    expect(fromFile).toBeUndefined();
    expect(fromTx).toBeUndefined();
    const fromNewest = await filesForTransaction(db, ME, await tx("t-new-0"));
    expect(fromNewest.matches.map((m) => m.fileId)).toEqual(["f-1"]);
  });
});

describe("what a File is already on", () => {
  it("is not offered again from either end", async () => {
    await seedFile("f-1", { transactionIds: ["t-1"] });
    await seedTx("t-1", { fileIds: ["f-1"] });
    const { fromFile, fromTx } = await bothDirections();
    expect(fromFile).toBeUndefined();
    expect(fromTx).toBeUndefined();
  });
});

describe("a File that is not stored yet", () => {
  it("is read through the same assembly as a stored one", async () => {
    await seedFile("f-1", {
      extractedAmount: 4670,
      extractedTipAmount: 320,
      extractedDueDate: day("2026-09-24"),
      documentType: "invoice",
      precisionSearchHint: { transactionId: "t-1" },
    });
    const stored = await file("f-1");
    const info = {
      extractedAmount: 4670,
      extractedTipAmount: 320,
      extractedCurrency: "EUR",
      extractedDate: `${DAY}T00:00:00.000Z`,
      extractedDueDate: "2026-09-24T00:00:00.000Z",
      extractedPartner: "Hetzner Online GmbH",
      documentType: "invoice",
      precisionSearchHint: { transactionId: "t-1" },
      // Not a scoring input: dropped.
      userId: "someone-else",
    };
    const unsaved: MatcherFile = { id: null, data: unsavedFileData(info) };
    expect(unsaved.data.userId).toBeUndefined();

    const [a, b] = await Promise.all([
      transactionsForFile(db, ME, stored),
      transactionsForFile(db, ME, unsaved),
    ]);
    const pick = (r: typeof a) => r.matches.map((m) => [m.transactionId, m.confidence, [...m.matchSources].sort()]);
    expect(pick(b)).toEqual(pick(a));
    expect(a.matches[0].matchSources).toContain("precision_hint");
  });
});
