/**
 * #564: Extraction reads the number of the invoice a credit note corrects.
 *
 * The correction link matches on it: a credit note whose referenced number is
 * the invoice number of a File of the same Partner links to that File without
 * a person. So the prompt has to name the wordings a Gutschrift, a
 * Rechnungskorrektur or an English credit note print it under, keep it apart
 * from the document's own number, and the parser has to keep a transcription
 * and drop an invention.
 *
 * The AI/network boundary is stubbed the way extraction-characterization does
 * it; the parser itself is real application code.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const gemini = vi.hoisted(() => ({
  queue: [] as string[],
  requests: [] as Array<{ contents: Array<{ parts: Array<Record<string, unknown>> }> }>,
}));

vi.mock("@google-cloud/vertexai", () => ({
  VertexAI: class {
    getGenerativeModel() {
      return {
        generateContent: async (req: unknown) => {
          gemini.requests.push(req as (typeof gemini.requests)[number]);
          return {
            response: {
              candidates: [
                { content: { role: "model", parts: [{ text: gemini.queue.shift() ?? "{}" }] } },
              ],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            },
          };
        },
      };
    }
  },
}));

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({ collection: () => ({}) }),
  Timestamp: { fromDate: (d: Date) => d, now: () => new Date() },
}));
vi.mock("firebase-admin/storage", () => ({ getStorage: () => ({}) }));

import { parseWithGemini } from "../geminiParser";

beforeEach(() => {
  process.env.GCLOUD_PROJECT = "referenced-invoice-test-project";
  gemini.queue.length = 0;
  gemini.requests.length = 0;
});

async function parse(extracted: Record<string, unknown>) {
  gemini.queue.push(JSON.stringify({ isInvoice: true, extracted }));
  return parseWithGemini(Buffer.from("x"), "application/pdf");
}

describe("the Extraction prompt: the referenced invoice number (#564)", () => {
  it("names the German and English wordings a correction prints it under", async () => {
    gemini.queue.push("{}");
    await parseWithGemini(Buffer.from("x"), "application/pdf");
    const prompt = gemini.requests[0].contents[0].parts.find((p) => typeof p.text === "string")
      ?.text as string;
    for (const wording of ["zu Rechnung Nr.", "Bezug auf", "Original invoice", "korrektur zu"]) {
      expect(prompt).toContain(wording);
    }
    expect(prompt).toContain('"referencedInvoiceNumber"');
  });
});

describe("parsing the referenced invoice number (#564)", () => {
  it("keeps a German Gutschrift's reference beside its own number", async () => {
    const r = await parse({
      amount: -3119,
      selfDesignation: "Gutschrift",
      invoiceNumber: "GS-2026-0012",
      referencedInvoiceNumber: "DE5ABC1234",
    });
    expect(r.extracted.invoiceNumber).toBe("GS-2026-0012");
    expect(r.extracted.referencedInvoiceNumber).toBe("DE5ABC1234");
  });

  it("keeps an English credit note's reference", async () => {
    const r = await parse({ amount: -906, selfDesignation: "Credit Note", referencedInvoiceNumber: "INV-778" });
    expect(r.extracted.referencedInvoiceNumber).toBe("INV-778");
  });

  it("reads an absence as null, and an invented non-string as nothing", async () => {
    expect((await parse({ amount: 1200 })).extracted.referencedInvoiceNumber).toBeNull();
    expect((await parse({ amount: 1200, referencedInvoiceNumber: 4711 })).extracted.referencedInvoiceNumber).toBeNull();
  });
});
