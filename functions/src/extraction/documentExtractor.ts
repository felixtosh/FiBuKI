/**
 * Document Extraction Abstraction Layer
 *
 * Provides a unified interface for document (PDF/image) extraction
 * that can switch between different providers:
 *
 * - "vision-claude": Google Vision API for OCR + Claude Haiku for parsing (original)
 * - "gemini": Gemini Flash for native PDF vision + extraction (new)
 *
 * Set EXTRACTION_PROVIDER environment variable to switch providers.
 */

import { ExtractedData } from "../types/extraction";
import { OCRBlock } from "./visionApi";
import { GeminiBoundingBox, ExtractedRawText, ExtractedAdditionalField } from "./geminiParser";

export type ExtractionProvider = "vision-claude" | "gemini";

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
  /** Token usage for AI calls */
  usage?: { inputTokens: number; outputTokens: number; model: string };
}

export interface ExtractionConfig {
  provider: ExtractionProvider;
  anthropicApiKey?: string;
  // Gemini uses service account auth via Vertex AI (no API key needed)
  geminiModel?: string;
  // Skip two-phase classification (user has overridden AI classification)
  skipClassification?: boolean;
}

/**
 * Get the default extraction provider from environment
 */
export function getDefaultProvider(): ExtractionProvider {
  const provider = process.env.EXTRACTION_PROVIDER;
  if (provider === "gemini" || provider === "vision-claude") {
    return provider;
  }
  // Default to gemini (faster, uses service account auth)
  return "gemini";
}

/**
 * Extract text and structured data from a document
 * Uses the configured provider (vision-claude or gemini)
 */
export async function extractDocument(
  fileBuffer: Buffer,
  fileType: string,
  config: ExtractionConfig
): Promise<ExtractionResult> {
  const provider = config.provider;

  if (provider === "gemini") {
    return extractWithGemini(fileBuffer, fileType, config);
  } else {
    return extractWithVisionClaude(fileBuffer, fileType, config);
  }
}

/**
 * Extract using Google Vision API + Claude Haiku (original approach)
 */
async function extractWithVisionClaude(
  fileBuffer: Buffer,
  fileType: string,
  config: ExtractionConfig
): Promise<ExtractionResult> {
  // Lazy import to avoid loading both providers unnecessarily
  const { callVisionAPI } = await import("./visionApi");
  const { parseWithClaude } = await import("./claudeParser");

  if (!config.anthropicApiKey) {
    throw new Error("Anthropic API key required for vision-claude provider");
  }

  // Step 1: OCR with Vision API
  const ocrResult = await callVisionAPI(fileBuffer, fileType);

  if (!ocrResult.text || ocrResult.text.trim().length === 0) {
    throw new Error("No text extracted from document");
  }

  // Step 2: Parse with Claude Haiku
  const parseResult = await parseWithClaude(ocrResult.text, config.anthropicApiKey);

  return {
    text: ocrResult.text,
    blocks: ocrResult.blocks,
    extracted: parseResult.extracted,
    provider: "vision-claude",
    usage: parseResult.usage,
  };
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
