/**
 * The split suggestion (#550): the Extraction call that reads a File also
 * says when one PDF holds several separately issued invoices or Receipts, and
 * the File stores the page ranges as a suggestion. No extra model call.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { getFirestore, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";
import { getStorage, _resetStorageForTests } from "./storage-shim";

const gemini = vi.hoisted(() => ({ queue: [] as string[], calls: 0 }));

vi.mock("@google-cloud/vertexai", () => ({
  VertexAI: class {
    getGenerativeModel() {
      return {
        generateContent: async () => {
          gemini.calls++;
          return {
            response: {
              candidates: [{ content: { role: "model", parts: [{ text: gemini.queue.shift() ?? "{}" }] } }],
              usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 },
            },
          };
        },
      };
    }
  },
}));

// REAL application code, unmodified:
import { runExtraction } from "../extraction/extractionCore";
import { handleTool } from "../tools/handlers";

const db = getFirestore();
const USER = "stefan-test";
const PDF_PATH = `users/${USER}/files/bundle.pdf`;
const PNG_PATH = `users/${USER}/files/photo.png`;

const SEGMENTS = [
  { pages: [1, 2], invoiceNumber: "PL600029H28QLI", issuer: "ezhoushihanyulishangmaoyouxiangongsi", total: 713 },
  { pages: [3, 3], invoiceNumber: "XX6000181KNHPT", issuer: "HongKong GainRush Logistics Co., Limited", total: 788 },
  { pages: [4, 4], invoiceNumber: "XX60003JTXCKLT", issuer: "Zhuzhouruimiaomumaoyiyouxiangongsi", total: 519 },
];

function extractionReply(segments: unknown) {
  return JSON.stringify({
    rawText: "Rechnung ... Quittung ... Quittung",
    extracted: {
      date: "2026-03-10",
      amount: 713,
      currency: "EUR",
      confidence: 0.9,
      invoiceNumber: "PL600029H28QLI",
      issuer: { name: "ezhoushihanyulishangmaoyouxiangongsi", vatId: "PL5263858326" },
    },
    segments,
  });
}

async function extract(fileId: string, segments: unknown, extra: Record<string, unknown> = {}, path = PDF_PATH) {
  const fileData = {
    userId: USER,
    fileName: "bundle.pdf",
    fileType: path === PDF_PATH ? "application/pdf" : "image/png",
    storagePath: path,
    extractionComplete: false,
    ...extra,
  };
  await db.collection("files").doc(fileId).set(fileData);
  gemini.queue.push(JSON.stringify({ isInvoice: true, confidence: 0.95 }), extractionReply(segments));
  await runExtraction(fileId, fileData, {});
  return (await db.collection("files").doc(fileId).get()).data()!;
}

beforeAll(() => {
  process.env.GCLOUD_PROJECT = "split-suggestion-test-project";
  process.env.FIBUKI_STORAGE = "memory";
});

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
  _resetStorageForTests();
  gemini.queue.length = 0;
  gemini.calls = 0;
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 4; i++) pdf.addPage();
  await getStorage().bucket().file(PDF_PATH).save(Buffer.from(await pdf.save()));
  const png = Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG\r\n\x1a\n"), Buffer.alloc(32)]);
  await getStorage().bucket().file(PNG_PATH).save(png);
  await db.collection("subscriptions").doc(USER).set({ userId: USER, automationMode: "passive", planId: "free" });
});

describe("the split suggestion from Extraction", () => {
  it("stores three segments with the page count, in the call that extracts the File", async () => {
    const file = await extract("f-bundle", SEGMENTS);
    expect(file.pageCount).toBe(4);
    expect(file.splitSuggestion).toEqual({ pageCount: 4, segments: SEGMENTS });
    // Classification plus Extraction, nothing more.
    expect(gemini.calls).toBe(2);
  });

  it("stores nothing for a reply without segments", async () => {
    const file = await extract("f-single", null);
    expect(file.pageCount).toBe(4);
    expect(file.splitSuggestion).toBeNull();
  });

  it("stores no new suggestion on a File the User said is not a bundle", async () => {
    const file = await extract("f-dismissed", SEGMENTS, {
      splitSuggestionDismissed: true,
      splitSuggestion: { pageCount: 4, segments: SEGMENTS },
    });
    expect(file.splitSuggestion).toBeNull();
    expect(file.splitSuggestionDismissed).toBe(true);
  });

  it("never stores one for an image", async () => {
    const file = await extract("f-photo", SEGMENTS, {}, PNG_PATH);
    expect(file.pageCount).toBeNull();
    expect(file.splitSuggestion).toBeNull();
  });

  it("drops segments that do not fit the pages", async () => {
    const outside = [SEGMENTS[0], { ...SEGMENTS[1], pages: [3, 5] }];
    expect((await extract("f-outside", outside)).splitSuggestion).toBeNull();
    const overlapping = [SEGMENTS[0], { ...SEGMENTS[1], pages: [2, 3] }];
    expect((await extract("f-overlap", overlapping)).splitSuggestion).toBeNull();
  });

  it("shows on get_file, and \"not a bundle\" clears it for good", async () => {
    await extract("f-bundle", SEGMENTS);
    const viaTool = (await handleTool(USER, "get_file", { fileId: "f-bundle" })) as Record<string, unknown>;
    expect(viaTool.splitSuggestion).toEqual({ pageCount: 4, segments: SEGMENTS });

    const { dismissSplitSuggestionCallable } = await import("../files/splitFile");
    await dismissSplitSuggestionCallable.run({ data: { fileId: "f-bundle" }, auth: { uid: USER, token: {} } } as never);
    const file = (await db.collection("files").doc("f-bundle").get()).data()!;
    expect(file.splitSuggestion).toBeNull();
    expect(file.splitSuggestionDismissed).toBe(true);
  });
});
