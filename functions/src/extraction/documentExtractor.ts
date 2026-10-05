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
 * EXTRACTION_PROVIDER is no longer read.
 *
 * #161: Gemini is the built-in Extraction Service. A deployment may configure
 * an external one instead (`FIBUKI_EXTRACTION_SERVICE_URL`), which replaces
 * the whole phase; `createExtractionService` is the one seam where the File's
 * bytes reach either. Both answers go through the same reading
 * (`readTranscription`), so FiBuKI's rules apply whoever transcribed.
 */

import { ExtractedData, OCRBlock } from "../types/extraction";
import {
  GeminiBoundingBox,
  ExtractedRawText,
  ExtractedAdditionalField,
  SplitSegment,
  TranscriptionReading,
} from "./geminiParser";
import {
  EXTRACTION_CONTRACT_VERSION,
  ExtractionServiceError,
  buildExtractionServiceRequest,
  callExtractionService,
  externalExtractionServiceConfig,
  type ExternalExtractionServiceConfig,
  type ExtractionServiceResponse,
} from "./extractionService";

/** Which kind of Extraction Service produced an Extraction (#161). */
export type ExtractionProvider = "gemini" | "external";

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
  /** Separately issued documents read in this File, or null (#550). */
  splitSegments?: SplitSegment[] | null;
  /** Token usage for AI calls */
  usage?: { inputTokens: number; outputTokens: number; model: string };
}

export interface ExtractionConfig {
  provider: ExtractionProvider;
  // Gemini uses service account auth via Vertex AI (no API key needed)
  geminiModel?: string;
  // Skip two-phase classification (user has overridden AI classification)
  skipClassification?: boolean;
}

/**
 * Get the default extraction provider.
 *
 * Gemini, the built-in Extraction Service; EXTRACTION_PROVIDER selects
 * nothing since #170. An external service is chosen by the deployment's
 * configuration in `createExtractionService` (#161), not here.
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
          referencedInvoiceNumber: null,
          paidInvoiceNumber: null,
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

  return { ...resultFromReading(result, "gemini"), usage: result.usage };
}

/**
 * The ExtractionResult for one transcription reading, from any Extraction
 * Service (#161).
 */
function resultFromReading(result: TranscriptionReading, provider: ExtractionProvider): ExtractionResult {
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
    provider,
    isNotInvoice: false, // Classification already passed, or user override
    notInvoiceReason: null,
    geminiBoundingBoxes: result.boundingBoxes,
    extractedRaw: result.extractedRaw,
    additionalFields: result.additionalFields,
    repairAmbiguousFields: result.repairAmbiguousFields,
    splitSegments: result.splitSegments,
  };
}

// ---------------------------------------------------------------------------
// The Extraction Service seam (#161)
// ---------------------------------------------------------------------------

/** What an Extraction records about the service that produced it (#161, decision 6). */
export interface ExtractionProvenance {
  provider: ExtractionProvider;
  /** The service's own name and version; for Gemini, "gemini" and the model id. */
  service: { name: string; version: string };
  contractVersion: string;
}

/** The provenance as stored on the File. */
export function extractionProvenanceFields(provenance: ExtractionProvenance): Record<string, unknown> {
  return {
    extractionProvider: provenance.provider,
    extractionService: { name: provenance.service.name, version: provenance.service.version },
    extractionContractVersion: provenance.contractVersion,
  };
}

/** The invoice check's answer. */
export interface ExtractionClassification {
  isInvoice: boolean;
  reason: string | null;
  confidence: number;
}

/** One AI call to log. `unpriced` calls are logged with no cost (#161, decision 7). */
export interface ExtractionUsage {
  function: "classification" | "extraction";
  model: string;
  inputTokens: number;
  outputTokens: number;
  unpriced?: boolean;
}

export interface ExtractionServiceInput {
  fileBuffer: Buffer;
  /** As stored; the MIME type sent anywhere is sniffed from the bytes. */
  fileType: string;
  fileName: string | undefined;
  geminiModel: string;
  logUsage: (usage: ExtractionUsage) => Promise<void>;
}

/**
 * One File's Extraction, by whichever service the deployment uses.
 *
 * `classify` answers the invoice check; `transcribe` returns the reading, and
 * after a `classify` that already transcribed it returns that reading without
 * another call. `provenance` is known once either has answered.
 */
