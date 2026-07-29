/**
 * CHARACTERIZATION tests for the extraction pipeline's deterministic domain
 * logic (parsers + classifiers), written ahead of the platform rewrite.
 *
 * These tests pin CURRENT behavior exactly as implemented — including known
 * quirks and bugs (marked `// characterization: ...`). If any of these fail
 * after the port, the ported code CHANGED behavior; do not "fix" the test
 * without deciding the change is intentional.
 *
 * The AI/network boundary is stubbed:
 *  - `@google-cloud/vertexai` is mocked with a queue of canned responses
 *  - `@anthropic-ai/sdk` is mocked at the SDK boundary
 *  - `./visionApi` is mocked (Google Vision OCR)
 * Everything downstream of those boundaries is REAL application code.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";

// ---------------------------------------------------------------------------
// Model/network boundary mocks
// ---------------------------------------------------------------------------

const gemini = vi.hoisted(() => ({
  queue: [] as string[],
  requests: [] as Array<{ contents: Array<{ parts: Array<Record<string, any>> }> }>,
  usage: { promptTokenCount: 42, candidatesTokenCount: 7 } as Record<string, number>,
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
              usageMetadata: gemini.usage,
            },
          };
        },
      };
    }
  },
}));

const anthropic = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = { create: anthropic.create };
    constructor(_opts: unknown) {}
  },
}));

const vision = vi.hoisted(() => ({ callVisionAPI: vi.fn() }));
vi.mock("../visionApi", () => ({ callVisionAPI: vision.callVisionAPI }));

// REAL application code under test:
import { parseWithGemini, classifyDocument } from "../geminiParser";
import { parseWithClaude } from "../claudeParser";
import {
  extractDocument,
  getDefaultProvider,
  generateTextBlocks,
} from "../documentExtractor";
import { classifyDocumentByText, shouldUseTextClassification } from "../textClassifier";

const BUF = Buffer.from("fake-file-bytes");

/** Queue a Gemini response (object → JSON, string → verbatim). */
function q(response: Record<string, unknown> | string): void {
  gemini.queue.push(typeof response === "string" ? response : JSON.stringify(response));
}

beforeEach(() => {
  process.env.GCLOUD_PROJECT = "char-test-project";
  gemini.queue.length = 0;
  gemini.requests.length = 0;
});

afterEach(() => {
  delete process.env.EXTRACTION_PROVIDER;
});

// ===========================================================================
// geminiParser — parseWithGemini (AI-response parsing & normalization)
// ===========================================================================

