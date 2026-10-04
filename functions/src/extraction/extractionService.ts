/**
 * The Extraction Service contract (#161).
 *
 * An Extraction Service performs an Extraction end to end: it takes a File's
 * bytes, decides whether the File is a financial document, and returns its
 * transcription. Gemini is the built-in one. A deployment may configure an
 * external one instead, an HTTPS endpoint that owns everything inside the
 * phase (rendering, OCR, a local model). FiBuKI never renders or OCRs.
 *
 * This module is the external half: the configuration, the request and
 * response schemas (published as JSON Schema beside the concept doc, and
 * checked against these by a test), and the one call. What FiBuKI does with
 * the answer is the same for every service: the transcription goes through
 * the same reading as Gemini's reply, so FiBuKI's rules and guards are never
 * delegated.
 *
 * Deliberately not here:
 *  - a fallback. A service that fails fails the Extraction (decision 4);
 *    falling back to Gemini would ship a document off a box whose owner chose
 *    to keep it local.
 *  - identity. The request carries no File id, user id or identity data
 *    (decision 5).
 *  - safeFetch. The URL is the operator's infrastructure, usually on the same
 *    private network, never a user's input (decision 3).
 */

import http from "http";
import https from "https";
import { z } from "zod";
import { sniffMimeType } from "./geminiParser";

/** The contract version this build speaks. A change to either schema is a new version. */
export const EXTRACTION_CONTRACT_VERSION = "1";

/** The #161 contract's default service timeout. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** A reply larger than this is not a transcription. */
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

type Env = Record<string, string | undefined>;

