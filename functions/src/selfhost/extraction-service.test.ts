/**
 * #161: an external Extraction Service replaces the built-in Gemini, end to
 * end on the self-host shims.
 *
 * A fake service runs on a local port and speaks the published contract. The
 * REAL extraction core runs unmodified; Gemini is mocked only to prove it is
 * never called while a service is configured (no fallback, decision 4).
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "http";
import type { AddressInfo } from "net";
import { MODELS } from "../utils/models";
import { getFirestore, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";
import { getStorage } from "./storage-shim";

const gemini = vi.hoisted(() => ({ queue: [] as string[], requests: [] as unknown[] }));

vi.mock("@google-cloud/vertexai", () => ({
  VertexAI: class {
    getGenerativeModel() {
      return {
        generateContent: async (req: unknown) => {
          gemini.requests.push(req);
          return {
            response: {
              candidates: [
                { content: { role: "model", parts: [{ text: gemini.queue.shift() ?? "{}" }] } },
              ],
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
import { extractQueuedFile } from "../extraction/extractQueuedFile";
import { EXTRACTION_CONTRACT_VERSION } from "../extraction/extractionService";

// ---------------------------------------------------------------------------
// The fake Extraction Service
// ---------------------------------------------------------------------------

interface FakeReply {
  status?: number;
  body: unknown;
  delayMs?: number;
}

const fake = {
  replies: [] as FakeReply[],
  requests: [] as Array<{ headers: IncomingHttpHeaders; body: Record<string, unknown> }>,
};

let server: Server;
let serviceUrl: string;

beforeAll(async () => {
  process.env.GCLOUD_PROJECT = "service-test-project";
  process.env.FIBUKI_STORAGE = "memory";
  delete process.env.GEMINI_MODEL;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      fake.requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      const reply = fake.replies.shift() ?? { status: 500, body: { error: "no reply queued" } };
      setTimeout(() => {
        res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
        res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serviceUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/extract`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const SERVICE = { name: "fake-local-ocr", version: "0.1.0" };

function transcription(body: Record<string, unknown>, extra: Record<string, unknown> = {}): FakeReply {
  return {
    body: {
      contractVersion: EXTRACTION_CONTRACT_VERSION,
      service: SERVICE,
      outcome: "transcription",
      transcription: body,
      ...extra,
    },
  };
}

function notFinancial(reason: string): FakeReply {
  return {
    body: {
      contractVersion: EXTRACTION_CONTRACT_VERSION,
      service: SERVICE,
      outcome: "notFinancialDocument",
      reason,
      confidence: 0.8,
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const db = getFirestore();
const USER = "service-test-user";
const STORAGE_PATH = "uploads/service-test.pdf";
const PDF_BYTES = Buffer.from("%PDF-1.4\n%a document that never leaves for Gemini\n");
const RKSV = "_R1-AT0_K1_42_2026-01-02T10:00:00_12,00_0,00_0,00_0,00_0,00_x_y_z_sig";
const EPC = "BCD\n002\n1\nSCT\n\nLieferant GmbH\nAT611904300234573201\nEUR12.00\n";

async function seedFile(fileId: string, extra: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {
    userId: USER,
    storagePath: STORAGE_PATH,
    fileType: "application/octet-stream",
    fileName: "beleg.pdf",
    extractionComplete: false,
    ...extra,
  };
  await db.collection("files").doc(fileId).set(data);
  return data;
}

async function fileDoc(fileId: string): Promise<Record<string, unknown>> {
  return (await db.collection("files").doc(fileId).get()).data()!;
}

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
  gemini.queue.length = 0;
  gemini.requests.length = 0;
  fake.replies.length = 0;
  fake.requests.length = 0;
  process.env.FIBUKI_EXTRACTION_SERVICE_URL = serviceUrl;
  delete process.env.FIBUKI_EXTRACTION_SERVICE_TOKEN;
  delete process.env.FIBUKI_EXTRACTION_TIMEOUT_SECONDS;
  await getStorage().bucket().file(STORAGE_PATH).save(PDF_BYTES);
});

afterEach(() => {
  delete process.env.FIBUKI_EXTRACTION_SERVICE_URL;
  delete process.env.FIBUKI_EXTRACTION_SERVICE_TOKEN;
  delete process.env.FIBUKI_EXTRACTION_TIMEOUT_SECONDS;
});

// ===========================================================================

describe("#161: an external Extraction Service", () => {
  it("does the Extraction in one call, and Gemini is never asked", async () => {
    const fileData = await seedFile("f-one");
    fake.replies.push(
      transcription({
        rawText: "Rechnung Nr. 7 von Lieferant GmbH",
        extracted: {
          date: "2026-01-02",
          amount: 1200,
          currency: "EUR",
          vatPercent: 20,
          invoiceNumber: "7",
          confidence: 0.9,
          issuer: { name: "Lieferant GmbH", vatId: "ATU 1234 5678" },
        },
      })
    );

    await runExtraction("f-one", fileData, {});

    expect(gemini.requests).toHaveLength(0);
    expect(fake.requests).toHaveLength(1);
    const doc = await fileDoc("f-one");
    expect(doc.extractionComplete).toBe(true);
    expect(doc.extractionError).toBeNull();
    expect(doc.isNotInvoice).toBe(false);
    expect(doc.extractedAmount).toBe(1200);
    expect(doc.extractedInvoiceNumber).toBe("7");
    expect(doc.extractedPartner).toBe("Lieferant GmbH");
    // FiBuKI's own normalisation, not the service's
    expect(doc.extractedVatId).toBe("ATU12345678");
    expect(doc.extractedCountry).toBe("AT");
    expect(doc.extractionConfidence).toBe(90);
    expect(doc.extractedText).toBe("Rechnung Nr. 7 von Lieferant GmbH");
  });

  it("records which backend produced the Extraction", async () => {
    const fileData = await seedFile("f-prov");
    fake.replies.push(transcription({ extracted: { amount: 500, confidence: 0.5 } }));

    await runExtraction("f-prov", fileData, {});

    const doc = await fileDoc("f-prov");
    expect(doc.extractionProvider).toBe("external");
    expect(doc.extractionService).toEqual(SERVICE);
    expect(doc.extractionContractVersion).toBe(EXTRACTION_CONTRACT_VERSION);
  });

  it("sends only what transcription needs: bytes, sniffed MIME type, name, treatAsInvoice, version", async () => {
    const fileData = await seedFile("f-req");
    fake.replies.push(transcription({ extracted: { amount: 100 } }));

    await runExtraction("f-req", fileData, {});

    const { body } = fake.requests[0];
    expect(body).toEqual({
      contractVersion: EXTRACTION_CONTRACT_VERSION,
      file: {
        name: "beleg.pdf",
        mimeType: "application/pdf", // sniffed, not the stored octet-stream
        contentBase64: PDF_BYTES.toString("base64"),
      },
      treatAsInvoice: false,
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("f-req");
    expect(serialized).not.toContain(USER);
  });

  it("sends the bearer token when one is configured, and none otherwise", async () => {
    fake.replies.push(transcription({ extracted: { amount: 100 } }));
    await runExtraction("f-anon", await seedFile("f-anon"), {});
    expect(fake.requests[0].headers.authorization).toBeUndefined();

    process.env.FIBUKI_EXTRACTION_SERVICE_TOKEN = "s3cret-token";
    fake.replies.push(transcription({ extracted: { amount: 100 } }));
    await runExtraction("f-token", await seedFile("f-token"), {});
    expect(fake.requests[1].headers.authorization).toBe("Bearer s3cret-token");
  });

  it("stores a not-a-financial-document answer like Gemini's classification", async () => {
    const fileData = await seedFile("f-not", { extractedAmount: 999 });
    fake.replies.push(notFinancial("Bank statement"));

    await runExtraction("f-not", fileData, {});

    const doc = await fileDoc("f-not");
    expect(fake.requests).toHaveLength(1);
    expect(doc.classificationComplete).toBe(true);
    expect(doc.isNotInvoice).toBe(true);
    expect(doc.notInvoiceReason).toBe("Bank statement");
    expect(doc.extractionComplete).toBe(true);
    expect(doc.extractionConfidence).toBe(80);
    expect(doc.extractedAmount).toBeNull();
    expect(doc.extractionProvider).toBe("external");
    expect(doc.extractionService).toEqual(SERVICE);
  });

  it("carries the user's 'treat as invoice' override as treatAsInvoice", async () => {
    const fileData = await seedFile("f-override");
    fake.replies.push(transcription({ extracted: { amount: 4200, confidence: 0.5 } }));

    await runExtraction("f-override", fileData, { skipClassification: true });

    expect(fake.requests[0].body.treatAsInvoice).toBe(true);
    const doc = await fileDoc("f-override");
    expect(doc.isNotInvoice).toBe(false);
    expect(doc.extractedAmount).toBe(4200);
  });

  it("fails when the service refuses a document the user marked as an invoice", async () => {
    const fileData = await seedFile("f-override-refused");
    fake.replies.push(notFinancial("Spam"));

    await expect(runExtraction("f-override-refused", fileData, { skipClassification: true })).rejects.toThrow(
      /treatAsInvoice/
    );
  });

  it("applies FiBuKI's own guards to the transcription", async () => {
    const fileData = await seedFile("f-guards");
    fake.replies.push(
      transcription({
        extracted: {
          amount: 1000,
          issuer: { name: "Agent Platform GmbH", vatId: "ATU87654321" },
          invoicingAgent: { name: "Agent Platform GmbH", vatId: "ATU87654321" },
        },
        additionalFields: [
          { key: "invoiceNumber", label: "Rechnungsnummer", value: "R-1" },
          { key: "tableNumber", label: "Tischnummer", value: "12" },
        ],
      })
    );

    await runExtraction("f-guards", fileData, {});

    const doc = await fileDoc("f-guards");
    // The Invoicing Agent never becomes the Partner (#156, ADR-0003)
    expect(doc.extractedPartner).toBeNull();
    expect((doc.extractedInvoicingAgent as { name: string }).name).toBe("Agent Platform GmbH");
    // The closed vocabulary (#252)
    expect((doc.extractedAdditionalFields as Array<{ key: string }>).map((f) => f.key)).toEqual(["invoiceNumber"]);
  });

  it("stores how each QR payload was decoded", async () => {
    const fileData = await seedFile("f-qr");
    fake.replies.push(
      transcription({
        extracted: { amount: 1200, confidence: 0.9 },
        qrCodes: [{ payload: RKSV, decodedBy: "barcode" }, EPC, { payload: "https://example.at/beleg" }],
      })
    );

    await runExtraction("f-qr", fileData, {});

    const codes = (await fileDoc("f-qr")).extractedQrCodes as Array<{ format: string; decodedBy: string }>;
    expect(codes.map((code) => [code.format, code.decodedBy])).toEqual([
      ["rksv", "barcode"],
      ["epc", "model"],
      ["url", "model"],
    ]);
  });

  it("logs one invocation under the service's name, with no cost", async () => {
    fake.replies.push(transcription({ extracted: { amount: 100 } }));
    await runExtraction("f-usage0", await seedFile("f-usage0"), {});
    fake.replies.push(transcription({ extracted: { amount: 100 } }, { usage: { inputTokens: 1500, outputTokens: 300 } }));
    await runExtraction("f-usage1", await seedFile("f-usage1"), {});

    const rows = (await db.collection("aiUsage").where("userId", "==", USER).get()).docs.map(
      (d) => d.data() as Record<string, unknown>
    );
    expect(rows).toHaveLength(2);
    const byFile = (fileId: string) => rows.find((r) => (r.metadata as { fileId: string }).fileId === fileId)!;
    expect(byFile("f-usage0")).toMatchObject({
      function: "extraction",
      model: "fake-local-ocr",
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
    });
    expect(byFile("f-usage1")).toMatchObject({
      model: "fake-local-ocr",
      inputTokens: 1500,
      outputTokens: 300,
      estimatedCost: 0,
    });
  });
});

describe("#161: no fallback when the service fails", () => {
  it("an HTTP error fails the Extraction and never reaches Gemini", async () => {
    const fileData = await seedFile("f-500");
    fake.replies.push({ status: 503, body: { error: "model loading" } });

    await expect(runExtraction("f-500", fileData, {})).rejects.toThrow(/Extraction Service.*503/);
    expect(gemini.requests).toHaveLength(0);
  });

  it("a response that fails the schema fails the Extraction", async () => {
    const fileData = await seedFile("f-schema");
    fake.replies.push(transcription({ extracted: { amount: "12,00" } }));

    await expect(runExtraction("f-schema", fileData, {})).rejects.toThrow(/schema/);
    expect(gemini.requests).toHaveLength(0);
  });

  it("a reply that is not JSON fails the Extraction", async () => {
    const fileData = await seedFile("f-html");
    fake.replies.push({ body: "<html>proxy error</html>" });

    await expect(runExtraction("f-html", fileData, {})).rejects.toThrow(/Extraction Service/);
  });

  it("another contract version fails the Extraction", async () => {
    const fileData = await seedFile("f-version");
    fake.replies.push({ body: { ...(transcription({}).body as object), contractVersion: "2" } });

    await expect(runExtraction("f-version", fileData, {})).rejects.toThrow(/schema/);
  });

  it("a service that does not answer in time fails the Extraction", async () => {
    process.env.FIBUKI_EXTRACTION_TIMEOUT_SECONDS = "0.2";
    const fileData = await seedFile("f-slow");
    fake.replies.push({ ...transcription({ extracted: { amount: 1 } }), delayMs: 1000 });

    await expect(runExtraction("f-slow", fileData, {})).rejects.toThrow(/did not answer/);
    expect(gemini.requests).toHaveLength(0);
  });

  it("an unreachable service fails the Extraction", async () => {
    process.env.FIBUKI_EXTRACTION_SERVICE_URL = "http://127.0.0.1:1/extract";
    const fileData = await seedFile("f-down");

    await expect(runExtraction("f-down", fileData, {})).rejects.toThrow(/Extraction Service/);
    expect(gemini.requests).toHaveLength(0);
  });

  it("the File shows the error and keeps no token in it", async () => {
    process.env.FIBUKI_EXTRACTION_SERVICE_TOKEN = "s3cret-token";
    await seedFile("f-queued");
    fake.replies.push({ status: 401, body: { error: "bad token s3cret-token" } });

    expect(await extractQueuedFile("f-queued", { skipClassification: false })).toBe("failed");

    const doc = await fileDoc("f-queued");
    expect(doc.extractionComplete).toBe(true);
    expect(doc.extractionError).toMatch(/Extraction Service.*401/);
    expect(doc.extractionError).not.toContain("s3cret-token");
  });
});

describe("#161: Gemini is the built-in Extraction Service", () => {
  it("records its provenance under the same contract", async () => {
    delete process.env.FIBUKI_EXTRACTION_SERVICE_URL;
    const fileData = await seedFile("f-gemini");
    gemini.queue.push(JSON.stringify({ isInvoice: true, confidence: 0.9 }));
    gemini.queue.push(JSON.stringify({ extracted: { amount: 700, confidence: 0.8 }, qrCodes: [RKSV] }));

    await runExtraction("f-gemini", fileData, {});

    expect(fake.requests).toHaveLength(0);
    const doc = await fileDoc("f-gemini");
    expect(doc.extractionProvider).toBe("gemini");
    expect(doc.extractionService).toEqual({ name: "gemini", version: MODELS.geminiLite });
    expect(doc.extractionContractVersion).toBe(EXTRACTION_CONTRACT_VERSION);
    expect((doc.extractedQrCodes as Array<{ decodedBy: string }>)[0].decodedBy).toBe("model");
  });

  it("records it on a not-an-invoice answer too", async () => {
    delete process.env.FIBUKI_EXTRACTION_SERVICE_URL;
    const fileData = await seedFile("f-gemini-not");
    gemini.queue.push(JSON.stringify({ isInvoice: false, reason: "Contract", confidence: 0.9 }));

    await runExtraction("f-gemini-not", fileData, {});

    const doc = await fileDoc("f-gemini-not");
    expect(doc.isNotInvoice).toBe(true);
    expect(doc.extractionProvider).toBe("gemini");
    expect(doc.extractionService).toEqual({ name: "gemini", version: MODELS.geminiLite });
  });
});