describe("characterization: geminiParser.parseWithGemini", () => {
  it("strips markdown fences, maps usage, and defaults missing fields", async () => {
    q(
      "```json\n" +
        JSON.stringify({
          rawText: "RAW TEXT",
          extracted: { date: "2024-01-31", amount: 12345, currency: "EUR" },
        }) +
        "\n```",
    );

    const res = await parseWithGemini(BUF, "application/pdf");

    expect(res.rawText).toBe("RAW TEXT");
    expect(res.boundingBoxes).toEqual([]);
    expect(res.usage).toEqual({ inputTokens: 42, outputTokens: 7, model: "gemini-2.5-flash-lite" });
    expect(res.extracted).toEqual({
      date: "2024-01-31",
      amount: 12345,
      currency: "EUR",
      vatPercent: null,
      lineItems: null,
      partner: null,
      vatId: null,
      iban: null,
      address: null,
      website: null,
      confidence: 0.5, // characterization: missing confidence defaults to 0.5
      fieldSpans: {},
      issuer: null,
      recipient: null,
    });
    expect(res.extractedRaw).toEqual({
      date: null,
      amount: null,
      vatPercent: null,
      partner: null,
      vatId: null,
      iban: null,
      address: null,
      website: null,
      issuer: null,
      recipient: null,
    });
    expect(res.additionalFields).toEqual([]);
  });

  it("normalizes currency symbols; unknown/lowercase currencies collapse to EUR", async () => {
    const cases: Array<[string | null, string | null]> = [
      ["€", "EUR"],
      ["$", "USD"],
      ["£", "GBP"],
      ["¥", "JPY"],
      ["Fr.", "CHF"],
      ["CHF", "CHF"],
      ["USD", "USD"],
      // characterization: anything not a 3-uppercase-letter code and not in the
      // symbol map becomes "EUR" — even unrelated currencies:
      ["Kč", "EUR"],
      ["usd", "EUR"], // characterization: lowercase "usd" is NOT recognized → EUR
      [null, null],
    ];
    for (const [input, expected] of cases) {
      q({ extracted: { currency: input } });
      const res = await parseWithGemini(BUF, "application/pdf");
      expect(res.extracted.currency, `currency ${String(input)}`).toBe(expected);
    }
  });

  it("normalizes VAT ids (strip non-alphanumerics, uppercase) and websites (email/url → domain)", async () => {
    q({
      extracted: {
        issuer: {
          name: "V",
          vatId: "de 123-456.789",
          website: "https://www.Vendor.DE/contact?x=1#top",
        },
        recipient: { name: "R", vatId: "ATU 12.34.56 78", website: "billing@Sub.Client.COM" },
      },
    });
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.extracted.issuer).toEqual({
      name: "V",
      vatId: "DE123456789",
      address: null,
      iban: null,
      website: "vendor.de",
    });
    expect(res.extracted.recipient).toEqual({
      name: "R",
      vatId: "ATU12345678",
      address: null,
      iban: null,
      website: "sub.client.com",
    });

    // A "website" without a dot is rejected entirely
    q({ extracted: { issuer: { name: "X", website: "localhost" } } });
    const res2 = await parseWithGemini(BUF, "application/pdf");
    expect(res2.extracted.issuer?.website).toBeNull();
  });

  it("legacy flat fields are used only when no issuer entity exists; issuer wins otherwise", async () => {
    q({
      extracted: {
        partner: "Legacy Co",
        vatId: "at u 999",
        iban: "AT12",
        address: "Legacy Addr",
        website: "www.legacy.at/x",
      },
    });
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.extracted.partner).toBe("Legacy Co");
    expect(res.extracted.vatId).toBe("ATU999");
    expect(res.extracted.iban).toBe("AT12");
    expect(res.extracted.address).toBe("Legacy Addr");
    expect(res.extracted.website).toBe("legacy.at");

    q({
      extracted: {
        partner: "Legacy Co",
        vatId: "DE111",
        issuer: { name: "Issuer GmbH", vatId: "DE 222", iban: "DE-IBAN", address: "Iss Addr", website: "iss.de" },
      },
    });
    const res2 = await parseWithGemini(BUF, "application/pdf");
    expect(res2.extracted.partner).toBe("Issuer GmbH");
    expect(res2.extracted.vatId).toBe("DE222");
    expect(res2.extracted.iban).toBe("DE-IBAN");
    expect(res2.extracted.address).toBe("Iss Addr");
    expect(res2.extracted.website).toBe("iss.de");
  });

  it("top-level amount/vatPercent given as strings are DISCARDED (no coercion), unlike line items", async () => {
    // characterization: preserves current behavior — top-level fields use a
    // strict `typeof === "number"` check while line items coerce strings.
    q({ extracted: { amount: "12345", vatPercent: "19", confidence: "0.9" } });
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.extracted.amount).toBeNull();
    expect(res.extracted.vatPercent).toBeNull();
    expect(res.extracted.confidence).toBe(0.5);
  });

  it("line items coerce German comma decimals but DROP thousand-separator amounts", async () => {
    q({
      extracted: {
        lineItems: [
          { description: "A", amount: "123,45" },
          { description: "B", amount: "1.234,56" },
          { description: "C", amount: "1,234" },
          { description: "", amount: 500 },
        ],
      },
    });
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.extracted.lineItems).toEqual([
      // characterization: "123,45" (cents string) → 123.45 → rounds to 123 cents
      { description: "A", quantity: null, unitPrice: null, vatPercent: null, vatAmount: 0, amount: 123 },
      // characterization: "1.234,56" → "1.234.56" → NaN → the whole item is dropped
      // characterization: "1,234" (German thousands) parses as 1.234 → 1 cent
      { description: "C", quantity: null, unitPrice: null, vatPercent: null, vatAmount: 0, amount: 1 },
      // characterization: empty description falls back to "Item N" using the
      // ORIGINAL index (4th input item), even though item B was dropped
      { description: "Item 4", quantity: null, unitPrice: null, vatPercent: null, vatAmount: 0, amount: 500 },
    ]);
  });

  it("derives missing vatAmount from gross amount and infers unit price (gross interpretation)", async () => {
    q({ extracted: { lineItems: [{ description: "Cable", quantity: 2, amount: 1200, vatPercent: 20 }] } });
    const res = await parseWithGemini(BUF, "application/pdf");
    // vatAmount = round(1200 * 20 / 120) = 200; net = 1000; unitPrice = 500
    expect(res.extracted.lineItems).toEqual([
      { description: "Cable", quantity: 2, unitPrice: 500, vatPercent: 20, vatAmount: 200, amount: 1200 },
    ]);
  });

  it("infers unit price from net amount when vatAmount indicates the amount is net", async () => {
    q({
      extracted: {
        lineItems: [{ description: "Hours", quantity: 4, amount: 1000, vatPercent: 20, vatAmount: 200 }],
      },
    });
    const res = await parseWithGemini(BUF, "application/pdf");
    // 200 == round(1000*20/100) → amount looks NET → unitPrice = 1000/4 = 250
    expect(res.extracted.lineItems).toEqual([
      { description: "Hours", quantity: 4, unitPrice: 250, vatPercent: 20, vatAmount: 200, amount: 1000 },
    ]);
  });

  it("out-of-range vatPercent becomes null and vatAmount defaults to 0", async () => {
    q({ extracted: { lineItems: [{ description: "X", amount: 999, vatPercent: 150 }] } });
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.extracted.lineItems).toEqual([
      { description: "X", quantity: null, unitPrice: null, vatPercent: null, vatAmount: 0, amount: 999 },
    ]);
  });

  it("accepts lineItems at the response top level as a fallback", async () => {
    q({ rawText: "", lineItems: [{ description: "top", amount: 100 }] });
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.extracted.lineItems).toEqual([
      { description: "top", quantity: null, unitPrice: null, vatPercent: null, vatAmount: 0, amount: 100 },
    ]);
  });

  it("repairs trailing commas in malformed JSON", async () => {
    q('{"extracted": {"amount": 500,}}');
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.extracted.amount).toBe(500);
  });

  it("repairs truncated JSON by closing unclosed braces", async () => {
    q('{"extracted": {"amount": 777, "confidence": 0.9');
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.extracted.amount).toBe(777);
    expect(res.extracted.confidence).toBe(0.9);
  });

  it("rejects when no JSON object can be found or repaired", async () => {
    q("totally not json");
    await expect(parseWithGemini(BUF, "application/pdf")).rejects.toThrow(
      /Could not extract JSON from response/,
    );

    q('{"a": <<<}');
    await expect(parseWithGemini(BUF, "application/pdf")).rejects.toThrow(
      /JSON parse failed even after repair/,
    );
  });

  it("extractedRaw prefers issuer_raw over legacy *_raw fields", async () => {
    q({
      extracted: {
        date_raw: "15.12.2024",
        amount_raw: "123,45 €",
        vatPercent_raw: "19%",
        partner_raw: "Legacy Raw",
        vatId_raw: "Legacy VAT",
        issuer_raw: { name: "Issuer Raw GmbH", vatId: "DE 123 456 789", iban: "DE89 3704" },
        recipient_raw: { name: "Recipient Raw" },
      },
    });
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.extractedRaw).toEqual({
      date: "15.12.2024",
      amount: "123,45 €",
      vatPercent: "19%",
      partner: "Issuer Raw GmbH", // issuer_raw.name wins over partner_raw
      vatId: "DE 123 456 789",
      iban: "DE89 3704",
      address: null,
      website: null,
      issuer: { name: "Issuer Raw GmbH", vatId: "DE 123 456 789", address: null, iban: "DE89 3704", website: null },
      recipient: { name: "Recipient Raw", vatId: null, address: null, iban: null, website: null },
    });
  });

  it("filters additionalFields missing label or value; rawValue falls back to value", async () => {
    q({
      extracted: {},
      additionalFields: [
        { label: "Invoice Number", value: "INV-1", rawValue: "No. INV-1" },
        { label: "", value: "dropped" },
        { label: "no-value" },
        { label: "Due Date", value: "2025-01-01" },
      ],
    });
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.additionalFields).toEqual([
      { label: "Invoice Number", value: "INV-1", rawValue: "No. INV-1" },
      { label: "Due Date", value: "2025-01-01", rawValue: "2025-01-01" },
    ]);
  });

  it("throws when no Google Cloud project id is configured", async () => {
    const saved = {
      a: process.env.GCLOUD_PROJECT,
      b: process.env.GCP_PROJECT,
      c: process.env.GOOGLE_CLOUD_PROJECT,
    };
    delete process.env.GCLOUD_PROJECT;
    delete process.env.GCP_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    try {
      await expect(parseWithGemini(BUF, "application/pdf")).rejects.toThrow(
        "Could not determine Google Cloud project ID",
      );
    } finally {
      if (saved.a !== undefined) process.env.GCLOUD_PROJECT = saved.a;
      if (saved.b !== undefined) process.env.GCP_PROJECT = saved.b;
      if (saved.c !== undefined) process.env.GOOGLE_CLOUD_PROJECT = saved.c;
    }
  });
});