function positiveNumberFromEnv(env: Env, name: string): number | undefined {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ---------------------------------------------------------------------------
// Configuration (decision 3: per deployment, never per user)
// ---------------------------------------------------------------------------

export interface ExternalExtractionServiceConfig {
  url: string;
  /** Sent as `Authorization: Bearer <token>` when set. */
  token: string | null;
  timeoutMs: number;
}

/** True when an external Extraction Service replaces the built-in Gemini. */
export function externalExtractionServiceConfigured(env: Env = process.env): boolean {
  return !!env.FIBUKI_EXTRACTION_SERVICE_URL;
}

/**
 * How long one Extraction may take. The worker marks a File failed after it,
 * and the call to an external service is cut off at the same moment.
 */
export function extractionTimeoutMs(env: Env = process.env): number {
  const seconds = positiveNumberFromEnv(env, "FIBUKI_EXTRACTION_TIMEOUT_SECONDS");
  return seconds ? seconds * 1000 : DEFAULT_TIMEOUT_MS;
}

/**
 * The configured service, or null for the built-in Gemini. A URL that is set
 * but unusable throws: a misconfigured service fails the Extraction, it does
 * not quietly hand the document to Gemini.
 */
export function externalExtractionServiceConfig(env: Env = process.env): ExternalExtractionServiceConfig | null {
  if (!externalExtractionServiceConfigured(env)) return null;
  const raw = (env.FIBUKI_EXTRACTION_SERVICE_URL ?? "").trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("FIBUKI_EXTRACTION_SERVICE_URL is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("FIBUKI_EXTRACTION_SERVICE_URL must be an http or https URL");
  }
  return {
    url: raw,
    token: env.FIBUKI_EXTRACTION_SERVICE_TOKEN?.trim() || null,
    timeoutMs: extractionTimeoutMs(env),
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const text = z.string().nullable().optional();
const cents = z.number().int().nullable().optional().meta({ description: "Cents, as printed." });
const rate = z.number().min(0).max(100).nullable().optional();

const entity = z
  .looseObject({ name: text, vatId: text, address: text, iban: text, website: text, country: text })
  .nullable()
  .optional();

const lineItem = z.looseObject({
  description: text,
  vatPercent: rate,
  vatAmount: cents,
  amount: z.number().int(),
});

const rateGroup = z.looseObject({ rate, net: cents, vat: cents, gross: cents });

const qrEntry = z.union([
  z.string().meta({ description: "A decoded payload, character for character. Read as decodedBy \"model\"." }),
  z.strictObject({
    payload: z.string(),
    decodedBy: z
      .enum(["barcode", "model"])
      .optional()
      .meta({
        description:
          "\"barcode\" when a barcode decoder read the payload, \"model\" when a model transcribed it. Absent means \"model\".",
      }),
  }),
]);

const segment = z.looseObject({
  pages: z.tuple([z.number().int().min(1), z.number().int().min(1)]).meta({ description: "[first, last], 1-based, inclusive." }),
  invoiceNumber: text,
  issuer: text,
  total: cents,
});

const additionalField = z.looseObject({
  key: z.string().meta({ description: "One key of FiBuKI's closed vocabulary; any other key is discarded." }),
  label: z.string(),
  value: z.string(),
  rawValue: text,
});

const extracted = z.looseObject({
  // A calendar date, not only its shape: the core builds the date from its
  // parts, so "2026-13-45" would roll over into a valid day in 2027 and land
  // the document in the wrong UVA period.
  date: z.iso
    .date()
    .nullable()
    .optional()
    .meta({ description: "The issue date, YYYY-MM-DD, a real calendar day." }),
  date_raw: text,
  amount: cents,
  amount_raw: text,
  tipAmount: cents,
  payableAmount: cents,
  currency: text,
  vatPercent: rate,
  vatPercent_raw: text,
  documentVatAmount: cents,
  selfDesignation: text,
  invoiceNumber: text,
  referencedInvoiceNumber: text,
  paidInvoiceNumber: text,
  lineItems: z.array(lineItem).nullable().optional(),
  rateGroups: z.array(rateGroup).nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
  issuer: entity,
  issuer_raw: entity,
  recipient: entity,
  recipient_raw: entity,
  invoicingAgent: entity,
});

/**
 * The transcription: the JSON the built-in Gemini prompt asks for, field for
 * field. Raw spellings ride beside the values (`*_raw`). Unknown keys are
 * allowed and ignored.
 */
export const transcriptionSchema = z
  .looseObject({
    rawText: text,
    extracted: extracted.optional(),
    qrCodes: z.array(qrEntry).optional(),
    segments: z.array(segment).nullable().optional(),
    additionalFields: z.array(additionalField).optional(),
  })
  .meta({ description: "The same JSON the built-in Gemini prompt asks for." });

const serviceIdentity = z
  .strictObject({ name: z.string().min(1).max(200), version: z.string().min(1).max(200) })
  .meta({ description: "The service's own name and version, recorded on every Extraction it produces." });

const usage = z
  .strictObject({ inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0) })
  .optional()
  .meta({ description: "Token counts, logged when present. No cost is computed." });

const contractVersion = z.literal(EXTRACTION_CONTRACT_VERSION);

export const extractionServiceRequestSchema = z
  .strictObject({
    contractVersion,
    file: z.strictObject({
      name: z.string().meta({ description: "The File's name, or empty." }),
      mimeType: z.string().meta({ description: "Sniffed from the bytes." }),
      contentBase64: z.string(),
    }),
    treatAsInvoice: z
      .boolean()
      .meta({ description: "The user overrode the invoice check: the answer must be a transcription." }),
  })
  .meta({ title: "FiBuKI Extraction Service request" });

export const extractionServiceResponseSchema = z
  .discriminatedUnion("outcome", [
    z.looseObject({
      contractVersion,
      service: serviceIdentity,
      outcome: z.literal("transcription"),
      transcription: transcriptionSchema,
      usage,
    }),
    z.looseObject({
      contractVersion,
      service: serviceIdentity,
      outcome: z.literal("notFinancialDocument"),
      reason: z.string().min(1),
      confidence: z.number().min(0).max(1).optional(),
      usage,
    }),
  ])
  .meta({ title: "FiBuKI Extraction Service response" });

export type ExtractionServiceRequest = z.infer<typeof extractionServiceRequestSchema>;
export type ExtractionServiceResponse = z.infer<typeof extractionServiceResponseSchema>;

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/** A failed call. The message is stored on the File: it names no URL, token or document content. */
export class ExtractionServiceError extends Error {
  constructor(message: string) {
    super(`Extraction Service ${message}`);
    this.name = "ExtractionServiceError";
  }
}

/** The request for one File (decision 5: only what transcription needs). */
export function buildExtractionServiceRequest(input: {
  fileBuffer: Buffer;
  declaredType: string | undefined;
  fileName: string | undefined;
  treatAsInvoice: boolean;
}): ExtractionServiceRequest {
  return {
    contractVersion: EXTRACTION_CONTRACT_VERSION,
    file: {
      name: typeof input.fileName === "string" ? input.fileName : "",
      mimeType: sniffMimeType(input.fileBuffer, input.declaredType),
      contentBase64: input.fileBuffer.toString("base64"),
    },
    treatAsInvoice: input.treatAsInvoice,
  };
}

function post(
  config: ExternalExtractionServiceConfig,
  body: string
): Promise<{ status: number; text: string }> {
  const url = new URL(config.url);
  const transport = url.protocol === "https:" ? https : http;
  const headers: Record<string, string | number> = {
    "content-type": "application/json",
    accept: "application/json",
    "content-length": Buffer.byteLength(body),
  };
  if (config.token) headers.authorization = `Bearer ${config.token}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const fail = (error: ExtractionServiceError) => {
      settle(() => reject(error));
      request.destroy();
    };

    const request = transport.request(url, { method: "POST", headers }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          fail(new ExtractionServiceError(`answered more than ${MAX_RESPONSE_BYTES / 1024 / 1024} MB`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () =>
        settle(() => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }))
      );
      response.on("error", () => fail(new ExtractionServiceError("broke off its answer")));
    });

    const timer = setTimeout(
      () => fail(new ExtractionServiceError(`did not answer within ${Math.round(config.timeoutMs / 1000)} seconds`)),
      config.timeoutMs
    );
    request.on("error", (error: NodeJS.ErrnoException) =>
      fail(new ExtractionServiceError(`could not be reached (${error.code ?? "connection error"})`))
    );
    request.end(body);
  });
}

/**
 * One call to the configured service, validated against the contract.
 * Every failure throws an ExtractionServiceError, which fails the Extraction.
 */
export async function callExtractionService(
  config: ExternalExtractionServiceConfig,
  request: ExtractionServiceRequest
): Promise<ExtractionServiceResponse> {
  const { status, text: body } = await post(config, JSON.stringify(request));
  if (status < 200 || status >= 300) {
    throw new ExtractionServiceError(`answered HTTP ${status}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new ExtractionServiceError("response is not JSON");
  }

  const parsed = extractionServiceResponseSchema.safeParse(json);
  if (!parsed.success) {
    // Paths and messages only: zod's messages name the expected type, never
    // the value, so no document content reaches the File's error.
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ExtractionServiceError(`response fails the contract schema (${issues})`);
  }
  return parsed.data;
}
