import Anthropic from "@anthropic-ai/sdk";
import { ExtractedData } from "../types/extraction";

export interface ClaudeParseResult {
  extracted: ExtractedData;
  usage: {
    inputTokens: number;
    outputTokens: number;
    model: string;
  };
}

/**
 * Parse OCR text using Claude Haiku to extract structured invoice/receipt data
 */
export async function parseWithClaude(
  ocrText: string,
  apiKey: string
): Promise<ClaudeParseResult> {
  const anthropic = new Anthropic({ apiKey });

  const response = await anthropic.messages.create({
    model: "claude-3-haiku-20240307",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `Extract invoice/receipt data from this OCR text. Return ONLY valid JSON, no other text.

OCR Text:
${ocrText}

Extract these fields (use null if not found):
- date: Document date in ISO format (YYYY-MM-DD). Look for "Rechnungsdatum", "Datum", "Date", "Invoice Date" etc.
- amount: TOTAL amount in cents as integer (e.g., 12345 for €123.45 or 123,45). Look for "Gesamtbetrag", "Total", "Summe", "Endbetrag", "Brutto" etc.
- currency: 3-letter code (EUR, USD, CHF, GBP). Default to EUR for German documents with € symbol.
- vatPercent: VAT percentage as integer (e.g., 19 for 19%, 7 for 7%). Look for "MwSt", "USt", "VAT" percentages.
- partner: Company/vendor name. Usually at the top of the invoice or after "Von:", "From:".
- vatId: VAT identification number (e.g., ATU12345678, DE123456789). Look for "UID", "UID-Nr", "VAT ID", "USt-IdNr", "MwSt-Nr", "Steuernummer".
- iban: IBAN if visible (e.g., AT12 3456 7890 1234 5678, DE89 3704 0044 0532 0130 00). Look for "IBAN", bank details section.
- address: Full company address as single string. Look for the address block near the company name, letterhead, or "Adresse".

IMPORTANT for German formats:
- Dates: DD.MM.YYYY or DD/MM/YYYY -> convert to YYYY-MM-DD
- Amounts: Use comma as decimal (123,45 = 12345 cents), period as thousands separator (1.234,56 = 123456 cents)
- Multiple VAT rates: Return the main/higher rate
- VAT IDs: Keep original format with country prefix (AT, DE, etc.)
- IBANs: Remove spaces for storage but include in fieldSpans with original formatting

Also return "fieldSpans" with the EXACT text from the document that you used to extract each field. This is critical for highlighting on the document.

Example response:
{
  "date": "2024-01-15",
  "amount": 12345,
  "currency": "EUR",
  "vatPercent": 19,
  "partner": "ACME GmbH",
  "vatId": "ATU12345678",
  "iban": "AT123456789012345678",
  "address": "Musterstraße 123, 1010 Wien, Austria",
  "confidence": 0.92,
  "fieldSpans": {
    "date": "15.01.2024",
    "amount": "123,45 €",
    "vatPercent": "19%",
    "partner": "ACME GmbH",
    "vatId": "UID: ATU12345678",
    "iban": "AT12 3456 7890 1234 5678",
    "address": "Musterstraße 123\\n1010 Wien"
  }
}`,
      },
    ],
  });

  const usage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    model: "claude-3-haiku-20240307",
  };

  // Extract text content from response
  const textContent = response.content.find((c) => c.type === "text");
  if (!textContent || textContent.type !== "text") {
    throw new Error("No text response from Claude");
  }

  // Parse JSON from response, handling potential markdown code blocks
  let jsonStr = textContent.text.trim();
  if (jsonStr.startsWith("```json")) {
    jsonStr = jsonStr.slice(7);
  } else if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.slice(3);
  }
  if (jsonStr.endsWith("```")) {
    jsonStr = jsonStr.slice(0, -3);
  }
  jsonStr = jsonStr.trim();

  const parsed = JSON.parse(jsonStr);

  return {
    extracted: {
      date: parsed.date || null,
      amount: typeof parsed.amount === "number" ? parsed.amount : null,
      currency: parsed.currency || null,
      vatPercent: typeof parsed.vatPercent === "number" ? parsed.vatPercent : null,
      lineItems: null, // Legacy Claude parser does not extract line items
      partner: parsed.partner || null,
      vatId: parsed.vatId || null,
      iban: parsed.iban || null,
      address: parsed.address || null,
      website: null, // Claude parser doesn't extract website (legacy)
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      fieldSpans: parsed.fieldSpans || {},
      // Legacy Claude parser doesn't extract entities - set to null
      // The extractionCore will handle these as null and fall back to legacy partner field
      issuer: null,
      recipient: null,
    },
    usage,
  };
}