// ===========================================================================
// geminiParser — classifyDocument
// ===========================================================================

describe("characterization: geminiParser.classifyDocument", () => {
  it("parses a well-formed classification and keeps the reason even for invoices", async () => {
    q({ isInvoice: true, confidence: 0.92, reason: "looks fine" });
    const res = await classifyDocument(BUF, "image/jpeg");
    expect(res.isInvoice).toBe(true);
    // characterization: reason is passed through even when it IS an invoice
    expect(res.reason).toBe("looks fine");
    expect(res.confidence).toBe(0.92);
    expect(res.usage).toEqual({ inputTokens: 42, outputTokens: 7, model: "gemini-2.5-flash-lite" });
  });

  it('treats the string "true" as NOT an invoice (strict === true check)', async () => {
    // characterization: preserves current behavior — only boolean true counts
    q({ isInvoice: "true", confidence: 0.8 });
    const res = await classifyDocument(BUF, "image/jpeg");
    expect(res.isInvoice).toBe(false);
    expect(res.reason).toBeNull();
  });

  it("fails OPEN: unparseable classification defaults to invoice with 0.5 confidence", async () => {
    q("INVOICE — definitely");
    const res = await classifyDocument(BUF, "image/jpeg");
    expect(res).toEqual({
      isInvoice: true,
      reason: null,
      confidence: 0.5,
      usage: { inputTokens: 42, outputTokens: 7, model: "gemini-2.5-flash-lite" },
    });
  });

  it("non-numeric confidence falls back to 0.5", async () => {
    q({ isInvoice: false, reason: "spam", confidence: "high" });
    const res = await classifyDocument(BUF, "image/jpeg");
    expect(res.isInvoice).toBe(false);
    expect(res.reason).toBe("spam");
    expect(res.confidence).toBe(0.5);
  });

  it("sends unknown file types to the model as image/jpeg, images as-is", async () => {
    q({ isInvoice: true, confidence: 1 });
    await classifyDocument(BUF, "text/plain");
    // characterization: any non-PDF, non-image/* type is labeled image/jpeg
    expect(gemini.requests[0].contents[0].parts[0].inlineData.mimeType).toBe("image/jpeg");

    q({ isInvoice: true, confidence: 1 });
    await classifyDocument(BUF, "image/png");
    expect(gemini.requests[1].contents[0].parts[0].inlineData.mimeType).toBe("image/png");
  });

  it("classifies PDFs >2 pages using only the first page; ≤2 pages sent unchanged", async () => {
    const threePager = await makePdf(["Page one text"], 3);
    q({ isInvoice: true, confidence: 1 });
    await classifyDocument(threePager, "application/pdf");
    const sent = Buffer.from(
      gemini.requests[0].contents[0].parts[0].inlineData.data as string,
      "base64",
    );
    expect((await PDFDocument.load(sent)).getPageCount()).toBe(1);

    const twoPager = await makePdf(["Page one text"], 2);
    q({ isInvoice: true, confidence: 1 });
    await classifyDocument(twoPager, "application/pdf");
    const sent2 = Buffer.from(
      gemini.requests[1].contents[0].parts[0].inlineData.data as string,
      "base64",
    );
    expect(sent2.equals(twoPager)).toBe(true);
  });

  it("falls back to the original buffer when first-page extraction fails", async () => {
    const invalid = Buffer.from("not really a pdf");
    q({ isInvoice: true, confidence: 1 });
    await classifyDocument(invalid, "application/pdf");
    const sent = Buffer.from(
      gemini.requests[0].contents[0].parts[0].inlineData.data as string,
      "base64",
    );
    expect(sent.equals(invalid)).toBe(true);
  });
});

