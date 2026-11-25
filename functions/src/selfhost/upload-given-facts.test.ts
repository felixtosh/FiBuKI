/**
 * Upload with given facts (#795, spec #800): an importer uploads a File
 * together with what it already knows (date, amount, currency, Partner, VAT).
 * Those facts are stored as given, as hand-given facts, and the Extraction
 * that follows fills only the fields left empty. The File-facts correction,
 * and with it `update_file_extraction`, gains currency.
 *
 * Driven through the MCP tool handlers (`handleTool`) against the self-host
 * in-memory database. The model is the only boundary swapped: a queue of
 * canned Gemini replies, as in extraction-characterization.test.ts.
 *
 *   npx vitest run --config vitest.selfhost.config.ts src/selfhost/upload-given-facts.test.ts --pool=forks --maxWorkers=1
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";
import { onDocumentCreated } from "firebase-functions/v2/firestore";

const gemini = vi.hoisted(() => ({ queue: [] as string[], requests: [] as unknown[] }));

vi.mock("@google-cloud/vertexai", () => ({
  VertexAI: class {
    getGenerativeModel() {
      return {
        generateContent: async (req: unknown) => {
          gemini.requests.push(req);
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
import { handleTool } from "../tools/handlers";
import { drainExtractionQueue } from "./extraction-worker";
import { agentCaller } from "../tools/caller";

const db = getFirestore();
const USER = "given-facts-user";
const OTHER = "given-facts-other";

/** The File as the creation trigger first sees it, by id. */
const created = new Map<string, Record<string, unknown>>();

const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));
const PDF = Buffer.from("%PDF-1.4 given facts").toString("base64");

function upload(args: Record<string, unknown> = {}) {
  return handleTool(USER, "upload_file", {
    fileName: "beleg.pdf",
    mimeType: "application/pdf",
    base64: PDF,
    ...args,
  }) as Promise<{ fileId: string; duplicate: boolean }>;
}

async function file(id: string): Promise<Record<string, unknown>> {
  return (await db.collection("files").doc(id).get()).data()!;
}

/** What the model reads off the document: a classification, then the extraction. */
function modelReads(extracted: Record<string, unknown>) {
  gemini.queue.push(JSON.stringify({ isInvoice: true, confidence: 0.95 }));
  gemini.queue.push(JSON.stringify({ rawText: "Rechnung", extracted }));
}

/** The upload's Extraction, run as the worker would. */
async function extract() {
  await drainTriggers();
  await drainExtractionQueue();
  await drainTriggers();
}

beforeAll(async () => {
  process.env.GCLOUD_PROJECT = "given-facts-project";
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  delete process.env.GEMINI_MODEL;
  await import("../extraction/extractFileData");
  await import("../matching/matchFilePartner");
  onDocumentCreated({ document: "files/{fileId}" }, async (event: any) => {
    created.set(event.params.fileId, event.data?.data() ?? {});
  });
});

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
  gemini.queue.length = 0;
  gemini.requests.length = 0;
});

describe("upload_file with given facts", () => {
  it("stores the given facts as hand-given facts on an unconnected File", async () => {
    const { fileId } = await upload({
      date: "2021-03-15",
      amount: 12000,
      currency: "EUR",
      vatAmount: 2000,
      vatPercent: 20,
    });

    const stored = await file(fileId);
    expect(stored.extractedDate).toEqual(day("2021-03-15"));
    expect(stored.extractedAmount).toBe(12000);
    expect(stored.extractedCurrency).toBe("EUR");
    expect(stored.extractedVatAmount).toBe(2000);
    expect(stored.extractedVatPercent).toBe(20);
    expect(Object.keys(stored.extractionCorrectedFields as object).sort()).toEqual(
      ["amount", "currency", "date", "vatAmount", "vatPercent"]
    );
    expect(stored.transactionIds).toEqual([]);
  });

  it("keeps every given fact through the Extraction, which fills only the empty fields", async () => {
    const { fileId } = await upload({ date: "2021-03-15", amount: 12000, currency: "EUR", vatPercent: 20 });
    modelReads({
      date: "2021-04-01",
      amount: 9900,
      currency: "USD",
      vatPercent: 10,
      lineItems: [{ description: "Beratung", vatPercent: 10, vatAmount: 900, amount: 9900 }],
      confidence: 0.9,
      issuer: { name: "Alter Lieferant GmbH", vatId: "ATU11111111" },
    });

    await extract();

    const stored = await file(fileId);
    expect(gemini.requests.length).toBeGreaterThan(0);
    expect(stored.extractionComplete).toBe(true);
    expect(stored.extractionError ?? null).toBeNull();
    // given, unchanged
    expect(stored.extractedDate).toEqual(day("2021-03-15"));
    expect(stored.extractedAmount).toBe(12000);
    expect(stored.extractedCurrency).toBe("EUR");
    expect(stored.extractedVatPercent).toBe(20);
    // empty, filled
    expect(stored.extractedLineItems).toHaveLength(1);
    expect(stored.extractedPartner).toBe("Alter Lieferant GmbH");
    expect(stored.extractedVatId).toBe("ATU11111111");
    // the given facts stay recorded, so a later re-extraction is refused
    expect(Object.keys(stored.extractionCorrectedFields as object).sort()).toEqual(
      ["amount", "currency", "date", "vatPercent"]
    );
  });

  it("once read, the given facts are a Hand Correction: a re-extraction is refused", async () => {
    const { fileId } = await upload({ amount: 12000, currency: "EUR" });
    modelReads({ amount: 9900, currency: "EUR", confidence: 0.9 });
    await extract();

    await expect(handleTool(USER, "retry_file_extraction", { fileId, force: true })).rejects.toThrow(
      /hand corrections.*amount/
    );
    expect((await file(fileId)).extractedAmount).toBe(12000);
  });

  it("a reading that calls the document no invoice does not clear the given facts", async () => {
    const { fileId } = await upload({ date: "2021-03-15", amount: 12000, currency: "EUR" });
    gemini.queue.push(JSON.stringify({ isInvoice: false, reason: "Looks like a letter", confidence: 0.7 }));

    await extract();

    const stored = await file(fileId);
    expect(stored.extractionComplete).toBe(true);
    expect(stored.isNotInvoice ?? false).toBe(false);
    expect(stored.extractedAmount).toBe(12000);
    expect(stored.extractedDate).toEqual(day("2021-03-15"));
  });

  it("keeps a USD File's own amount and currency", async () => {
    const { fileId } = await upload({ date: "2021-06-02", amount: 4999, currency: "usd" });
    modelReads({ date: "2021-06-02", amount: 4600, currency: "EUR", confidence: 0.9 });

    await extract();

    const stored = await file(fileId);
    expect(stored.extractedAmount).toBe(4999);
    expect(stored.extractedCurrency).toBe("USD");
  });
});