export interface ExtractionService {
  classify(): Promise<ExtractionClassification>;
  transcribe(): Promise<ExtractionResult>;
  provenance(): ExtractionProvenance;
}

/**
 * The Extraction Service for one File: the configured external one, or the
 * built-in Gemini. Throws when a service URL is set but unusable, never
 * falling back to Gemini (decision 4).
 */
export function createExtractionService(input: ExtractionServiceInput): ExtractionService {
  const external = externalExtractionServiceConfig();
  return external ? externalExtractionService(input, external) : geminiExtractionService(input);
}

/** Gemini: two calls, the invoice check and the transcription, as before #161. */
function geminiExtractionService(input: ExtractionServiceInput): ExtractionService {
  return {
    async classify() {
      const { classifyDocument, DEFAULT_GEMINI_MODEL } = await import("./geminiParser");
      type GeminiModel = import("./geminiParser").GeminiModel;
      const model = (input.geminiModel || DEFAULT_GEMINI_MODEL) as GeminiModel;
      const classification = await classifyDocument(input.fileBuffer, input.fileType, model);
      if (classification.usage) {
        await input.logUsage({ function: "classification", ...classification.usage });
      }
      return {
        isInvoice: classification.isInvoice,
        reason: classification.reason,
        confidence: classification.confidence,
      };
    },
    async transcribe() {
      const result = await extractDocument(input.fileBuffer, input.fileType, {
        provider: "gemini",
        geminiModel: input.geminiModel,
        skipClassification: true, // classified by `classify`, or overridden by the user
      });
      if (result.usage) {
        await input.logUsage({ function: "extraction", ...result.usage });
      }
      return result;
    },
    provenance() {
      return {
        provider: "gemini",
        service: { name: "gemini", version: input.geminiModel },
        contractVersion: EXTRACTION_CONTRACT_VERSION,
      };
    },
  };
}

/**
 * An external service: one call answers both the invoice check and the
 * transcription (decision 2). The user's override travels as `treatAsInvoice`.
 */
function externalExtractionService(
  input: ExtractionServiceInput,
  config: ExternalExtractionServiceConfig
): ExtractionService {
  let answer: ExtractionServiceResponse | null = null;
  let transcribed: ExtractionResult | null = null;

  async function call(treatAsInvoice: boolean): Promise<ExtractionServiceResponse> {
    const request = buildExtractionServiceRequest({
      fileBuffer: input.fileBuffer,
      declaredType: input.fileType,
      fileName: input.fileName,
      treatAsInvoice,
    });
    const tCall = Date.now();
    const response = await callExtractionService(config, request);
    console.log(
      `  [ExtractionService] ${response.service.name} ${response.service.version} answered ` +
      `${response.outcome} in ${Date.now() - tCall}ms`
    );
    answer = response;
    await input.logUsage({
      function: "extraction",
      model: response.service.name,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
      unpriced: true,
    });
    return response;
  }

  async function read(response: Extract<ExtractionServiceResponse, { outcome: "transcription" }>) {
    const { readTranscription } = await import("./geminiParser");
    // The same reading as Gemini's reply. Already valid JSON, so the repair
    // fallback never runs and nothing is reported as guessed at.
    return resultFromReading(readTranscription(JSON.stringify(response.transcription)), "external");
  }

  return {
    async classify() {
      const response = await call(false);
      if (response.outcome === "notFinancialDocument") {
        return {
          isInvoice: false,
          reason: response.reason,
          // Gemini's invoice check reads a missing confidence the same way.
          confidence: response.confidence ?? 0.5,
        };
      }
      transcribed = await read(response);
      return { isInvoice: true, reason: null, confidence: transcribed.extracted.confidence };
    },
    async transcribe() {
      if (transcribed) return transcribed;
      const response = await call(true);
      if (response.outcome !== "transcription") {
        throw new ExtractionServiceError(
          "answered \"not a financial document\" to a request with treatAsInvoice: the user's override needs a transcription"
        );
      }
      transcribed = await read(response);
      return transcribed;
    },
    provenance() {
      if (!answer) throw new Error("Extraction Service provenance read before it answered");
      return {
        provider: "external",
        service: { name: answer.service.name, version: answer.service.version },
        contractVersion: answer.contractVersion,
      };
    },
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