// ===========================================================================
// claudeParser — parseWithClaude (legacy vision-claude path)
// ===========================================================================

describe("characterization: claudeParser.parseWithClaude", () => {
  it("maps a fenced JSON response into ExtractedData with legacy nulls", async () => {
    anthropic.create.mockResolvedValue({
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [
        {
          type: "text",
          text:
            "```json\n" +
            JSON.stringify({
              date: "2024-02-01",
              amount: 9999,
              currency: "EUR",
              vatPercent: 20,
              partner: "ACME GmbH",
              vatId: "ATU12345678",
              iban: "AT123456789012345678",
              address: "Musterstraße 123, 1010 Wien",
              confidence: 0.92,
              fieldSpans: { date: "01.02.2024", amount: "99,99 €" },
            }) +
            "\n```",
        },
      ],
    });

    const res = await parseWithClaude("OCR TEXT", "test-key");
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5, model: "claude-3-haiku-20240307" });
    expect(res.extracted).toEqual({
      date: "2024-02-01",
      amount: 9999,
      currency: "EUR",
      vatPercent: 20,
      lineItems: null, // characterization: legacy parser never extracts line items
      partner: "ACME GmbH",
      vatId: "ATU12345678",
      iban: "AT123456789012345678",
      address: "Musterstraße 123, 1010 Wien",
      website: null, // characterization: legacy parser never extracts website
      confidence: 0.92,
      fieldSpans: { date: "01.02.2024", amount: "99,99 €" },
      issuer: null, // characterization: legacy parser never extracts entities
      recipient: null,
    });
  });

  it("discards string amounts/vatPercent and defaults confidence/fieldSpans", async () => {
    anthropic.create.mockResolvedValue({
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "text", text: JSON.stringify({ amount: "9999", vatPercent: "20" }) }],
    });
    const res = await parseWithClaude("OCR", "k");
    // characterization: strict typeof number check — numeric strings dropped
    expect(res.extracted.amount).toBeNull();
    expect(res.extracted.vatPercent).toBeNull();
    expect(res.extracted.confidence).toBe(0.5);
    expect(res.extracted.fieldSpans).toEqual({});
    expect(res.extracted.date).toBeNull();
    expect(res.extracted.partner).toBeNull();
  });

  it("throws when the response contains no text block", async () => {
    anthropic.create.mockResolvedValue({
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", id: "x", name: "n", input: {} }],
    });
    await expect(parseWithClaude("OCR", "k")).rejects.toThrow("No text response from Claude");
  });

  it("propagates a raw SyntaxError on invalid JSON (no repair attempt, unlike Gemini)", async () => {
    anthropic.create.mockResolvedValue({
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "text", text: "not json at all" }],
    });
    // characterization: preserves current behavior — no JSON-repair fallback here
    await expect(parseWithClaude("OCR", "k")).rejects.toThrow(SyntaxError);
  });
});

