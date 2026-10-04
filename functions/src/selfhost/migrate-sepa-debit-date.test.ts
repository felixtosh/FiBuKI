/**
 * #619: the sweep that re-extracts Files whose SEPA collection sentence became
 * a Due Date only. Real Retry, real extraction worker, real Extraction; only
 * the model is stubbed.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";
import { drainExtractionQueue } from "./extraction-worker";
import { getStorage } from "./storage-shim";

const gemini = vi.hoisted(() => ({ reply: "{}", requests: 0 }));

vi.mock("@google-cloud/vertexai", () => ({
  VertexAI: class {
    getGenerativeModel() {
      return {
        generateContent: async () => {
          gemini.requests++;
          return {
            response: {
              candidates: [{ content: { role: "model", parts: [{ text: gemini.reply }] } }],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            },
          };
        },
      };
    }
  },
}));

import { migrateSepaDebitDate } from "./migrate-sepa-debit-date";

const db = getFirestore();
const silent = () => {};
const STORAGE_PATH = "uploads/sepa.pdf";
const SEPA_TEXT =
  "Rechnung Juni 2026. Der Gesamtbetrag wird frühestens am 20.06.2026 von Ihrem Konto per SEPA-Mandat eingezogen.";

/** The reply the current prompt is meant to produce for the sentence. */
const DEBIT_REPLY = JSON.stringify({
  extracted: { date: "2026-06-02", amount: 4990, confidence: 0.9 },
  additionalFields: [
    { key: "debitDate", label: "wird frühestens am ... eingezogen", value: "2026-06-20" },
  ],
});

async function seed(id: string, extra: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {
    userId: "u1",
    storagePath: STORAGE_PATH,
    fileType: "application/pdf",
    fileName: `${id}.pdf`,
    extractionComplete: true,
    extractionError: null,
    isNotInvoice: false,
    extractedDate: Timestamp.fromDate(new Date(Date.UTC(2026, 5, 2))),
    extractedText: SEPA_TEXT,
    // The legacy reading: the collection date as a keyless Zahlungstermin row.
    extractedAdditionalFields: [{ label: "Zahlungstermin", value: "2026-06-20" }],
    extractedDueDate: Timestamp.fromDate(new Date(Date.UTC(2026, 5, 20))),
    ...extra,
  };
  await db.collection("files").doc(id).set(data);
}

async function file(id: string) {
  return (await db.collection("files").doc(id).get()).data()!;
}

function run(opts: Parameters<typeof migrateSepaDebitDate>[0] = {}) {
  return migrateSepaDebitDate({ log: silent, drain: () => drainExtractionQueue(), ...opts });
}

beforeAll(() => {
  process.env.GCLOUD_PROJECT = "sepa-sweep-test-project";
  process.env.FIBUKI_STORAGE = "memory";
});

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
  gemini.reply = DEBIT_REPLY;
  gemini.requests = 0;
  await getStorage().bucket().file(STORAGE_PATH).save(Buffer.from("%PDF-1.4 fake"));
});

describe("migrateSepaDebitDate: who is a candidate", () => {
  beforeEach(async () => {
    await seed("f-sepa");
    await seed("f-lastschrift", { extractedText: "Zahlung per Lastschrift." });
    await seed("f-mandate", { extractedText: "SEPA-Basis-Lastschriftmandat Ref. 123" });
    await seed("f-plain", { extractedText: "Zahlbar bis 20.06.2026 auf AT12 3456." });
    await seed("f-has-debit", { extractedDebitDate: Timestamp.fromDate(new Date(Date.UTC(2026, 5, 20))) });
    await seed("f-legacy-debit-row", {
      extractedAdditionalFields: [{ label: "Einzugsdatum", value: "2026-06-20" }],
    });
    await seed("f-deleted", { deletedAt: Timestamp.now() });
    await seed("f-not-invoice", { isNotInvoice: true });
    await seed("f-errored", { extractionError: "boom" });
    await seed("f-running", { extractionComplete: false });
    await seed("f-no-text", { extractedText: null });
    await seed("f-corrected", {
      extractionCorrectedFields: { amount: Timestamp.now() },
      extractionCorrectedAt: Timestamp.now(),
    });
  });

  it("lists live, extracted Files that mention a collection and carry no Debit Date", async () => {
    const report = await run();
    expect(report.candidates.map((c) => c.fileId).sort()).toEqual(
      ["f-corrected", "f-lastschrift", "f-mandate", "f-sepa"],
    );
    const sepa = report.candidates.find((c) => c.fileId === "f-sepa")!;
    expect(sepa).toMatchObject({ userId: "u1", matched: "SEPA-Mandat", dueDate: "2026-06-20", handCorrected: [] });
    expect(report.candidates.find((c) => c.fileId === "f-mandate")!.matched).toBe("SEPA-Basis-Lastschriftmandat");
    expect(report.candidates.find((c) => c.fileId === "f-corrected")!.handCorrected).toEqual(["amount"]);
  });

  it("is a dry run by default: nothing is queued, reset or extracted", async () => {
    const report = await run();
    expect(report.applied).toBe(false);
    expect(report.queued).toEqual([]);
    expect(gemini.requests).toBe(0);
    expect((await file("f-sepa")).extractionComplete).toBe(true);
    expect((await file("f-sepa")).extractedDebitDate).toBeUndefined();
  });
});

