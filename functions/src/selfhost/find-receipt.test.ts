/**
 * #588: find-receipt judges a stored File with the matcher and auto-connects
 * only at the matcher's auto threshold, through the real connect path. Scores
 * themselves are held to the trigger's in scorer-parity.test.ts.
 *
 * The fixtures land on the threshold exactly: a cent-exact amount on the same
 * day is 40 + 25 + 20 = 85, the same pair under a Partner whose learned amount
 * weight is 0.975 is 39 + 25 + 20 = 84, and a day apart is 40 + 22 + 15 = 77,
 * inside the 10-point lead.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { findReceiptForTransactionCallable } from "../workflows/findReceiptForTransactionCallable";
import type { FindReceiptResult } from "../workflows/findReceiptForTransaction";

const db = getFirestore();
const ME = "fr-me";

const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));

function findReceipt(data: Record<string, unknown>, uid = ME) {
  return (
    findReceiptForTransactionCallable as unknown as {
      run: (req: unknown) => Promise<FindReceiptResult>;
    }
  ).run({ data, auth: { uid, token: {} } });
}

async function addFile(id: string, overrides: Record<string, unknown> = {}) {
  await db.collection("files").doc(id).set({
    userId: ME,
    fileName: `${id}.pdf`,
    extractionComplete: true,
    extractedAmount: 12345,
    extractedCurrency: "EUR",
    extractedDate: day("2026-03-10"),
    transactionIds: [],
    ...overrides,
  });
}

/** 85: cent-exact amount, same day. */
const at85 = () => addFile("f-85");
/** 84: the same pair, under a Partner that learned to trust amounts a little less. */
const at84 = () => addFile("f-84", { partnerId: "p-weighted" });
/** 77: cent-exact amount, a day later. */
const at77 = () => addFile("f-77", { extractedDate: day("2026-03-11") });

async function connections() {
  const snap = await db.collection("fileConnections").where("transactionId", "==", "t").get();
  return snap.docs.map((d) => d.data());
}

beforeEach(async () => {
  await __resetFirestoreShim();
  await db.collection("transactions").doc("t").set({
    userId: ME,
    sourceId: "src-1",
    amount: -12345,
    currency: "EUR",
    date: day("2026-03-10"),
    name: "SEPA 4711",
    fileIds: [],
  });
  await db.collection("partners").doc("p-weighted").set({
    userId: ME,
    name: "Zeta KG",
    scoringWeights: { amountWeight: 0.975, dateWeight: 1, partnerWeight: 1 },
    isActive: true,
  });
});

describe("find-receipt auto-connects at the matcher's threshold (#588)", () => {
  it("connects a stored File at 85 with a 10-point lead, through the real connect path", async () => {
    await at85();
    // 63: a near amount on the same day, far enough behind.
    await addFile("f-63", { extractedAmount: 12300 });

    const result = await findReceipt({ transactionId: "t" });

    expect(result).toMatchObject({ status: "connected", fileId: "f-85", confidence: 85 });
    const [connection, ...more] = await connections();
    expect(more).toHaveLength(0);
    expect(connection).toMatchObject({
      fileId: "f-85",
      connectionType: "auto_matched",
      matchConfidence: 85,
    });
    const tx = (await db.collection("transactions").doc("t").get()).data()!;
    expect(tx.fileIds).toEqual(["f-85"]);
    expect(tx.isComplete).toBe(true);
    // Only the real connect writes the Activity entry; the old inline write did not.
    expect(tx.automationHistory).toEqual([
      expect.objectContaining({ type: "file_connected", fileId: "f-85", confidence: 85 }),
    ]);
    const file = (await db.collection("files").doc("f-85").get()).data()!;
    expect(file.transactionIds).toEqual(["t"]);
  });

  it("returns a File at 84 as a candidate and connects nothing", async () => {
    await at84();

    const result = await findReceipt({ transactionId: "t" });

    expect(result.status).toBe("needs_review");
    expect(result.candidates).toEqual([
      expect.objectContaining({
        source: "local_file",
        fileId: "f-84",
        score: 84,
        filename: "f-84.pdf",
      }),
    ]);
    expect(await connections()).toHaveLength(0);
  });

  it("returns a File at 85 without a 10-point lead as a candidate and connects nothing", async () => {
    await at85();
    await at77();

    const result = await findReceipt({ transactionId: "t" });

    expect(result.status).toBe("needs_review");
    expect(result.candidates?.map((c) => [c.fileId, c.score])).toEqual([
      ["f-85", 85],
      ["f-77", 77],
    ]);
    expect(await connections()).toHaveLength(0);
  });

  it("does not auto-connect onto an over-quota Transaction", async () => {
    await at85();
    await db.collection("transactions").doc("t").update({ quotaExceeded: true });

    const result = await findReceipt({ transactionId: "t" });

    expect(result.status).toBe("needs_review");
    expect(await connections()).toHaveLength(0);
  });
});

describe("candidates start at the matcher's suggestion threshold (#588)", () => {
  it("surfaces nothing below 50", async () => {
    // Amount far off, same day: the matcher keeps this off the suggestion list.
    await addFile("f-low", { extractedAmount: 99900 });

    const result = await findReceipt({ transactionId: "t" });

    expect(result.status).toBe("no_match");
    expect(result.sourcesChecked.localFiles).toBe(1);
  });
});

describe("the request does not move the line (#588)", () => {
  it("ignores an auto-connect threshold", async () => {
    await at84();

    const result = await findReceipt({ transactionId: "t", autoConnectThreshold: 50 });

    expect(result.status).toBe("needs_review");
    expect(await connections()).toHaveLength(0);
  });

  it("ignores a candidate floor in either direction", async () => {
    await at84();
    await addFile("f-low", { extractedAmount: 99900 });

    const raised = await findReceipt({ transactionId: "t", candidateFloor: 99 });
    const lowered = await findReceipt({ transactionId: "t", candidateFloor: 0 });
    const plain = await findReceipt({ transactionId: "t" });

    expect(raised).toEqual(plain);
    expect(lowered).toEqual(plain);
    expect(plain.candidates?.map((c) => c.fileId)).toEqual(["f-84"]);
  });
});

describe("Rejections keep a File out, as in the trigger", () => {
  it("skips a File that dismissed this Transaction", async () => {
    await at85();
    await db.collection("files").doc("f-85").update({ dismissedTransactionIds: ["t"] });

    const result = await findReceipt({ transactionId: "t" });

    expect(result.status).toBe("no_match");
    expect(await connections()).toHaveLength(0);
  });

  it("skips a File the Transaction rejected", async () => {
    await at85();
    await db.collection("transactions").doc("t").update({ rejectedFileIds: ["f-85"] });

    const result = await findReceipt({ transactionId: "t" });

    expect(result.status).toBe("no_match");
    expect(await connections()).toHaveLength(0);
  });
});