// ===========================================================================
// documentExtractor — provider selection, fallback chains, result shaping
// ===========================================================================

describe("characterization: documentExtractor", () => {
  it("getDefaultProvider: env override honored, anything else falls back to gemini", () => {
    delete process.env.EXTRACTION_PROVIDER;
    expect(getDefaultProvider()).toBe("gemini");
    process.env.EXTRACTION_PROVIDER = "vision-claude";
    expect(getDefaultProvider()).toBe("vision-claude");
    process.env.EXTRACTION_PROVIDER = "gemini";
    expect(getDefaultProvider()).toBe("gemini");
    process.env.EXTRACTION_PROVIDER = "something-else";
    expect(getDefaultProvider()).toBe("gemini");
  });

  it("generateTextBlocks splits on newlines, trims, and fakes full-confidence blocks", () => {
    expect(generateTextBlocks("  Line one \n\n\nLine two\n   \n")).toEqual([
      { text: "Line one", boundingBox: { vertices: [] }, confidence: 1.0 },
      { text: "Line two", boundingBox: { vertices: [] }, confidence: 1.0 },
    ]);
  });

  it("gemini: not-an-invoice classification short-circuits without an extraction call", async () => {
    q({ isInvoice: false, reason: "Tax form", confidence: 0.66 });
    const res = await extractDocument(BUF, "image/jpeg", { provider: "gemini" });

    expect(gemini.requests).toHaveLength(1); // classification only
    expect(res.provider).toBe("gemini");
    expect(res.isNotInvoice).toBe(true);
    expect(res.notInvoiceReason).toBe("Tax form");
    expect(res.text).toBe("(classification only - not an invoice)");
    expect(res.blocks).toEqual([]);
    expect(res.extracted).toEqual({
      date: null,
      amount: null,
      currency: null,
      vatPercent: null,
      lineItems: null,
      partner: null,
      vatId: null,
      iban: null,
      address: null,
      website: null,
      issuer: null,
      recipient: null,
      confidence: 0.66, // classification confidence is passed through
      fieldSpans: {},
    });
  });

  it("gemini: skipClassification goes straight to extraction (single API call)", async () => {
    q({ rawText: "Hello invoice", extracted: { amount: 100, confidence: 0.9 } });
    const res = await extractDocument(BUF, "image/jpeg", {
      provider: "gemini",
      skipClassification: true,
    });
    expect(gemini.requests).toHaveLength(1);
    expect(res.isNotInvoice).toBe(false);
    expect(res.notInvoiceReason).toBeNull();
    expect(res.text).toBe("Hello invoice");
    expect(res.blocks).toEqual([]);
    expect(res.usage).toEqual({ inputTokens: 42, outputTokens: 7, model: "gemini-2.5-flash-lite" });
  });

  it("gemini: missing rawText is replaced by generated display text with comma-decimal amount", async () => {
    q({
      extracted: {
        partner: "Acme GmbH",
        date: "2024-01-31",
        amount: 123456,
        vatId: "ATU1",
        iban: "AT11",
        address: "Addr 1",
        confidence: 0.9,
      },
    });
    const res = await extractDocument(BUF, "image/jpeg", {
      provider: "gemini",
      skipClassification: true,
    });
    // characterization: fallback text joins fields; amount formatted "1234,56 EUR"
    // (currency defaults to EUR in the display string when null)
    expect(res.text).toBe("Acme GmbH\n2024-01-31\n1234,56 EUR\nAddr 1\nATU1\nAT11");
  });

  it("gemini: a fully empty extraction does NOT throw — text becomes '(no text extracted)'", async () => {
    // characterization: preserves current behavior — the hasUsefulData guard can
    // never fire because the fallback text is always non-empty, so the
    // "No text or data extracted from document" error path is dead code.
    q("{}");
    const res = await extractDocument(BUF, "image/jpeg", {
      provider: "gemini",
      skipClassification: true,
    });
    expect(res.text).toBe("(no text extracted)");
    expect(res.extracted.amount).toBeNull();
    expect(res.extracted.partner).toBeNull();
  });

  it("vision-claude: missing Anthropic API key throws before any OCR", async () => {
    await expect(
      extractDocument(BUF, "application/pdf", { provider: "vision-claude" }),
    ).rejects.toThrow("Anthropic API key required for vision-claude provider");
  });

  it("vision-claude: OCR text + Claude parse are stitched into the result", async () => {
    const blocks = [{ text: "b1", boundingBox: { vertices: [] }, confidence: 0.7 }];
    vision.callVisionAPI.mockResolvedValue({ text: "OCR FULL TEXT", blocks });
    anthropic.create.mockResolvedValue({
      usage: { input_tokens: 3, output_tokens: 4 },
      content: [{ type: "text", text: JSON.stringify({ amount: 5000, confidence: 0.8 }) }],
    });

    const res = await extractDocument(BUF, "application/pdf", {
      provider: "vision-claude",
      anthropicApiKey: "key",
    });
    expect(res.provider).toBe("vision-claude");
    expect(res.text).toBe("OCR FULL TEXT");
    expect(res.blocks).toBe(blocks);
    expect(res.extracted.amount).toBe(5000);
    expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 4, model: "claude-3-haiku-20240307" });
    // vision-claude never sets classification flags
    expect(res.isNotInvoice).toBeUndefined();
  });

  it("vision-claude: whitespace-only OCR text fails loudly", async () => {
    vision.callVisionAPI.mockResolvedValue({ text: "   ", blocks: [] });
    await expect(
      extractDocument(BUF, "application/pdf", { provider: "vision-claude", anthropicApiKey: "key" }),
    ).rejects.toThrow("No text extracted from document");
  });
});

