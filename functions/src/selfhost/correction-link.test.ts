/**
 * The correction link through the data layer (#564): the automatic link from
 * the referenced invoice number, suggestions, a person's link and unlink, the
 * inspect view, and the backfill over existing credit notes.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";

// REAL application code, unmodified:
import {
  backfillCorrectionLinks,
  getCorrection,
  linkCorrection,
  runCorrectionCheck,
  unlinkCorrection,
} from "../corrections/correctionOps";
import { linkCorrectionCallable } from "../corrections/correctionCallables";

const db = getFirestore();
const USER = "stefan-test";
const OTHER = "someone-else";
const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00.000Z`));

async function seedFile(id: string, data: Record<string, unknown>, userId = USER) {
  await db.collection("files").doc(id).set({ userId, fileName: `${id}.pdf`, partnerId: "p-amazon", extractionComplete: true, ...data });
}

async function file(id: string) {
  return (await db.collection("files").doc(id).get()).data()!;
}

async function seedOriginal(id = "f-invoice", number = "INV-1", userId = USER) {
  await seedFile(
    id,
    {
      extractedAmount: 12000,
      extractedInvoiceNumber: number,
      extractedDate: day("2026-01-05"),
      transactionIds: ["t-purchase"],
    },
    userId
  );
}

async function seedCredit(over: Record<string, unknown> = {}) {
  await seedFile("f-credit", {
    extractedAmount: -3000,
    extractedSelfDesignation: "Gutschrift",
    extractedReferencedInvoiceNumber: "inv 1",
    extractedDate: day("2026-02-10"),
    transactionIds: ["t-refund"],
    ...over,
  });
}

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
});

describe("the correction check after Extraction", () => {
  it("links a credit note to its Partner's File on the referenced number", async () => {
    await seedOriginal();
    await seedCredit();
    const outcome = await runCorrectionCheck(db as never, "f-credit", await file("f-credit"));
    expect(outcome).toEqual({ kind: "linked", originalFileId: "f-invoice" });
    expect(await file("f-credit")).toMatchObject({
      correctionLink: { fileId: "f-invoice", setBy: "auto" },
      correctionKind: "invoice-correction",
      correctionSignalsDisagree: false,
    });
  });

  it("suggests by Partner and amount when no number matches, and links nothing", async () => {
    await seedOriginal("f-invoice", "OTHER-9");
    await seedCredit();
    const outcome = await runCorrectionCheck(db as never, "f-credit", await file("f-credit"));
    expect(outcome).toEqual({ kind: "suggested", fileIds: ["f-invoice"] });
    expect((await file("f-credit")).correctionLink ?? null).toBeNull();
  });

  it("never links to another user's File", async () => {
    await seedOriginal("f-theirs", "INV-1", OTHER);
    await seedCredit();
    expect(await runCorrectionCheck(db as never, "f-credit", await file("f-credit"))).toEqual({ kind: "none" });
  });

  it("keeps a link a person set", async () => {
    await seedOriginal();
    await seedOriginal("f-chosen", "X-2");
    await seedCredit({ correctionLink: { fileId: "f-chosen", setBy: "manual" } });
    expect(await runCorrectionCheck(db as never, "f-credit", await file("f-credit"))).toEqual({
      kind: "kept",
      originalFileId: "f-chosen",
    });
  });
});

describe("a person's link and unlink", () => {
  it("records an accepted suggestion as such", async () => {
    await seedOriginal("f-invoice", "OTHER-9");
    await seedCredit();
    await runCorrectionCheck(db as never, "f-credit", await file("f-credit"));
    const r = await linkCorrection(db as never, USER, { fileId: "f-credit", originalFileId: "f-invoice" });
    expect(r.setBy).toBe("suggested-accepted");
    expect((await file("f-credit")).correctionSuggestions).toEqual([]);
  });

  it("refuses another user's File as the original, as if it did not exist", async () => {
    await seedOriginal("f-theirs", "INV-1", OTHER);
    await seedCredit();
    await expect(
      linkCorrectionCallable.run({
        data: { fileId: "f-credit", originalFileId: "f-theirs" },
        auth: { uid: USER, token: {} },
      } as never)
    ).rejects.toThrow(/not found/i);
  });

  it("refuses a correction as an original", async () => {
    await seedOriginal();
    await seedCredit({ correctionLink: { fileId: "f-invoice", setBy: "auto" } });
    await seedFile("f-credit-2", { extractedAmount: -1000, extractedSelfDesignation: "Gutschrift" });
    await expect(
      linkCorrection(db as never, USER, { fileId: "f-credit-2", originalFileId: "f-credit" })
    ).rejects.toThrow(/itself a correction/);
  });

  it("unlinks, and the automatic link never sets that pair again", async () => {
    await seedOriginal();
    await seedCredit();
    await runCorrectionCheck(db as never, "f-credit", await file("f-credit"));
    const r = await unlinkCorrection(db as never, USER, { fileId: "f-credit" });
    expect(r).toMatchObject({ outcome: "unlinked", declinedFileId: "f-invoice" });
    expect(await runCorrectionCheck(db as never, "f-credit", await file("f-credit"))).toEqual({ kind: "none" });
  });
});

describe("inspecting a correction", () => {
  it("shows what a credit note corrects and who paid the original", async () => {
    await seedOriginal();
    await seedCredit({ correctionLink: { fileId: "f-invoice", setBy: "auto" } });
    await db.collection("transactions").doc("t-purchase").set({
      userId: USER,
      date: day("2026-01-05"),
      amount: -12000,
      partner: "Amazon",
      fileIds: ["f-invoice"],
    });
    await db.collection("transactions").doc("t-refund").set({
      userId: USER,
      date: day("2026-02-10"),
      amount: 3000,
      partner: "Amazon",
      fileIds: ["f-credit"],
    });
    const view = await getCorrection(db as never, USER, { fileId: "f-credit" });
    expect(view).toMatchObject({
      kind: "invoice-correction",
      link: { originalFileId: "f-invoice", setBy: "auto" },
      original: { fileId: "f-invoice", paidBy: [{ id: "t-purchase", amount: -12000 }] },
    });
    expect(await getCorrection(db as never, USER, { transactionId: "t-refund" })).toEqual({
      transactionId: "t-refund",
      related: [
        { id: "t-purchase", date: "2026-01-05", amount: -12000, partner: "Amazon", relation: "refund-of", viaFileId: "f-invoice" },
      ],
    });
    expect(await getCorrection(db as never, USER, { transactionId: "t-purchase" })).toMatchObject({
      related: [{ id: "t-refund", relation: "refunded-by", viaFileId: "f-credit" }],
    });
  });
});

describe("the backfill over existing credit notes (story 47)", () => {
  it("links and suggests across the user's Files, and is safe to run again", async () => {
    await seedOriginal();
    await seedCredit();
    await seedFile("f-ordinary", { extractedAmount: 5000, extractedSelfDesignation: "Rechnung" });
    expect(await backfillCorrectionLinks(db as never, USER)).toEqual({
      success: true,
      corrections: 1,
      linked: 1,
      suggested: 0,
    });
    expect(await backfillCorrectionLinks(db as never, USER)).toMatchObject({ corrections: 1, linked: 1 });
  });
});