describe("upload_file without given facts", () => {
  it("behaves as before: no Hand Correction, the Extraction writes what it reads", async () => {
    const result = (await upload()) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(["duplicate", "fileId", "fileName", "fileSize", "storagePath", "success"]);
    const fileId = result.fileId as string;
    const before = await file(fileId);
    expect(before.extractionCorrectedFields).toBeUndefined();
    expect(before.lastFactChange).toBeUndefined();
    expect(before.extractedAmount).toBeUndefined();

    modelReads({ date: "2025-05-05", amount: 2500, currency: "EUR", vatPercent: 20, confidence: 0.9 });
    await extract();

    const stored = await file(fileId);
    expect(stored.extractedDate).toEqual(day("2025-05-05"));
    expect(stored.extractedAmount).toBe(2500);
    expect(stored.extractedVatPercent).toBe(20);
    expect(stored.extractionCorrectedFields).toBeUndefined();
    expect(stored.transactionIds).toEqual([]);
  });

  it("a byte-identical re-upload with given facts leaves the File on record as it is", async () => {
    const first = await upload();
    const again = (await upload({ amount: 777, currency: "EUR" })) as Record<string, unknown>;
    expect(again).toMatchObject({ fileId: first.fileId, duplicate: true, givenFactsIgnored: true });
    expect(again.givenFacts).toBeUndefined();
    expect((await file(first.fileId)).extractedAmount).toBeUndefined();
  });

  it("refuses a given fact the correction refuses, and stores no File", async () => {
    await expect(upload({ amount: "120,00" })).rejects.toThrow(/amount must be a whole number of cents/);
    await expect(upload({ date: "15.03.2021" })).rejects.toThrow(/YYYY-MM-DD/);
    expect((await db.collection("files").where("userId", "==", USER).get()).size).toBe(0);
  });
});

describe("upload_file with a given Partner", () => {
  it("assigns the Partner by hand, and Partner matching leaves it", async () => {
    const { partnerId } = (await handleTool(USER, "create_partner", { name: "Altes Büro KG" })) as {
      partnerId: string;
    };
    const { fileId } = await upload({ partnerId, amount: 3000, currency: "EUR" });
    modelReads({ amount: 3000, currency: "EUR", confidence: 0.9, issuer: { name: "Ganz Anders GmbH" } });

    await extract();

    const stored = await file(fileId);
    expect(stored.partnerId).toBe(partnerId);
    expect(stored.partnerMatchedBy).toBe("manual");
    expect(stored.partnerMatchComplete).toBe(true);
    expect(stored.extractedPartner).toBe("Ganz Anders GmbH");
  });

  it("refuses a Partner that is not the User's, or is deleted, and stores no File", async () => {
    const { partnerId: theirs } = (await handleTool(OTHER, "create_partner", { name: "Fremd GmbH" })) as {
      partnerId: string;
    };
    await expect(upload({ partnerId: theirs })).rejects.toThrow(/Partner not found/);
    await expect(upload({ partnerId: "no-such-partner" })).rejects.toThrow(/Partner not found/);

    const { partnerId: gone } = (await handleTool(USER, "create_partner", { name: "Weg KG" })) as {
      partnerId: string;
    };
    await db.collection("partners").doc(gone).update({ isActive: false });
    await expect(upload({ partnerId: gone })).rejects.toThrow(/Partner not found/);

    expect((await db.collection("files").where("userId", "==", USER).get()).size).toBe(0);
  });

  it("an agent's given Partner is recorded as the agent's, as assign_partner_to_file does", async () => {
    const { partnerId } = (await handleTool(USER, "create_partner", { name: "Agentur OG" })) as {
      partnerId: string;
    };
    const { fileId } = (await handleTool(
      USER,
      "upload_file",
      { fileName: "a.pdf", mimeType: "application/pdf", base64: PDF, partnerId },
      agentCaller()
    )) as { fileId: string };
    expect((await file(fileId)).partnerMatchedBy).toBe("ai");
  });
});

