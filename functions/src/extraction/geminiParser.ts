import { VertexAI, Part } from "@google-cloud/vertexai";
import { PDFDocument } from "pdf-lib";

// Model options for comparison (fastest to most accurate)
// gemini-2.0-flash-lite-001: Fastest, lowest cost
// gemini-2.0-flash-001: Fast, good balance
// gemini-2.5-flash-preview-05-20: Better accuracy, slower
export type GeminiModel =
  | "gemini-2.0-flash-lite-001"
  | "gemini-2.0-flash-001"
  | "gemini-2.5-flash-preview-05-20";

// Using Flash-Lite for maximum speed - good enough for invoice extraction
export const DEFAULT_GEMINI_MODEL: GeminiModel = "gemini-2.0-flash-lite-001";

// Get project ID from environment (Firebase sets this automatically)
function getProjectId(): string {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) {
    throw new Error("Could not determine Google Cloud project ID");
  }
  return projectId;
}

// Vertex AI location - match Firebase region to minimize latency
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || "europe-west1";

import { ExtractedData, ExtractedLineItem } from "../types/extraction";

/**
 * Bounding box extracted by Gemini for a field
 */
export interface GeminiBoundingBox {
  field: "date" | "amount" | "currency" | "vatPercent" | "partner" | "vatId" | "iban" | "address";
  value: string;
  vertices: Array<{ x: number; y: number }>;
  pageIndex: number;
}

// Normalize currency symbols to ISO codes
const CURRENCY_MAP: Record<string, string> = {
  "€": "EUR",
  "$": "USD",
  "£": "GBP",
  "¥": "JPY",
  "CHF": "CHF",
  "Fr.": "CHF",
};

function normalizeCurrency(currency: string | null | undefined): string | null {
  if (!currency) return null;
  if (/^[A-Z]{3}$/.test(currency)) return currency;
  return CURRENCY_MAP[currency] || "EUR";
}

/**
 * Normalize VAT ID for consistent storage
 * "DE 123 456 789" → "DE123456789"
 * "ATU 123.456.78" → "ATU12345678"
 */
function normalizeVatId(vatId: string | null | undefined): string | null {
  if (!vatId) return null;
  // Remove all non-alphanumeric characters, uppercase
  const normalized = vatId.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return normalized || null;
}

/**
 * Normalize website/domain to clean domain format
 * "https://www.amazon.de/contact" → "amazon.de"
 * "contact@amazon.de" → "amazon.de"
 * "www.amazon.de" → "amazon.de"
 */
