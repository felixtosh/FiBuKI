/**
 * Marking a File Not Invoice derives what Extraction's not-invoice path
 * derives (#710), on the self-host shim.
 *
 * Twins of one invoice File: the REAL Extraction classifies one as not an
 * invoice, and the callable (the button) or the MCP tool marks the other.
 * Their Document Type, direction review and other derived fields are compared
 * field by field, and so is the Documentation State of each connected
 * Transaction. The MCP tool refuses a File that is still connected, so its
 * twins are unconnected. Un-marking then re-extracts the File and recomputes
 * them again.
 *
 * Only the model boundary is swapped: `@google-cloud/vertexai` answers from a
 * queue of canned responses, as in the Extraction characterization suite.
 *
 *   npx vitest run --config vitest.selfhost.config.ts src/selfhost/not-invoice-derived-fields.test.ts --pool=forks --maxWorkers=1
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";
import { getStorage } from "./storage-shim";

const gemini = vi.hoisted(() => ({ queue: [] as string[] }));

vi.mock("@google-cloud/vertexai", () => ({
  VertexAI: class {
    getGenerativeModel() {
      return {
        generateContent: async () => ({
          response: {
            candidates: [{ content: { role: "model", parts: [{ text: gemini.queue.shift() ?? "{}" }] } }],
            usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 },
          },
        }),
      };
    }
  },
}));

// REAL application code, unmodified:
import { runExtraction } from "../extraction/extractionCore";
import { drainExtractionQueue } from "./extraction-worker";
import { markFileAsNotInvoiceCallable } from "../files/markFileAsNotInvoice";
import { unmarkFileAsNotInvoiceCallable } from "../files/unmarkFileAsNotInvoice";
import { markFileAsNotInvoice, unmarkFileAsNotInvoice } from "../tools/handlers";

const db = getFirestore();
const ME = "not-invoice-derived-me";
const STORAGE_PATH = "uploads/not-invoice-derived.jpg";

const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));

type Callable = { run: (req: unknown) => Promise<unknown> };
const asUser = (callable: unknown, data: unknown) =>
  (callable as Callable).run({ data, auth: { uid: ME, token: {} } });

const fileData = async (id: string) => (await db.collection("files").doc(id).get()).data()!;
const stateOf = async (id: string) =>
  (await db.collection("transactions").doc(id).get()).data()!.documentationState;

/** Every field the derivation writes onto a File ruled not an invoice. */
const DERIVED_FIELDS = [
  "documentType",
  "documentTypeBasis",
  "documentTypeMissingElements",
  "foreignRecipient",
  "needsDirectionReview",
  "directionReviewReason",
  "directionSuggested",
  "directionConflictTransactionIds",
  "needsVatRateReview",
  "vatRatesOutsideSet",
  "needsRepairReview",
  "repairAmbiguousFields",
  "needsRksvCodeReview",
  "rksvCodeDisagreeingRates",
] as const;

/**
 * An extracted invoice whose derived fields all say something: an Invoice
 * Document Type with a self-designation in its basis, and a direction review
 * that is open. Connected, its Transaction (money out on an outgoing invoice)
 * contradicts the direction and is documented by it; unconnected, the
 * direction is unknown.
 */
async function seedTwin(fileId: string, { connected }: { connected: boolean }) {
  const transactionId = `tx-${fileId}`;
  if (connected) {
    await db.collection("transactions").doc(transactionId).set({
      userId: ME,
      amount: -12000,
      date: day("2026-03-02"),
      name: "Lieferant GmbH",
      fileIds: [fileId],
      isComplete: true,
      documentationState: "invoice",
    });
  }
  await db.collection("files").doc(fileId).set({
    userId: ME,
    fileName: `${fileId}.jpg`,
    fileType: "image/jpeg",
    storagePath: STORAGE_PATH,
    classificationComplete: true,
    extractionComplete: true,
    isNotInvoice: false,
    extractedAmount: 12000,
    extractedVatAmount: 2000,
    extractedVatPercent: 20,
    extractedCurrency: "EUR",
    extractedDate: day("2026-03-01"),
    extractedPartner: "Lieferant GmbH",
    extractedSelfDesignation: "Rechnung",
    extractedInvoiceNumber: "R-2026-17",
    invoiceDirection: connected ? "outgoing" : "unknown",
    matchedUserAccount: connected ? "issuer" : null,
    recipientIdentityMatch: "third-party",
    documentType: "invoice",
    documentTypeBasis: { reason: "invoice-complete", selfDesignation: "Rechnung" },
    documentTypeMissingElements: [],
    foreignRecipient: false,
    needsDirectionReview: true,
    directionReviewReason: connected ? "conflict" : "unknown-direction",
    directionSuggested: connected ? "incoming" : null,
    directionConflictTransactionIds: connected ? [transactionId] : [],
    partnerMatchComplete: true,
    transactionMatchComplete: true,
    transactionIds: connected ? [transactionId] : [],
  });
}

/** Extraction's not-invoice path: the classifier says it is not an invoice. */
async function extractAsNotInvoice(fileId: string) {
  gemini.queue.push(JSON.stringify({ isInvoice: false, reason: "Bank statement", confidence: 0.9 }));
  await runExtraction(fileId, await fileData(fileId), {});
}

async function expectSameDerivedFields(markedId: string, extractedId: string) {
  const marked = await fileData(markedId);
  const extracted = await fileData(extractedId);
  for (const field of DERIVED_FIELDS) {
    expect(marked[field], field).toEqual(extracted[field]);
  }
  // What they are: Other, nothing to review, the old self-designation gone.
  expect(extracted).toMatchObject({
    isNotInvoice: true,
    documentType: "other",
    foreignRecipient: false,
    needsDirectionReview: false,
    directionReviewReason: null,
    directionSuggested: null,
    directionConflictTransactionIds: [],
  });
  expect(extracted.documentTypeBasis).toMatchObject({
    reason: "not-a-financial-document",
    selfDesignation: null,
  });
}