describe("update_file_extraction and currency", () => {
  it("corrects a File's currency and records it as a Hand Correction", async () => {
    const { fileId } = await upload();
    modelReads({ date: "2025-02-03", amount: 1500, currency: "EUR", confidence: 0.9 });
    await extract();
    expect((await file(fileId)).extractedCurrency).toBe("EUR");

    const result = (await handleTool(USER, "update_file_extraction", { fileId, currency: "$" })) as {
      changed: string[];
      file: Record<string, unknown>;
    };

    expect(result.changed).toEqual(["currency"]);
    expect(result.file.extractedCurrency).toBe("USD");
    const stored = await file(fileId);
    expect(stored.extractedCurrency).toBe("USD");
    expect(stored.extractedAmount).toBe(1500);
    expect(Object.keys(stored.extractionCorrectedFields as object)).toEqual(["currency"]);
  });

  it("refuses a currency that is no ISO code", async () => {
    const { fileId } = await upload();
    await expect(handleTool(USER, "update_file_extraction", { fileId, currency: "dollars" })).rejects.toThrow(
      /three-letter ISO 4217 code/
    );
  });
});

describe("given facts are part of the File from its creation", () => {
  it("the record the creation trigger sees already holds them", async () => {
    const { partnerId } = (await handleTool(USER, "create_partner", { name: "Sofort GmbH" })) as {
      partnerId: string;
    };
    const { fileId } = await upload({ amount: 5000, currency: "EUR", date: "2021-01-04", partnerId });
    await drainTriggers();

    const first = created.get(fileId)!;
    expect(first.extractedAmount).toBe(5000);
    expect(first.extractedCurrency).toBe("EUR");
    expect(Object.keys(first.extractionCorrectedFields as object).sort()).toEqual(["amount", "currency", "date"]);
    expect(first.partnerId).toBe(partnerId);
    expect(first.partnerMatchedBy).toBe("manual");
  });

  it("a correction between upload and extraction still lets the Extraction fill around them", async () => {
    const { fileId } = await upload({ amount: 12000, currency: "EUR" });
    await handleTool(USER, "update_file_extraction", { fileId, invoiceDirection: "incoming" });
    modelReads({ date: "2021-04-01", amount: 9900, currency: "USD", confidence: 0.9, issuer: { name: "Füll GmbH" } });

    await extract();

    const stored = await file(fileId);
    expect(gemini.requests.length).toBeGreaterThan(0);
    expect(stored.extractedAmount).toBe(12000);
    expect(stored.extractedCurrency).toBe("EUR");
    expect(stored.invoiceDirection).toBe("incoming");
    expect(stored.extractedDate).toEqual(day("2021-04-01"));
    expect(stored.extractedPartner).toBe("Füll GmbH");
  });
});

describe("given facts that cannot be right are refused, and no File is stored", () => {
  it.each([
    ["a fractional amount", { amount: 120.5, currency: "EUR" }, /whole number of cents/],
    ["a fractional VAT amount", { amount: 12000, vatAmount: 0.5, currency: "EUR" }, /whole number of cents/],
    ["an amount without its currency", { amount: 12000 }, /currency/],
    ["a VAT amount without the amount", { vatAmount: 2000, currency: "EUR" }, /vatAmount needs amount/],
    ["more VAT than the total", { amount: 1000, vatAmount: 2000, currency: "EUR" }, /larger than the amount/],
    ["VAT against the total's sign", { amount: -12000, vatAmount: 2000, currency: "EUR" }, /sign/],
    ["a code that is no currency", { amount: 12000, currency: "ABC" }, /ISO 4217/],
  ])("%s", async (_label, args, message) => {
    await expect(upload(args)).rejects.toThrow(message);
    expect((await db.collection("files").where("userId", "==", USER).get()).size).toBe(0);
  });

  it("a credit note's negative VAT with its negative total is fine", async () => {
    const { fileId } = await upload({ amount: -12000, vatAmount: -2000, currency: "EUR" });
    expect((await file(fileId)).extractedVatAmount).toBe(-2000);
  });
});