function normalizeWebsite(website: string | null | undefined): string | null {
  if (!website) return null;

  let domain = website.toLowerCase().trim();

  // Extract domain from email address
  if (domain.includes("@")) {
    const parts = domain.split("@");
    domain = parts[parts.length - 1];
  }

  // Remove protocol
  domain = domain.replace(/^https?:\/\//, "");

  // Remove www prefix
  domain = domain.replace(/^www\./, "");

  // Remove path, query, and fragment
  domain = domain.split("/")[0].split("?")[0].split("#")[0];

  // Basic validation - must have at least one dot
  if (!domain.includes(".")) return null;

  return domain || null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().replace(",", ".");
    if (!normalized) return null;
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function toCents(value: unknown): number | null {
  const num = toFiniteNumber(value);
  return num === null ? null : Math.round(num);
}

function normalizeVatPercent(vatPercent: unknown): number | null {
  const vat = toFiniteNumber(vatPercent);
  if (vat === null || vat < 0 || vat > 100) {
    return null;
  }
  return vat;
}

/**
 * Attempt to repair malformed JSON from Gemini responses
 */
function repairJson(jsonStr: string): string {
  // Common fixes for Gemini JSON output issues
  let repaired = jsonStr;

  // Fix trailing commas before } or ]
  repaired = repaired.replace(/,(\s*[}\]])/g, "$1");

  // Fix unescaped newlines in strings (replace with \n)
  repaired = repaired.replace(/([":]\s*"[^"]*)\n([^"]*")/g, "$1\\n$2");

  // Fix truncated JSON - try to close unclosed brackets
  const openBraces = (repaired.match(/{/g) || []).length;
  const closeBraces = (repaired.match(/}/g) || []).length;
  const openBrackets = (repaired.match(/\[/g) || []).length;
  const closeBrackets = (repaired.match(/\]/g) || []).length;

  // Add missing closing braces/brackets
  for (let i = 0; i < openBrackets - closeBrackets; i++) {
    repaired += "]";
  }
  for (let i = 0; i < openBraces - closeBraces; i++) {
    repaired += "}";
  }

  return repaired;
}

/**
 * Try to extract JSON from a response, even if malformed
 */
function extractJsonFromResponse(text: string): string | null {
  // Try to find the outermost JSON object
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");

  if (firstBrace === -1) return null;

  if (lastBrace > firstBrace) {
    return text.substring(firstBrace, lastBrace + 1);
  }

  // JSON might be truncated - return from first brace
  return text.substring(firstBrace);
}

/**
 * Extract only the first page of a PDF to reduce processing costs.
 * Returns the original buffer if extraction fails or file is not a PDF.
 */
async function extractFirstPage(fileBuffer: Buffer, fileType: string): Promise<Buffer> {
  if (fileType !== "application/pdf") {
    return fileBuffer;
  }

  try {
    const sourcePdf = await PDFDocument.load(fileBuffer);
    const pageCount = sourcePdf.getPageCount();

    // If only 1-2 pages, return original
    if (pageCount <= 2) {
      return fileBuffer;
    }

    // Create new PDF with just the first page
    const newPdf = await PDFDocument.create();
    const [firstPage] = await newPdf.copyPages(sourcePdf, [0]);
    newPdf.addPage(firstPage);

    const firstPageBytes = await newPdf.save();
    console.log(`  [PDF] Extracted first page from ${pageCount}-page document (${fileBuffer.length} → ${firstPageBytes.length} bytes)`);
    return Buffer.from(firstPageBytes);
  } catch (error) {
    console.warn(`  [PDF] Failed to extract first page, using full document:`, error);
    return fileBuffer;
  }
}

// Threshold for using two-phase extraction (500KB)
export const TWO_PHASE_THRESHOLD_BYTES = 500 * 1024;

/**
 * Quick classification to determine if a document is an invoice.
 * Uses only the first page of PDFs to minimize cost for large documents.
 */
export async function classifyDocument(
  fileBuffer: Buffer,
  fileType: string,
  model: GeminiModel = DEFAULT_GEMINI_MODEL
): Promise<{
  isInvoice: boolean;
  reason: string | null;
  confidence: number;
  usage: { inputTokens: number; outputTokens: number; model: string };
}> {
  const projectId = getProjectId();
  const vertexAI = new VertexAI({ project: projectId, location: VERTEX_LOCATION });
  const geminiModel = vertexAI.getGenerativeModel({ model });

  // Extract first page only for classification
  const classifyBuffer = await extractFirstPage(fileBuffer, fileType);

  // Determine MIME type
  let mimeType: string;
  if (fileType === "application/pdf") {
    mimeType = "application/pdf";
  } else if (fileType.startsWith("image/")) {
    mimeType = fileType;
  } else {
    mimeType = "image/jpeg";
  }

  const filePart: Part = {
    inlineData: {
      data: classifyBuffer.toString("base64"),
      mimeType,
    },
  };

  // Simple classification prompt - minimal output
  const prompt = `Is this a financial document (invoice, receipt, or payment record)?

Answer in JSON only:
{"isInvoice": true/false, "reason": "brief reason if not invoice", "confidence": 0.0-1.0}

VALID = invoices, receipts, tickets with prices, flight confirmations with amounts,
payment confirmations, booking confirmations with prices, any document showing a paid amount.

NOT VALID = tax forms (W-8BEN, Steuererklärung), contracts without amounts,
annual reports (Jahresabschluss), bank statements, spam, legal documents, letters without payment amounts.

JSON only:`;

  const apiStart = Date.now();
  const result = await geminiModel.generateContent({
    contents: [{ role: "user", parts: [filePart, { text: prompt }] }],
  });
  console.log(`  [Gemini Classification] API call took ${Date.now() - apiStart}ms`);

  const response = result.response;
  const text = response.candidates?.[0]?.content?.parts?.[0]?.text || "";

  // Extract token usage
  const usageMetadata = response.usageMetadata;
  const usage = {
    inputTokens: usageMetadata?.promptTokenCount || 0,
    outputTokens: usageMetadata?.candidatesTokenCount || 0,
    model,
  };

  // Parse JSON response
  let jsonStr = text.trim();
  if (jsonStr.startsWith("```json")) jsonStr = jsonStr.slice(7);
  else if (jsonStr.startsWith("```")) jsonStr = jsonStr.slice(3);
  if (jsonStr.endsWith("```")) jsonStr = jsonStr.slice(0, -3);
  jsonStr = jsonStr.trim();

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      isInvoice: parsed.isInvoice === true,
      reason: parsed.reason || null,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      usage,
    };
  } catch {
    // Default to treating as invoice if classification fails
    console.warn("[Gemini Classification] Failed to parse response, defaulting to invoice");
    return { isInvoice: true, reason: null, confidence: 0.5, usage };
  }
}

/**
 * Parse a document using Gemini's native vision capabilities via Vertex AI.
 * Uses service account authentication (no API key needed).
 * Gemini can process PDFs directly without a separate OCR step.
 */

/**
 * Raw text for an entity (for PDF search/highlight)
 */
export interface ExtractedEntityRaw {
  name?: string | null;
  vatId?: string | null;
  address?: string | null;
  iban?: string | null;
  website?: string | null;
}

/**
 * Raw text values as they appear in the document (for PDF search/highlight)
 */
export interface ExtractedRawText {
  date?: string | null;
  amount?: string | null;
  vatPercent?: string | null;
  partner?: string | null;
  vatId?: string | null;
  iban?: string | null;
  address?: string | null;
  website?: string | null;
  // New entity raw fields
  issuer?: ExtractedEntityRaw | null;
  recipient?: ExtractedEntityRaw | null;
}

/**
 * Additional field extracted from document
 */
export interface ExtractedAdditionalField {
  label: string;
  value: string;
  rawValue?: string;
}

interface GeminiLineItem {
  description?: string | null;
  quantity?: number | string | null;
  unitPrice?: number | string | null;
  vatPercent?: number | string | null;
  vatAmount?: number | string | null;
  amount?: number | string | null;
}

function normalizeLineItems(lineItems: GeminiLineItem[] | null | undefined): ExtractedLineItem[] | null {
  if (!Array.isArray(lineItems)) {
    return null;
  }

  const normalizedItems = lineItems
    .map((item, index): ExtractedLineItem | null => {
      const amount = toCents(item?.amount);
      if (amount === null) {
        return null;
      }

      const description = typeof item?.description === "string"
        ? item.description.trim()
        : "";

      const quantity = toFiniteNumber(item?.quantity);
      const normalizedQuantity = quantity === null ? null : quantity;

      let unitPrice = toCents(item?.unitPrice);
      const vatPercent = normalizeVatPercent(item?.vatPercent);
      let vatAmount = toCents(item?.vatAmount);

      if (vatAmount === null && vatPercent !== null) {
        vatAmount = Math.round((amount * vatPercent) / (100 + vatPercent));
      }
      if (vatAmount === null) {
        vatAmount = 0;
      }

      if (unitPrice === null && normalizedQuantity && normalizedQuantity !== 0) {
        const netAmount = amount - vatAmount;
        unitPrice = Math.round(netAmount / normalizedQuantity);
      }

      return {
        description: description || `Item ${index + 1}`,
        quantity: normalizedQuantity,
        unitPrice,
        vatPercent,
        vatAmount,
        amount,
      };
    })
    .filter((item): item is ExtractedLineItem => item !== null);

  return normalizedItems.length > 0 ? normalizedItems : null;
}

export async function parseWithGemini(
  fileBuffer: Buffer,
  fileType: string,
  model: GeminiModel = DEFAULT_GEMINI_MODEL
): Promise<{
  extracted: ExtractedData;
  rawText: string;
  boundingBoxes: GeminiBoundingBox[];
  extractedRaw: ExtractedRawText;
  additionalFields: ExtractedAdditionalField[];
  usage: { inputTokens: number; outputTokens: number; model: string };
}> {
  const projectId = getProjectId();
  const vertexAI = new VertexAI({ project: projectId, location: VERTEX_LOCATION });
  const geminiModel = vertexAI.getGenerativeModel({ model });

  // Determine MIME type
  let mimeType: string;
  if (fileType === "application/pdf") {
    mimeType = "application/pdf";
  } else if (fileType.startsWith("image/")) {
    mimeType = fileType;
  } else {
    // Fallback for common image types
    mimeType = "image/jpeg";
  }

  // Create the file part for Gemini
  const filePart: Part = {
    inlineData: {
      data: fileBuffer.toString("base64"),
      mimeType,
    },
  };

  // Extraction-only prompt - classification is handled separately by classifyDocument
  const prompt = `Extract invoice/receipt data from this document. Return JSON only.

CRITICAL RULES:
1. ONLY extract data that is ACTUALLY VISIBLE in the document
2. If a field is not found, use null - NEVER make up values
3. For each field, also return the EXACT text as it appears in the document (for search)

LINE ITEM EXTRACTION (IMPORTANT):
- Extract ALL line items from the document
- If no itemization is visible, create exactly ONE line item for the total
- Return all monetary amounts in cents
- Use "vatPercent": null when the rate is not explicitly visible (do not guess)

Input format: German (dates DD.MM.YYYY, amounts with comma like 123,45)
Output: date as YYYY-MM-DD, amount in cents (123,45 → 12345)

=== ENTITY EXTRACTION (IMPORTANT) ===

Extract TWO entities from the document:

1. ISSUER (who created/sent this document):
   - Usually in the letterhead/header with logo
   - Has VAT ID, address, often IBAN/bank details
   - Look for: "From:", sender info, company stamp, letterhead
   - This is the company sending the invoice

2. RECIPIENT (who receives this document):
   - Usually in "Bill to:", "To:", "Kunde:", "Empfänger:", "An:"
   - May have VAT ID and address
   - This is the company being billed

IMPORTANT - "website" field (for issuer):
- Extract the issuer's website domain from the document
- Look for: www.company.de, https://company.com, contact@company.de (extract domain)
- Found in: letterhead, footer, contact section, email addresses
- Return as domain only (e.g., "company.de" not "https://www.company.de/contact")
- If only an email is found (e.g., invoice@amazon.de), extract the domain (amazon.de)

IMPORTANT - Raw text fields:
- For each field, also include a "_raw" version with the EXACT text from the document
- This is used to search/highlight in the PDF, so it must match exactly
- Example: amount=12345 (cents), amount_raw="123,45 €" (exactly as shown)

JSON structure:
{
  "rawText": "<all text from document>",
  "extracted": {
    "date": "2024-12-15",
    "date_raw": "15.12.2024",
    "amount": 12345,
    "amount_raw": "123,45 €",
    "currency": "EUR",
    "vatPercent": 19,
    "vatPercent_raw": "19%",
    "lineItems": [
      {
        "description": "USB-C Cable",
        "quantity": 2,
        "unitPrice": 999,
        "vatPercent": 20,
        "vatAmount": 333,
        "amount": 1998
      }
    ],
    "confidence": 0.85,

    "issuer": {
      "name": "Vendor Company GmbH",
      "vatId": "DE123456789",
      "address": "Musterstraße 1, 12345 Berlin",
      "iban": "DE89370400440532013000",
      "website": "vendor-company.de"
    },
    "issuer_raw": {
      "name": "Vendor Company GmbH",
      "vatId": "DE123456789",
      "address": "Musterstraße 1\\n12345 Berlin",
      "iban": "DE89 3704 0044 0532 0130 00",
      "website": "www.vendor-company.de"
    },

    "recipient": {
      "name": "Customer Corp",
      "vatId": "ATU12345678",
      "address": "Kundenweg 5, 1010 Wien"
    },
    "recipient_raw": {
      "name": "Customer Corp",
      "vatId": "ATU12345678",
      "address": "Kundenweg 5\\n1010 Wien"
    }
  },
  "additionalFields": [
    {"label": "Invoice Number", "value": "INV-2024-001", "rawValue": "INV-2024-001"},
    {"label": "Due Date", "value": "2025-01-15", "rawValue": "15.01.2025"},
    {"label": "Reference", "value": "PO-12345", "rawValue": "PO-12345"}
  ]
}

Additional fields: Extract any other useful fields from the document like:
- Invoice number, reference number, PO number
- Due date, payment terms
- Customer/client number
- Order number, delivery note number
- Any other identifiers or metadata

JSON only, no markdown, no explanation.`;

  const apiStart = Date.now();
  const result = await geminiModel.generateContent({
    contents: [{ role: "user", parts: [filePart, { text: prompt }] }],
  });
  console.log(`  [Gemini] API call took ${Date.now() - apiStart}ms (region: ${VERTEX_LOCATION})`);

  const response = result.response;
  const text = response.candidates?.[0]?.content?.parts?.[0]?.text || "";

  // Extract token usage
  const usageMetadata = response.usageMetadata;
  const usage = {
    inputTokens: usageMetadata?.promptTokenCount || 0,
    outputTokens: usageMetadata?.candidatesTokenCount || 0,
    model,
  };

  // Parse JSON from response, handling potential markdown code blocks
  let jsonStr = text.trim();
  if (jsonStr.startsWith("```json")) {
    jsonStr = jsonStr.slice(7);
  } else if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.slice(3);
  }
  if (jsonStr.endsWith("```")) {
    jsonStr = jsonStr.slice(0, -3);
  }
  jsonStr = jsonStr.trim();

  // Entity structure for issuer/recipient
  interface GeminiEntity {
    name?: string | null;
    vatId?: string | null;
    address?: string | null;
    iban?: string | null;
    website?: string | null;
  }

  // Define expected response structure (classification removed - handled by classifyDocument)
  interface GeminiResponse {
    rawText?: string;
    lineItems?: GeminiLineItem[] | null;
    extracted?: {
      date?: string | null;
      date_raw?: string | null;
      amount?: number | null;
      amount_raw?: string | null;
      currency?: string | null;
      vatPercent?: number | null;
      vatPercent_raw?: string | null;
      lineItems?: GeminiLineItem[] | null;
      confidence?: number;
      // New entity fields
      issuer?: GeminiEntity | null;
      issuer_raw?: GeminiEntity | null;
      recipient?: GeminiEntity | null;
      recipient_raw?: GeminiEntity | null;
      // Legacy fields (for backward compatibility during transition)
      partner?: string | null;
      partner_raw?: string | null;
      vatId?: string | null;
      vatId_raw?: string | null;
      iban?: string | null;
      iban_raw?: string | null;
      address?: string | null;
      address_raw?: string | null;
      website?: string | null;
      website_raw?: string | null;
    };
    additionalFields?: Array<{
      label: string;
      value: string;
      rawValue?: string;
    }>;
  }

  // Robust JSON parsing with repair fallback
  let parsed: GeminiResponse;
  try {
    parsed = JSON.parse(jsonStr) as GeminiResponse;
  } catch (firstError) {
    console.warn("[Gemini] First JSON parse failed, attempting repair...");

    // Try to extract and repair JSON
    const extractedJson = extractJsonFromResponse(jsonStr);
    if (!extractedJson) {
      throw new Error(`Could not extract JSON from response: ${firstError}`);
    }

    const repaired = repairJson(extractedJson);
    try {
      parsed = JSON.parse(repaired) as GeminiResponse;
      console.log("[Gemini] JSON repair successful");
    } catch (repairError) {
      // Log the raw response for debugging
      console.error("[Gemini] JSON repair failed. Raw response:", jsonStr.substring(0, 500));
      throw new Error(`JSON parse failed even after repair: ${repairError}`);
    }
  }

  // Extract issuer entity (normalize values)
  const issuer = parsed.extracted?.issuer ? {
    name: parsed.extracted.issuer.name || null,
    vatId: normalizeVatId(parsed.extracted.issuer.vatId),
    address: parsed.extracted.issuer.address || null,
    iban: parsed.extracted.issuer.iban || null,
    website: normalizeWebsite(parsed.extracted.issuer.website),
  } : null;

  // Extract recipient entity (normalize values)
  const recipient = parsed.extracted?.recipient ? {
    name: parsed.extracted.recipient.name || null,
    vatId: normalizeVatId(parsed.extracted.recipient.vatId),
    address: parsed.extracted.recipient.address || null,
    iban: parsed.extracted.recipient.iban || null,
    website: normalizeWebsite(parsed.extracted.recipient.website),
  } : null;

  // For backward compatibility, use issuer as partner (will be overridden by extractionCore)
  // This ensures legacy code continues to work during the transition
  const legacyPartner = issuer?.name || parsed.extracted?.partner || null;
  const legacyVatId = issuer?.vatId || normalizeVatId(parsed.extracted?.vatId);
  const legacyIban = issuer?.iban || parsed.extracted?.iban || null;
  const legacyAddress = issuer?.address || parsed.extracted?.address || null;
  const legacyWebsite = issuer?.website || normalizeWebsite(parsed.extracted?.website);
  const lineItems = normalizeLineItems(parsed.extracted?.lineItems || parsed.lineItems || null);

  // Classification is handled by classifyDocument, not here
  const extracted: ExtractedData = {
    date: parsed.extracted?.date || null,
    amount: typeof parsed.extracted?.amount === "number" ? parsed.extracted.amount : null,
    currency: normalizeCurrency(parsed.extracted?.currency),
    vatPercent: typeof parsed.extracted?.vatPercent === "number" ? parsed.extracted.vatPercent : null,
    lineItems,
    partner: legacyPartner,
    vatId: legacyVatId,
    iban: legacyIban,
    address: legacyAddress,
    website: legacyWebsite,
    confidence: typeof parsed.extracted?.confidence === "number" ? parsed.extracted.confidence : 0.5,
    fieldSpans: {},
    // New entity fields
    issuer,
    recipient,
  };

  // Note: Bounding boxes are no longer extracted - using PDF text search instead

  // Extract raw text for issuer
  const issuerRaw = parsed.extracted?.issuer_raw ? {
    name: parsed.extracted.issuer_raw.name || null,
    vatId: parsed.extracted.issuer_raw.vatId || null,
    address: parsed.extracted.issuer_raw.address || null,
    iban: parsed.extracted.issuer_raw.iban || null,
    website: parsed.extracted.issuer_raw.website || null,
  } : null;

  // Extract raw text for recipient
  const recipientRaw = parsed.extracted?.recipient_raw ? {
    name: parsed.extracted.recipient_raw.name || null,
    vatId: parsed.extracted.recipient_raw.vatId || null,
    address: parsed.extracted.recipient_raw.address || null,
    iban: parsed.extracted.recipient_raw.iban || null,
    website: parsed.extracted.recipient_raw.website || null,
  } : null;

  // Extract raw text values for PDF search
  const extractedRaw: ExtractedRawText = {
    date: parsed.extracted?.date_raw || null,
    amount: parsed.extracted?.amount_raw || null,
    vatPercent: parsed.extracted?.vatPercent_raw || null,
    // Use issuer raw as partner raw for backward compatibility
    partner: issuerRaw?.name || parsed.extracted?.partner_raw || null,
    vatId: issuerRaw?.vatId || parsed.extracted?.vatId_raw || null,
    iban: issuerRaw?.iban || parsed.extracted?.iban_raw || null,
    address: issuerRaw?.address || parsed.extracted?.address_raw || null,
    website: issuerRaw?.website || parsed.extracted?.website_raw || null,
    // New entity raw fields
    issuer: issuerRaw,
    recipient: recipientRaw,
  };

  // Extract additional fields
  const additionalFields: ExtractedAdditionalField[] = (parsed.additionalFields || [])
    .filter((f) => f && f.label && f.value)
    .map((f) => ({
      label: f.label,
      value: f.value,
      rawValue: f.rawValue || f.value,
    }));

  if (additionalFields.length > 0) {
    console.log(`  [Gemini] Extracted ${additionalFields.length} additional fields`);
  }

  return {
    extracted,
    rawText: parsed.rawText || "",
    boundingBoxes: [], // Bounding boxes no longer extracted - using PDF text search
    extractedRaw,
    additionalFields,
    usage,
  };
}
