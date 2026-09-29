/**
 * #377: the Extraction requests JSON mode instead of relying on repairJson.
 *
 * repairJson rewrote a document's own backslashes ("C:\temp" became
 * "C:<tab>emp"), so the main path must never need it. It stays as the
 * fallback for a provider without JSON mode.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const gemini = vi.hoisted(() => ({ queue: [] as string[], requests: [] as unknown[] }));

vi.mock("@google-cloud/vertexai", () => ({
  VertexAI: class {
    getGenerativeModel() {
      return {
        generateContent: async (request: unknown) => {
          gemini.requests.push(request);
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
  process.env.GCLOUD_PROJECT = "json-mode-test-project";
  gemini.queue.length = 0;
  gemini.requests.length = 0;
});

describe("parseWithGemini: JSON mode", () => {
  it("asks the model for application/json", async () => {
    gemini.queue.push(JSON.stringify({ extracted: { amount: 1000 } }));

    await parseWithGemini(Buffer.from("x"), "application/pdf");

    expect(gemini.requests[0]).toMatchObject({
      generationConfig: { responseMimeType: "application/json" },
    });
  });

  it("keeps a document's backslashes exactly as a JSON-mode response carries them", async () => {
    gemini.queue.push(JSON.stringify({ rawText: "Pfad C:\\temp\\beleg.pdf", extracted: {} }));

    const res = await parseWithGemini(Buffer.from("x"), "application/pdf");

    expect(res.rawText).toBe("Pfad C:\\temp\\beleg.pdf");
  });

  it("still repairs a malformed response from a provider without JSON mode", async () => {
    gemini.queue.push('```json\n{"extracted": {"amount": 1000,}}\n```');

    const res = await parseWithGemini(Buffer.from("x"), "application/pdf");

    expect(res.extracted.amount).toBe(1000);
  });
});