describe("migrateSepaDebitDate: the applied run", () => {
  it("re-extracts the candidate, which gains its Debit Date, and reports it", async () => {
    await seed("f-sepa");
    await seed("f-plain", { extractedText: "Zahlbar bis 20.06.2026." });

    const report = await run({ apply: true });

    expect(report.queued).toEqual(["f-sepa"]);
    expect(report.gainedDebitDate).toEqual([{ fileId: "f-sepa", debitDate: "2026-06-20" }]);
    expect(report.skippedHandCorrected).toEqual([]);
    expect(report.stillRunning).toEqual([]);
    expect(gemini.requests).toBe(1); // only the candidate was extracted

    const doc = await file("f-sepa");
    expect(doc.extractionComplete).toBe(true);
    const debit = (doc.extractedDebitDate as Timestamp).toDate();
    expect(debit.toISOString().slice(0, 10)).toBe("2026-06-20");
    // The collection date is no longer read as a Due Date.
    expect(doc.extractedDueDate).toBeNull();
  });

  it("skips a hand-corrected File through the Retry's own refusal and leaves it untouched", async () => {
    await seed("f-sepa");
    await seed("f-corrected", {
      extractedAmount: 5000,
      extractionCorrectedFields: { amount: Timestamp.now() },
      extractionCorrectedAt: Timestamp.now(),
    });

    const report = await run({ apply: true });

    expect(report.skippedHandCorrected).toEqual(["f-corrected"]);
    expect(report.queued).toEqual(["f-sepa"]);
    expect(report.gainedDebitDate.map((g) => g.fileId)).toEqual(["f-sepa"]);
    const corrected = await file("f-corrected");
    expect(corrected.extractedAmount).toBe(5000);
    expect(corrected.extractionComplete).toBe(true);
    expect(corrected.extractedDebitDate).toBeUndefined();
    expect(gemini.requests).toBe(1);
  });

  it("with userId, touches only that user's Files", async () => {
    await seed("f-mine");
    await seed("f-theirs", { userId: "u2" });

    const report = await run({ apply: true, userId: "u1" });

    expect(report.candidates.map((c) => c.fileId)).toEqual(["f-mine"]);
    expect(report.queued).toEqual(["f-mine"]);
    const theirs = await file("f-theirs");
    expect(theirs.extractionComplete).toBe(true);
    expect(theirs.extractedDebitDate).toBeUndefined();
  });

  it("reports a File the fresh Extraction still reads no Debit Date on", async () => {
    await seed("f-sepa");
    gemini.reply = JSON.stringify({ extracted: { date: "2026-06-02", amount: 4990, confidence: 0.9 } });

    const report = await run({ apply: true });

    expect(report.gainedDebitDate).toEqual([]);
    expect(report.noDebitDate).toEqual(["f-sepa"]);
  });

  it("reports Files whose Extraction has not finished when the wait runs out", async () => {
    await seed("f-sepa");

    const report = await run({ apply: true, drain: undefined, timeoutMs: 0 });

    expect(report.queued).toEqual(["f-sepa"]);
    expect(report.stillRunning).toEqual(["f-sepa"]);
    expect(report.gainedDebitDate).toEqual([]);
    // Leave the queue empty for the next test.
    await drainExtractionQueue();
  });
});
