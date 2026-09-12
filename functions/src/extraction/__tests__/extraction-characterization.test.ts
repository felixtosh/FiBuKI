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
 * Everything downstream of that boundary is REAL application code.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
// The extractor reports whichever model the geminiLite ROLE names. Pinning the
// literal here made a deliberate registry swap look like a regression; pinning the
// role keeps the real invariant — "extraction bills against geminiLite" — intact.
import { MODELS } from "../../utils/models";

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

// REAL application code under test:
import { parseWithGemini, classifyDocument } from "../geminiParser";
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
    expect(res.usage).toEqual({ inputTokens: 42, outputTokens: 7, model: MODELS.geminiLite });
    expect(res.extracted).toEqual({
      date: "2024-01-31",
      amount: 12345,
      // #172: null, not absent — a document that prints no Trinkgeld line
      // records that as an absence.
      tipAmount: null,
      // #206: null when the response designates no figure as due — the
      // document total is NOT copied into it as a fallback.
      payableAmount: null,
      currency: "EUR",
      vatPercent: null,
      lineItems: null,
      rateGroups: null,
      // #104: transcribed heading and invoice number, null when the model
      // returns neither — an invented §11 element is worse than a missing one.
      selfDesignation: null,
      invoiceNumber: null,
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

  it("normalizes currency symbols and preserves an unrecognised code", async () => {
    const cases: Array<[string | null, string | null]> = [
      ["€", "EUR"],
      ["$", "USD"],
      ["£", "GBP"],
      ["¥", "JPY"],
      ["Fr.", "CHF"],
      ["FR.", "CHF"], // fork #113: the symbol map is matched case-insensitively now
      ["CHF", "CHF"],
      ["USD", "USD"],
      // fork #113: these two used to collapse to "EUR". The coercion happened
      // here, at extraction time, so the wrong currency was already stamped in
      // Firestore before the scorer or the UVA could route the document to the
      // foreign-currency worklist built for it — and a coerced record is
      // byte-identical to a genuine EUR one.
      ["Kč", "KČ"],
      ["usd", "USD"],
      [" eur ", "EUR"],
      ["", null],
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

  it("#299: decodes character references in issuer, recipient and the flat partner name", async () => {
    // Entity normalisation is the one place the stored counterparty name is
    // shaped, so extractedIssuer/extractedRecipient land decoded and every
    // consumer — identity name-lane matching above all — reads one spelling.
    q({
      extracted: {
        issuer: { name: "AL&amp;FA Taxi KG" },
        recipient: { name: "M&#38;S Handels GmbH" },
      },
    });
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.extracted.issuer?.name).toBe("AL&FA Taxi KG");
    expect(res.extracted.recipient?.name).toBe("M&S Handels GmbH");
    // The flat legacy field is shaped here too, so it never carries an entity
    // into extractedPartner on a response with no issuer block.
    expect(res.extracted.partner).toBe("AL&FA Taxi KG");

    q({ extracted: { partner: "Q &amp; A Solutions" } });
    const res2 = await parseWithGemini(BUF, "application/pdf");
    expect(res2.extracted.partner).toBe("Q & A Solutions");
  });

  it("#299: a name with no character reference in it, bare '&' included, is byte-identical", async () => {
    q({
      extracted: {
        issuer: { name: "Q & A Solutions" },
        recipient: { name: "AT&T" },
        partner: "M & S",
      },
    });
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.extracted.issuer?.name).toBe("Q & A Solutions");
    expect(res.extracted.recipient?.name).toBe("AT&T");
    // issuer wins over the flat field, so assert the flat one on its own.
    q({ extracted: { partner: "M & S" } });
    const res2 = await parseWithGemini(BUF, "application/pdf");
    expect(res2.extracted.partner).toBe("M & S");
  });

  it("#299: issuer_raw keeps the document's own characters, undecoded", async () => {
    // The raw block is searched verbatim to highlight the PDF, so decoding it
    // would make the highlight miss the very characters it is looking for.
    q({
      extracted: {
        issuer: { name: "AL&amp;FA Taxi KG" },
        issuer_raw: { name: "AL&amp;FA Taxi KG" },
      },
    });
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.extracted.issuer?.name).toBe("AL&FA Taxi KG");
    expect(res.extractedRaw?.issuer?.name).toBe("AL&amp;FA Taxi KG");
    expect(res.extractedRaw?.partner).toBe("AL&amp;FA Taxi KG");
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
      { description: "A", vatPercent: null, vatAmount: 0, amount: 123 },
      // characterization: "1.234,56" → "1.234.56" → NaN → the whole item is dropped
      // characterization: "1,234" (German thousands) parses as 1.234 → 1 cent
      { description: "C", vatPercent: null, vatAmount: 0, amount: 1 },
      // characterization: empty description falls back to "Item N" using the
      // ORIGINAL index (4th input item), even though item B was dropped
      { description: "Item 4", vatPercent: null, vatAmount: 0, amount: 500 },
    ]);
  });

  it("derives a missing vatAmount from the gross amount", async () => {
    q({ extracted: { lineItems: [{ description: "Cable", amount: 1200, vatPercent: 20 }] } });
    const res = await parseWithGemini(BUF, "application/pdf");
    // vatAmount = round(1200 * 20 / 120) = 200
    expect(res.extracted.lineItems).toEqual([
      { description: "Cable", vatPercent: 20, vatAmount: 200, amount: 1200 },
    ]);
  });

  it("a row is four fields: a quantity and a unit price the model still sends are dropped (#252)", async () => {
    // The prompt no longer asks for either, but a model that ignores the
    // prompt must not put them back into the stored shape.
    q({
      extracted: {
        lineItems: [
          { description: "Cable", quantity: 2, unitPrice: 500, vatPercent: 20, vatAmount: 200, amount: 1200 },
        ],
      },
    });
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.extracted.lineItems).toEqual([
      { description: "Cable", vatPercent: 20, vatAmount: 200, amount: 1200 },
    ]);
  });

  it("out-of-range vatPercent becomes null and vatAmount defaults to 0", async () => {
    q({ extracted: { lineItems: [{ description: "X", amount: 999, vatPercent: 150 }] } });
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.extracted.lineItems).toEqual([
      { description: "X", vatPercent: null, vatAmount: 0, amount: 999 },
    ]);
  });

  it("accepts lineItems at the response top level as a fallback", async () => {
    q({ rawText: "", lineItems: [{ description: "top", amount: 100 }] });
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.extracted.lineItems).toEqual([
      { description: "top", vatPercent: null, vatAmount: 0, amount: 100 },
    ]);
  });

  it("rateGroups: completes a missing column from the printed rate (#67)", async () => {
    q({ extracted: { rateGroups: [{ rate: 20, gross: 1200 }, { rate: 10, net: 1000 }] } });
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.extracted.rateGroups).toEqual([
      { rate: 20, net: 1000, vat: 200, gross: 1200 },
      { rate: 10, net: 1000, vat: 100, gross: 1100 },
    ]);
  });

  it("rateGroups: one unreadable ROW drops the whole block (#67)", async () => {
    // A half-kept summary block would still read downstream as "the receipt
    // said so" — so the block is all-or-nothing.
    q({ extracted: { rateGroups: [{ rate: 20, gross: 1200 }, { rate: null, gross: 500 }] } });
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.extracted.rateGroups).toBeNull();
  });

  it("rateGroups: a rate printed twice is merged into one group (#67)", async () => {
    q({
      extracted: {
        rateGroups: [
          { rate: 20, net: 1000, vat: 200, gross: 1200 },
          { rate: 20, net: 500, vat: 100, gross: 600 },
        ],
      },
    });
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.extracted.rateGroups).toEqual([{ rate: 20, net: 1500, vat: 300, gross: 1800 }]);
  });

  it("rateGroups: accepted at the response top level as a fallback (#67)", async () => {
    q({ rawText: "", rateGroups: [{ rate: 10, net: 1000, vat: 100, gross: 1100 }] });
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.extracted.rateGroups).toEqual([{ rate: 10, net: 1000, vat: 100, gross: 1100 }]);
  });

  it("selfDesignation/invoiceNumber are transcribed, and a non-string degrades to null (#104)", async () => {
    q(
      JSON.stringify({
        extracted: { amount: 100, selfDesignation: "  Zahlungsbestätigung  ", invoiceNumber: 2024 },
      }),
    );
    const res = await parseWithGemini(BUF, "application/pdf");

    // Trimmed but otherwise copied — the §11 classifier reads this as evidence.
    expect(res.extracted.selfDesignation).toBe("Zahlungsbestätigung");
    // A number is the model having invented one; an invented §11 element
    // would read as a satisfied requirement, so it must degrade, not coerce.
    expect(res.extracted.invoiceNumber).toBeNull();
  });

  it("an empty transcription is the same as none (#104)", async () => {
    q(JSON.stringify({ extracted: { amount: 100, selfDesignation: "   ", invoiceNumber: "" } }));
    const res = await parseWithGemini(BUF, "application/pdf");

    expect(res.extracted.selfDesignation).toBeNull();
    expect(res.extracted.invoiceNumber).toBeNull();
  });

  it("payableAmount: a Mahnung's demanded figure survives beside the invoice total (#206)", async () => {
    // A Mahnung prints the original invoice amount and the sum now demanded.
    // Nothing about `amount` says which of the two is owed, so the designated
    // figure is transcribed into its own field instead of guessed at read time.
    q({
      extracted: {
        amount: 75000,
        payableAmount: 339000,
        selfDesignation: "Mahnung",
        rateGroups: [{ rate: 20, net: 62500, vat: 12500, gross: 75000 }],
      },
    });
    const res = await parseWithGemini(BUF, "application/pdf");

    expect(res.extracted.payableAmount).toBe(339000);
    // The existing figure does not move: `amount` is still what it always was,
    // and the printed VAT block still describes the invoice it belongs to.
    expect(res.extracted.amount).toBe(75000);
    expect(res.extracted.rateGroups).toEqual([{ rate: 20, net: 62500, vat: 12500, gross: 75000 }]);
  });

  it("payableAmount: a document printing one total yields that total unchanged (#206)", async () => {
    q({ extracted: { amount: 12345, vatPercent: 20 } });
    const res = await parseWithGemini(BUF, "application/pdf");

    expect(res.extracted.amount).toBe(12345);
    // Transcription, not computation: no designated figure is printed, so the
    // field is null rather than a copy of the total.
    expect(res.extracted.payableAmount).toBeNull();
  });

  it("payableAmount: an unreadable figure degrades to null (#206)", async () => {
    q({ extracted: { amount: 12345, payableAmount: "dreitausend" } });
    const res = await parseWithGemini(BUF, "application/pdf");

    expect(res.extracted.amount).toBe(12345);
    expect(res.extracted.payableAmount).toBeNull();
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

  // The third defect the repair pass has always handled, and the only one of
  // the three that had no test. The invalid-escape pass added for #231 now
  // runs ahead of it over the same string content, so pin it rather than
  // assume it.
  it("repairs a raw newline inside a string value", async () => {
    q('{"extracted": {"address": "Wien\nAustria", "amount": 5}}');
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.extracted.address).toBe("Wien\nAustria");
    expect(res.extracted.amount).toBe(5);
  });

  // #157/#231: a backslash the model transcribed as data (a Windows path, a
  // `\d` in a reference number, a hand-typed separator) is not a JSON escape.
  // The old repair pass copied it through untouched and the second parse
  // failed identically to the first — "Bad escaped character in JSON".
  it("repairs an invalid escape sequence, and the backslash survives literally (#231)", async () => {
    q('{"extracted": {"invoiceNumber": "RE-2024\\d001", "amount": 500}}');
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.extracted.invoiceNumber).toBe("RE-2024\\d001");
    expect(res.extracted.amount).toBe(500);
  });

  it("leaves every JSON-defined escape untouched by the invalid-escape repair (#231)", async () => {
    // Forces the repair path (invalid \d earlier in the payload) while also
    // carrying every escape JSON itself defines, including an escaped quote
    // and a \uXXXX sequence, to prove they aren't mangled along the way.
    q(
      '{"extracted": {"invoiceNumber": "bad\\zescape", ' +
        '"address": "Say \\"hi\\", line1\\nline2, caf\\u00e9"}}',
    );
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.extracted.invoiceNumber).toBe("bad\\zescape");
    expect(res.extracted.address).toBe('Say "hi", line1\nline2, café');
  });

  // Reproduces the defect class from the report that opened #231: a stray
  // backslash deep inside a transcribed field, not at a structural boundary.
  // The original response lives only on the reporter's machine, so this pins
  // the failure mode rather than the exact bytes.
  it("extracts a response with a stray backslash deep inside a transcribed field (#231)", async () => {
    q(
      '{"extracted": {"partner": "Muster GmbH", ' +
        '"address": "C:\\Users\\muster\\Rechnungen\\2024", "amount": 12345}}',
    );
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.extracted.partner).toBe("Muster GmbH");
    expect(res.extracted.amount).toBe(12345);
    expect(res.extracted.address).toBe("C:\\Users\\muster\\Rechnungen\\2024");
  });

  it("does not touch an already-valid JSON response", async () => {
    // A path-like value with correctly doubled backslashes must round-trip
    // unchanged — the repair pass is never invoked when the first parse
    // succeeds.
    q({ extracted: { address: "C:\\Users\\muster", amount: 42 } });
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.extracted.address).toBe("C:\\Users\\muster");
    expect(res.extracted.amount).toBe(42);
  });

  // The test above covers `\"`, `\n` and `\uXXXX`; the criterion is "every
  // escape sequence JSON does define". `\\` matters most — a pass that doubled
  // indiscriminately would turn one escaped backslash into two literal ones
  // and corrupt the field silently, without ever failing the parse.
  it("carries the remaining JSON-defined escapes through the repair intact (#231)", async () => {
    q(
      '{"extracted": {"invoiceNumber": "bad\\zescape", ' +
        '"address": "C:\\\\Users\\\\muster\\ttab\\rcr\\bbs\\fff\\/slash"}}',
    );
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.extracted.invoiceNumber).toBe("bad\\zescape");
    expect(res.extracted.address).toBe("C:\\Users\\muster\ttab\rcr\bbs\fff/slash");
  });

  // `\u` only introduces an escape when four hex digits follow it. Anything
  // else is a transcribed backslash like any other.
  it("treats a malformed \\uXXXX sequence as a literal backslash (#231)", async () => {
    q('{"extracted": {"address": "caf\\uZZZZ", "amount": 9}}');
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.extracted.address).toBe("caf\\uZZZZ");
    expect(res.extracted.amount).toBe(9);
  });

  // -------------------------------------------------------------------------
  // #275: the repair pass says where it had to guess
  //
  // `\t` in a response is either an escape the model wrote or two characters
  // the document prints, and those are the same two bytes. #231 settled that
  // JSON's reading wins; what is pinned here is that the choice is RECORDED.
  // The extracted values below are exactly what the repair produced before
  // this — the flag is a signal alongside them, never a change to them.
  // -------------------------------------------------------------------------

  it("names the field when a \\t survives a string the pass had to modify (#275)", async () => {
    q('{"extracted": {"address": "C:\\Users\\test", "amount": 5}}');
    const res = await parseWithGemini(BUF, "application/pdf");

    // Unchanged from #231: `\U` is not an escape and survives literally, `\t`
    // is one and becomes a TAB. That is the corruption nobody could see.
    expect(res.extracted.address).toBe("C:\\Users\test");
    expect(res.extracted.amount).toBe(5);
    expect(res.repairAmbiguousFields).toEqual(["address"]);
  });

  it("flags each of \\b \\f \\n \\r \\t the same way (#275)", async () => {
    const ambiguous = [
      ["b", "\b"],
      ["f", "\f"],
      ["n", "\n"],
      ["r", "\r"],
      ["t", "\t"],
    ] as const;

    for (const [letter, control] of ambiguous) {
      q(`{"extracted": {"address": "C:\\zone\\${letter}wo"}}`);
      const res = await parseWithGemini(BUF, "application/pdf");
      expect(res.extracted.address).toBe(`C:\\zone${control}wo`);
      expect(res.repairAmbiguousFields).toEqual(["address"]);
    }
  });

  it("names every affected field, and only those (#275)", async () => {
    q(
      '{"extracted": {"address": "C:\\Users\\test", ' +
        '"invoiceNumber": "RE-2024\\d001", "partner": "Muster GmbH"}}',
    );
    const res = await parseWithGemini(BUF, "application/pdf");

    // invoiceNumber was modified but carries no ambiguous escape, and partner
    // was never touched — neither was guessed at.
    expect(res.extracted.invoiceNumber).toBe("RE-2024\\d001");
    expect(res.extracted.partner).toBe("Muster GmbH");
    expect(res.repairAmbiguousFields).toEqual(["address"]);
  });

  it("does not flag a \\t in a string the pass never had to modify (#275)", async () => {
    // The repair path is forced by the invalid escape in `invoiceNumber`. The
    // address escaped its tab correctly, so its `\t` is a real tab.
    q('{"extracted": {"invoiceNumber": "bad\\zescape", "address": "col1\\tcol2"}}');
    const res = await parseWithGemini(BUF, "application/pdf");

    expect(res.extracted.address).toBe("col1\tcol2");
    expect(res.repairAmbiguousFields).toEqual([]);
  });

  it("does not flag a response repaired only by the raw-newline heuristic (#275)", async () => {
    // The false positive a detector reading the PARSED result produces: this
    // value carries a control character too, and nothing was guessed at.
    q('{"extracted": {"address": "Wien\nAustria", "amount": 5}}');
    const res = await parseWithGemini(BUF, "application/pdf");

    expect(res.extracted.address).toBe("Wien\nAustria");
    expect(res.repairAmbiguousFields).toEqual([]);
  });

  it("does not flag a response repaired only for commas or braces (#275)", async () => {
    q('{"extracted": {"amount": 500,}}');
    expect((await parseWithGemini(BUF, "application/pdf")).repairAmbiguousFields).toEqual([]);

    q('{"extracted": {"amount": 777, "confidence": 0.9');
    expect((await parseWithGemini(BUF, "application/pdf")).repairAmbiguousFields).toEqual([]);
  });

  it("does not flag unambiguous invalid escapes — nothing was guessed (#275)", async () => {
    q('{"extracted": {"address": "C:\\Rechnungen\\2024", "invoiceNumber": "RE\\d1"}}');
    const res = await parseWithGemini(BUF, "application/pdf");

    expect(res.extracted.address).toBe("C:\\Rechnungen\\2024");
    expect(res.extracted.invoiceNumber).toBe("RE\\d1");
    expect(res.repairAmbiguousFields).toEqual([]);
  });

  it("does not flag a response that parsed first time (#275)", async () => {
    q({ extracted: { address: "C:\\Users\\muster\ttab", amount: 42 } });
    const res = await parseWithGemini(BUF, "application/pdf");

    expect(res.extracted.address).toBe("C:\\Users\\muster\ttab");
    expect(res.repairAmbiguousFields).toEqual([]);
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

    // Truncated mid-string, so the response ends on a lone backslash.
    // Doubling it does not terminate the string: the escape pass must not
    // rescue this into something parseable-but-wrong (#231).
    q('{"extracted": {"address": "C:\\Users\\x');
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
        { key: "invoiceNumber", label: "Invoice Number", value: "INV-1", rawValue: "No. INV-1" },
        { key: "invoiceNumber", label: "", value: "dropped" },
        { key: "invoiceNumber", label: "no-value" },
        { key: "dueDate", label: "Due Date", value: "2025-01-01" },
      ],
    });
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.additionalFields).toEqual([
      { key: "invoiceNumber", label: "Invoice Number", value: "INV-1", rawValue: "No. INV-1" },
      { key: "dueDate", label: "Due Date", value: "2025-01-01", rawValue: "2025-01-01" },
    ]);
  });

  it("additionalFields: a key outside the closed vocabulary is dropped — Tischnummer (#252)", async () => {
    q({
      extracted: {},
      additionalFields: [
        { key: "tableNumber", label: "Tischnummer", value: "12" },
        { key: "loyaltyNumber", label: "Kundenkarte", value: "778899" },
        { key: "customerNumber", label: "Kundennummer", value: "K-42" },
      ],
    });
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.additionalFields).toEqual([
      { key: "customerNumber", label: "Kundennummer", value: "K-42", rawValue: "K-42" },
    ]);
  });

  it("additionalFields: a field with NO key is dropped — the vocabulary fails closed (#252)", async () => {
    q({
      extracted: {},
      additionalFields: [
        { label: "Tischnummer", value: "12" },
        { label: "Rechnungsnummer", value: "2024-001" },
      ],
    });
    const res = await parseWithGemini(BUF, "application/pdf");
    expect(res.additionalFields).toEqual([]);
  });

  it("additionalFields: a whitelisted key keeps the label the document PRINTS (#252)", async () => {
    q({
      extracted: {},
      additionalFields: [
        { key: "invoiceNumber", label: "Rechnungsnummer", value: "2024-001", rawValue: "Rechnungs-Nr. 2024-001" },
        { key: "dueDate", label: "Fällig am", value: "2025-01-15", rawValue: "15.01.2025" },
        { key: "paymentTerms", label: "Zahlungsziel", value: "30 Tage netto" },
      ],
    });
    const res = await parseWithGemini(BUF, "application/pdf");
    // The key is what is matched; the printed label is never translated or normalised.
    expect(res.additionalFields).toEqual([
      {
        key: "invoiceNumber",
        label: "Rechnungsnummer",
        value: "2024-001",
        rawValue: "Rechnungs-Nr. 2024-001",
      },
      { key: "dueDate", label: "Fällig am", value: "2025-01-15", rawValue: "15.01.2025" },
      { key: "paymentTerms", label: "Zahlungsziel", value: "30 Tage netto", rawValue: "30 Tage netto" },
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
    expect(res.usage).toEqual({ inputTokens: 42, outputTokens: 7, model: MODELS.geminiLite });
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
      usage: { inputTokens: 42, outputTokens: 7, model: MODELS.geminiLite },
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
// documentExtractor — result shaping
// ===========================================================================

describe("characterization: documentExtractor", () => {
  it("getDefaultProvider: gemini, whatever EXTRACTION_PROVIDER says (#170)", () => {
    // The legacy vision-claude branch is retired; the env var routes nowhere.
    delete process.env.EXTRACTION_PROVIDER;
    expect(getDefaultProvider()).toBe("gemini");
    process.env.EXTRACTION_PROVIDER = "vision-claude";
    expect(getDefaultProvider()).toBe("gemini");
    process.env.EXTRACTION_PROVIDER = "something-else";
    expect(getDefaultProvider()).toBe("gemini");
    delete process.env.EXTRACTION_PROVIDER;
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
      payableAmount: null, // #206: an absence, like every other field here
      currency: null,
      vatPercent: null,
      lineItems: null,
      selfDesignation: null,
      invoiceNumber: null,
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

  it("gemini: carries the repair-ambiguity field names up to the result (#275)", async () => {
    q('{"extracted": {"address": "C:\\Users\\test", "amount": 5}}');
    const res = await extractDocument(BUF, "image/jpeg", {
      provider: "gemini",
      skipClassification: true,
    });

    expect(res.repairAmbiguousFields).toEqual(["address"]);
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
    expect(res.usage).toEqual({ inputTokens: 42, outputTokens: 7, model: MODELS.geminiLite });
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