beforeAll(async () => {
  process.env.GCLOUD_PROJECT = "not-invoice-derived-test";
  process.env.FIBUKI_STORAGE = "memory";
  delete process.env.GEMINI_MODEL;
  // The upload and undelete triggers, as the barrel registers them.
  await import("../extraction/extractFileData");
});

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
  gemini.queue.length = 0;
  await getStorage().bucket().file(STORAGE_PATH).save(Buffer.from("fake-image-bytes"));
});

describe("marking Not Invoice leaves what Extraction's not-invoice path leaves (#710)", () => {
  it("by the button, on a connected File: the same derived fields, field by field, and the same Documentation State", async () => {
    await seedTwin("by-extraction", { connected: true });
    await seedTwin("by-button", { connected: true });
    await drainTriggers();

    await extractAsNotInvoice("by-extraction");
    await asUser(markFileAsNotInvoiceCallable, { fileId: "by-button", reason: "Bank statement" });
    await drainTriggers();

    await expectSameDerivedFields("by-button", "by-extraction");

    // The connected Transactions follow the Document Type: a document that is
    // not an invoice establishes nothing.
    expect(await stateOf("tx-by-extraction")).toBe("unknown");
    expect(await stateOf("tx-by-button")).toBe("unknown");
  });

  it("by MCP, on an unconnected File: the same derived fields, field by field", async () => {
    await seedTwin("by-extraction", { connected: false });
    await seedTwin("by-mcp", { connected: false });
    await drainTriggers();

    await extractAsNotInvoice("by-extraction");
    await markFileAsNotInvoice(ME, { fileId: "by-mcp", reason: "Bank statement" });
    await drainTriggers();

    await expectSameDerivedFields("by-mcp", "by-extraction");
  });

  it("the MCP tool still refuses a connected File, and writes nothing", async () => {
    await seedTwin("connected", { connected: true });
    await drainTriggers();

    await expect(markFileAsNotInvoice(ME, { fileId: "connected" })).rejects.toThrow("disconnect it first");
    expect(await fileData("connected")).toMatchObject({ isNotInvoice: false, documentType: "invoice" });
    expect(await stateOf("tx-connected")).toBe("invoice");
  });
});

describe("un-marking re-extracts and recomputes them again (#710)", () => {
  /** The Extraction an un-marked File gets: a small invoice to a third party, read again. */
  const invoiceAgain = () =>
    gemini.queue.push(
      JSON.stringify({
        rawText: "Rechnung R-2026-17 Lieferant GmbH",
        extracted: {
          date: "2026-03-01",
          amount: 12000,
          currency: "EUR",
          vatPercent: 20,
          lineItems: [{ description: "Kabel", vatPercent: 20, vatAmount: 2000, amount: 12000 }],
          confidence: 0.9,
          issuer: { name: "Lieferant GmbH", address: "Hauptstraße 1, 1010 Wien", vatId: "ATU12345678" },
          recipient: { name: "Kunde KG", address: "Ring 2, 1010 Wien" },
        },
        additionalFields: [{ key: "invoiceNumber", label: "Rechnungsnummer", value: "R-2026-17" }],
      })
    );

  /** The File as the new reading leaves it: classified again, not left at what marking set. */
  async function expectRecomputed(fileId: string) {
    const reread = await fileData(fileId);
    expect(reread).toMatchObject({ isNotInvoice: false, extractionComplete: true, extractedAmount: 12000 });
    expect((reread.lastFactChange as { origin: string }).origin).toBe("extraction");
    expect(reread.documentType).toBe("invoice");
    expect((reread.documentTypeBasis as { reason: string }).reason).not.toBe("not-a-financial-document");
    return reread;
  }

  it("by the button: the Document Type, the direction review and the Documentation State come back from the new reading", async () => {
    await seedTwin("f", { connected: true });
    await drainTriggers();

    await asUser(markFileAsNotInvoiceCallable, { fileId: "f" });
    await drainTriggers();
    expect(await fileData("f")).toMatchObject({ documentType: "other", needsDirectionReview: false });
    expect(await stateOf("tx-f")).toBe("unknown");

    await asUser(unmarkFileAsNotInvoiceCallable, { fileId: "f" });
    await drainTriggers();
    invoiceAgain();
    expect(await drainExtractionQueue()).toBe(1);
    await drainTriggers();

    const reread = await expectRecomputed("f");
    // No identity on file, so the direction is unknown: the review asks, and
    // suggests what the money out says.
    expect(reread).toMatchObject({
      needsDirectionReview: true,
      directionReviewReason: "unknown-direction",
      directionSuggested: "incoming",
    });
    // The Transaction follows the Document Type back.
    expect(await stateOf("tx-f")).toBe("invoice");
  });

  it("by MCP: the Document Type and the direction review come back from the new reading", async () => {
    await seedTwin("f", { connected: false });
    await drainTriggers();

    await markFileAsNotInvoice(ME, { fileId: "f" });
    await drainTriggers();
    expect(await fileData("f")).toMatchObject({ documentType: "other", needsDirectionReview: false });

    await unmarkFileAsNotInvoice(ME, { fileId: "f" });
    await drainTriggers();
    invoiceAgain();
    expect(await drainExtractionQueue()).toBe(1);
    await drainTriggers();

    const reread = await expectRecomputed("f");
    expect(reread).toMatchObject({
      needsDirectionReview: true,
      directionReviewReason: "unknown-direction",
      directionSuggested: null,
    });
  });
});
