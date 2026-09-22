/**
 * Document Extraction Abstraction Layer
 *
 * Provides a unified interface for document (PDF/image) extraction.
 *
 * Gemini is the only provider. The original "vision-claude" path (Google Vision
 * OCR + Claude Haiku) was retired in #170: no configuration in this repository
 * ever selected it, no test asserted parity with Gemini, and it extracted
 * neither Line Items nor the printed per-rate VAT summary — so a multi-rate
 * document that went through it carried a single top-level rate and the UVA
 * derivation over-claimed one rate group while under-claiming the other.
 *
 * EXTRACTION_PROVIDER is no longer read; nothing routes anywhere but Gemini.
 */

import { ExtractedData } from "../types/extraction";
import { OCRBlock } from "./visionApi";
import { GeminiBoundingBox, ExtractedRawText, ExtractedAdditionalField } from "./geminiParser";

export type ExtractionProvider = "gemini";

export interface ExtractionResult {
  text: string;
  blocks: OCRBlock[]; // Empty for Gemini (uses geminiBoundingBoxes instead)
  extracted: ExtractedData;
  provider: ExtractionProvider;
  /** Document classified as not an invoice (tax form, spam, etc.) */
  isNotInvoice?: boolean;
  /** Reason for not being an invoice */
  notInvoiceReason?: string | null;
  /** Bounding boxes from Gemini (native vision) */
  geminiBoundingBoxes?: GeminiBoundingBox[];
  /** Raw text for each field as it appears in the document (for PDF search) */
  extractedRaw?: ExtractedRawText;
  /** Additional fields extracted beyond standard invoice fields */
  additionalFields?: ExtractedAdditionalField[];
  /**
   * Fields the JSON repair had to read through an ambiguous escape (#275).
   * Carried up so the stored record can say a value was guessed at; the
   * vision-claude path never repairs, so it never sets this.
   */
  repairAmbiguousFields?: string[];
  /** Token usage for AI calls */
  usage?: { inputTokens: number; outputTokens: number; model: string };
}

export interface ExtractionConfig {
  provider: ExtractionProvider;
  /**
   * Unused by extraction since the vision-claude path was retired (#170) —
   * nothing downstream of here reads it. The callables that run extraction
   * still declare the ANTHROPIC_API_KEY secret and hand it down; unwiring that
   * plumbing is a separate change.
   */
  anthropicApiKey?: string;
  // Gemini uses service account auth via Vertex AI (no API key needed)
  geminiModel?: string;
  // Skip two-phase classification (user has overridden AI classification)
  skipClassification?: boolean;
}

/**
 * Get the default extraction provider.
 *
 * Gemini, always — there is nothing else to select since #170.
 */
export function getDefaultProvider(): ExtractionProvider {
  return "gemini";
}

/**
 * Extract text and structured data from a document
 */
export async function extractDocument(
  fileBuffer: Buffer,
  fileType: string,
  config: ExtractionConfig
): Promise<ExtractionResult> {
  return extractWithGemini(fileBuffer, fileType, config);
}

/**
 * Extract using Gemini Flash (native PDF vision)
 * Classification is separate from extraction:
 * 1. classifyDocument determines if it's an invoice (unless skipClassification)
 * 2. parseWithGemini extracts data (assumes document is valid)
 */
async function extractWithGemini(
  fileBuffer: Buffer,
  fileType: string,
  config: ExtractionConfig
): Promise<ExtractionResult> {
  const {
    parseWithGemini,
    classifyDocument,
    DEFAULT_GEMINI_MODEL,
  } = await import("./geminiParser");
  type GeminiModel = import("./geminiParser").GeminiModel;

  // Gemini uses service account auth via Vertex AI (no API key needed)
  const model = (config.geminiModel || DEFAULT_GEMINI_MODEL) as GeminiModel;

  // Classification phase - skip if user has already confirmed it's an invoice
  if (!config.skipClassification) {
    console.log(`  [Classification] Checking if document is a valid invoice...`);

    const classification = await classifyDocument(fileBuffer, fileType, model);

    if (!classification.isInvoice) {
      console.log(`  [Classification] Not an invoice: ${classification.reason}`);
      // Return early without full extraction
      return {
        text: "(classification only - not an invoice)",
        blocks: [],
        extracted: {
          date: null,
          amount: null,
          payableAmount: null,
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
          confidence: classification.confidence,
          fieldSpans: {},
        },
        provider: "gemini",
        isNotInvoice: true,
        notInvoiceReason: classification.reason,
      };
    }

    console.log(`  [Classification] Valid invoice, proceeding with extraction`);
  } else {
    console.log(`  [Skip-Classification] User override - treating as invoice`);
  }

  // Extraction phase - parseWithGemini only extracts, no classification
  const result = await parseWithGemini(fileBuffer, fileType, model);

  // Use rawText if available, otherwise generate from extracted data
  // Gemini Flash Lite sometimes omits rawText to save tokens
  let text = result.rawText || "";
  if (!text.trim()) {
    // Generate fallback text from extracted fields for display
    const parts: string[] = [];
    const e = result.extracted;
    if (e.partner) parts.push(e.partner);
    if (e.date) parts.push(e.date);
    if (e.amount !== null) {
      const amt = (e.amount / 100).toFixed(2).replace(".", ",");
      parts.push(`${amt} ${e.currency || "EUR"}`);
    }
    if (e.address) parts.push(e.address);
    if (e.vatId) parts.push(e.vatId);
    if (e.iban) parts.push(e.iban);
    text = parts.join("\n") || "(no text extracted)";
  }

  // Only fail if we got no useful data at all
  const hasUsefulData =
    result.extracted.partner ||
    result.extracted.amount !== null ||
    result.extracted.date ||
    text.trim().length > 0;

  if (!hasUsefulData) {
    throw new Error("No text or data extracted from document");
  }

  return {
    text,
    blocks: [], // Gemini native vision uses geminiBoundingBoxes instead
    extracted: result.extracted,
    provider: "gemini",
    isNotInvoice: false, // Classification already passed, or user override
    notInvoiceReason: null,
    geminiBoundingBoxes: result.boundingBoxes,
    extractedRaw: result.extractedRaw,
    additionalFields: result.additionalFields,
    repairAmbiguousFields: result.repairAmbiguousFields,
    usage: result.usage,
  };
}

/**
 * Generate fake OCR blocks from extracted text for Gemini
 * This provides basic text search capability when bounding boxes aren't available
 */
export function generateTextBlocks(text: string): OCRBlock[] {
  // Split text into paragraphs/lines and create simple blocks
  const lines = text.split(/\n+/).filter((line) => line.trim());

  return lines.map((line) => ({
    text: line.trim(),
    boundingBox: { vertices: [] }, // No position info from Gemini
    confidence: 1.0,
  }));
}
