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

describe("the date window reaches to the Due Date or Debit Date (#614)", () => {
  /** The calendar day `n` days after the File's date, as an ISO day. */
  const isoPlus = (n: number) =>
    new Date(Date.parse(`${DAY}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const plus = (n: number) => day(isoPlus(n));

  /**
   * Is t-1, dated `n` days after the File, a candidate? Asked from the File,
   * from the Transaction, in a batch and in Partner matching: they agree.
   */
  async function reaches(n: number): Promise<boolean> {
    await seedTx("t-1", { date: plus(n) });
    const { fromFile, fromTx } = await bothDirections();
    const among = await pairsAmong(db, ME, [await file("f-1")], [await tx("t-1")]);
    const [batch] = await transactionsForFiles(db, ME, [await file("f-1")]);
    const answers = [
      fromFile !== undefined,
      fromTx !== undefined,
      among.length > 0,
      batch.matches.some((m) => m.transactionId === "t-1"),
    ];
    expect({ n, answers }).toEqual({ n, answers: answers.map(() => answers[0]) });
    return answers[0];
  }

  it("stretches forward to a week past a Due Date at +45", async () => {
    await seedFile("f-1", { extractedDueDate: plus(45) });
    expect(await reaches(45)).toBe(true);
    expect(await reaches(52)).toBe(true);
    expect(await reaches(53)).toBe(false);
  });

  it("does not move the back edge", async () => {
    await seedFile("f-1", { extractedDueDate: plus(45) });
    expect(await reaches(-30)).toBe(true);
    expect(await reaches(-31)).toBe(false);
  });

  it("takes the later of the Debit Date and the Due Date", async () => {
    await seedFile("f-1", { extractedDueDate: plus(20), extractedDebitDate: plus(40) });
    expect(await reaches(47)).toBe(true);
    expect(await reaches(48)).toBe(false);
  });

  it("is not stretched by an anchor whose week ends inside ±30 days", async () => {
    await seedFile("f-1", { extractedDebitDate: plus(10) });
    expect(await reaches(30)).toBe(true);
    expect(await reaches(31)).toBe(false);
  });

  it("stretches up to an anchor at +90", async () => {
    await seedFile("f-1", { extractedDueDate: plus(90) });
    expect(await reaches(97)).toBe(true);
    expect(await reaches(98)).toBe(false);
  });

  it("stays ±30 days for an anchor past +90, a misread", async () => {
    await seedFile("f-1", { extractedDueDate: plus(120) });
    expect(await reaches(30)).toBe(true);
    expect(await reaches(31)).toBe(false);
    expect(await reaches(120)).toBe(false);
    expect(await reaches(127)).toBe(false);
  });

  it("stretches the same for a legacy keyless Zahlungstermin row", async () => {
    await seedFile("f-1", {
      extractedAdditionalFields: [{ label: "Zahlungstermin", value: isoPlus(45) }],
    });
    expect(await reaches(52)).toBe(true);
    expect(await reaches(53)).toBe(false);
  });

  it("prefers the typed field over a legacy row, as the scorer does", async () => {
    await seedFile("f-1", {
      extractedDueDate: null,
      extractedAdditionalFields: [{ label: "Zahlungstermin", value: isoPlus(45) }],
    });
    expect(await reaches(31)).toBe(false);
  });

  it("is never stretched by a printed payment term", async () => {
    await seedFile("f-1", {
      extractedAdditionalFields: [{ key: "paymentTerms", label: "Zahlungsziel", value: "45 Tage" }],
    });
    expect(await reaches(31)).toBe(false);
  });

  it("is the anchor ± 30 days for an undated File, not the most recent Transactions", async () => {
    await seedFile("f-1", { extractedDate: null, extractedDueDate: plus(0) });
    expect(await reaches(-30)).toBe(true);
    expect(await reaches(30)).toBe(true);
    expect(await reaches(31)).toBe(false);
    expect(await reaches(-31)).toBe(false);
  });

  it("does not change what a pair inside ±30 days scores", async () => {
    await seedFile("f-1", { extractedDueDate: plus(45) });
    await seedTx("t-1", { date: plus(10) });
    const alone = (await transactionsForFile(db, ME, await file("f-1"))).matches.find(
      (m) => m.transactionId === "t-1"
    );
    await seedTx("t-2", { date: plus(50) });
    const stretched = await transactionsForFile(db, ME, await file("f-1"));
    expect(stretched.matches.map((m) => m.transactionId).sort()).toEqual(["t-1", "t-2"]);
    const t1 = stretched.matches.find((m) => m.transactionId === "t-1");
    expect(t1!.confidence).toBe(alone!.confidence);
    expect(t1!.breakdown).toEqual(alone!.breakdown);
  });
});