// ===========================================================================
// textClassifier — regex-based pre-classification
// ===========================================================================
//
// NOTE: the classifier's hasMatch() uses `.test()` on module-level /g/ regexes,
// which is STATEFUL across calls (lastIndex carries over). The tests below are
// therefore order-dependent by design and pin that statefulness explicitly.

async function makePdf(lines: string[], pages = 1): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([595, 842]);
    if (p === 0) {
      lines.forEach((line, i) => page.drawText(line, { x: 50, y: 800 - i * 20, size: 12, font }));
    } else {
      page.drawText(`Page ${p + 1}`, { x: 50, y: 800, size: 12, font });
    }
  }
  return Buffer.from(await doc.save());
}

describe("characterization: textClassifier", () => {
  it("non-PDF files are uncertain and default to invoice", async () => {
    const res = await classifyDocumentByText(Buffer.from("x"), "image/png");
    expect(res.isLikelyInvoice).toBe(true);
    expect(res.confidence).toBe("uncertain");
    expect(res.signals).toEqual(["Not a PDF, cannot extract text"]);
    expect(res.hasExtractableText).toBe(false);
  });

  it("unparseable PDF bytes are uncertain (no extractable text)", async () => {
    const res = await classifyDocumentByText(Buffer.from("not a pdf"), "application/pdf");
    expect(res.isLikelyInvoice).toBe(true);
    expect(res.confidence).toBe("uncertain");
    expect(res.signals).toEqual(["No extractable text (possibly scanned/image-only)"]);
    expect(res.hasExtractableText).toBe(false);
  });

  it("PDFs with fewer than ~50 chars of text count as having NO text", async () => {
    // characterization: preserves current behavior — short receipts fall through
    // to the expensive classifier because of the >50-char threshold
    const res = await classifyDocumentByText(await makePdf(["Hi"]), "application/pdf");
    expect(res.hasExtractableText).toBe(false);
    expect(res.confidence).toBe("uncertain");
  });

  it("an invoice-looking PDF scores high-confidence invoice", async () => {
    const pdf = await makePdf([
      "Invoice INV-2024-001 for services",
      "Total: 999.00 USD plus 19% VAT",
      "Payment via bank transfer",
    ]);
    const res = await classifyDocumentByText(pdf, "application/pdf");
    expect(res.isLikelyInvoice).toBe(true);
    expect(res.confidence).toBe("high");
    expect(res.hasExtractableText).toBe(true);
    expect(res.signals).toEqual(["Currency: 1", "VAT: 2", "Amounts: 2", "Keywords: 1"]);
    expect(shouldUseTextClassification(res)).toBe(true);
  });

  it("a contract-looking PDF scores high-confidence NOT invoice", async () => {
    const pdf = await makePdf([
      "Vertrag ueber Beratungsleistungen zwischen den Parteien.",
      "Diese AGB regeln die Zusammenarbeit.",
      "Der Kontoauszug wird separat versendet.",
    ]);
    const res = await classifyDocumentByText(pdf, "application/pdf");
    expect(res.isLikelyInvoice).toBe(false);
    expect(res.confidence).toBe("high");
    expect(res.signals).toEqual(["Non-invoice keywords: 3"]);
    expect(shouldUseTextClassification(res)).toBe(true);
  });

  it("QUIRK: IBAN detection alternates across calls (stateful /g/ regex, no count reset)", async () => {
    // characterization: preserves current behavior — hasMatch() calls .test()
    // on shared module-level /g/ regexes. For currency/VAT/amount/keyword
    // families, the subsequent countMatches() (String.match with /g/) resets
    // lastIndex, hiding the statefulness. IBAN_PATTERNS never goes through
    // countMatches, so its lastIndex carries over between documents:
    // a lowercase IBAN matches only the /i-flagged prefix pattern, which is
    // left mid-string after a hit and misses the IBAN on the NEXT call.
    const pdf = await makePdf([
      "Rechnung fuer die Beratung",
      "iban: at611904300234573201",
    ]);

    const first = await classifyDocumentByText(pdf, "application/pdf");
    expect(first.isLikelyInvoice).toBe(true);
    expect(first.confidence).toBe("high"); // keywords(3) + iban(1) = 4
    expect(first.signals).toEqual(["Keywords: 1", "Has IBAN"]);

    const second = await classifyDocumentByText(pdf, "application/pdf");
    expect(second.isLikelyInvoice).toBe(true);
    expect(second.confidence).toBe("medium"); // IBAN signal silently lost → 3
    expect(second.signals).toEqual(["Keywords: 1"]);
    expect(shouldUseTextClassification(second)).toBe(false);

    const third = await classifyDocumentByText(pdf, "application/pdf");
    expect(third.confidence).toBe("high"); // …and found again on the third call
    expect(third.signals).toEqual(["Keywords: 1", "Has IBAN"]);
  });

  it("shouldUseTextClassification requires high confidence AND extractable text", () => {
    const base = { isLikelyInvoice: true, signals: [], processingTimeMs: 0 };
    expect(
      shouldUseTextClassification({ ...base, confidence: "high", hasExtractableText: true }),
    ).toBe(true);
    expect(
      shouldUseTextClassification({ ...base, confidence: "high", hasExtractableText: false }),
    ).toBe(false);
    expect(
      shouldUseTextClassification({ ...base, confidence: "medium", hasExtractableText: true }),
    ).toBe(false);
  });
});
