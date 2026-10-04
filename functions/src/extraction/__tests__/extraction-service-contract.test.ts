/**
 * #161: the Extraction Service contract, without a network.
 *
 * The contract is published as two JSON Schemas beside its concept doc. The
 * code validates with the zod schemas they are generated from, so the first
 * block fails when the two drift apart (regenerate with
 * `UPDATE_EXTRACTION_SERVICE_SCHEMA=1` and review the diff: a change to a
 * published schema is a contract change).
 *
 * The end-to-end behaviour against a fake service lives in
 * `selfhost/extraction-service.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import {
  EXTRACTION_CONTRACT_VERSION,
  buildExtractionServiceRequest,
  externalExtractionServiceConfig,
  externalExtractionServiceConfigured,
  extractionServiceRequestSchema,
  extractionServiceResponseSchema,
  extractionTimeoutMs,
} from "../extractionService";
import { parseQrPayloads } from "../qrCodes";

const SCHEMA_DIR = join(__dirname, "../../../../docs/extraction-service");

const RKSV = "_R1-AT0_K1_42_2026-01-02T10:00:00_12,00_0,00_0,00_0,00_0,00_x_y_z_sig";

function transcriptionResponse(transcription: Record<string, unknown>) {
  return {
    contractVersion: EXTRACTION_CONTRACT_VERSION,
    service: { name: "fake", version: "1" },
    outcome: "transcription",
    transcription,
  };
}

describe("the published schemas", () => {
  for (const [file, schema] of [
    ["request.schema.json", extractionServiceRequestSchema],
    ["response.schema.json", extractionServiceResponseSchema],
  ] as const) {
    it(`${file} is what the code validates against`, () => {
      const generated = JSON.stringify(z.toJSONSchema(schema), null, 2) + "\n";
      const path = join(SCHEMA_DIR, file);
      if (process.env.UPDATE_EXTRACTION_SERVICE_SCHEMA === "1") writeFileSync(path, generated);
      expect(readFileSync(path, "utf8")).toBe(generated);
    });
  }
});

describe("response schema", () => {
  it("accepts a transcription with both QR entry shapes", () => {
    const parsed = extractionServiceResponseSchema.safeParse(
      transcriptionResponse({
        rawText: "Rechnung",
        extracted: { amount: 1200, currency: "EUR" },
        qrCodes: [RKSV, { payload: RKSV, decodedBy: "barcode" }, { payload: RKSV }, { payload: RKSV, decodedBy: "model" }],
      })
    );
    expect(parsed.success).toBe(true);
  });

  it("limits decodedBy to barcode and model", () => {
    const parsed = extractionServiceResponseSchema.safeParse(
      transcriptionResponse({ qrCodes: [{ payload: RKSV, decodedBy: "ocr" }] })
    );
    expect(parsed.success).toBe(false);
  });

  it("accepts not a financial document with a reason", () => {
    const parsed = extractionServiceResponseSchema.safeParse({
      contractVersion: EXTRACTION_CONTRACT_VERSION,
      service: { name: "fake", version: "1" },
      outcome: "notFinancialDocument",
      reason: "Bank statement",
    });
    expect(parsed.success).toBe(true);
  });

  it("requires the service to name itself and its version", () => {
    const response = transcriptionResponse({}) as Record<string, unknown>;
    expect(extractionServiceResponseSchema.safeParse({ ...response, service: { name: "fake" } }).success).toBe(false);
    delete response.service;
    expect(extractionServiceResponseSchema.safeParse(response).success).toBe(false);
  });

  it("refuses another contract version", () => {
    expect(
      extractionServiceResponseSchema.safeParse({ ...transcriptionResponse({}), contractVersion: "2" }).success
    ).toBe(false);
  });

  it("refuses money that is not whole cents", () => {
    expect(
      extractionServiceResponseSchema.safeParse(transcriptionResponse({ extracted: { amount: "12,00" } })).success
    ).toBe(false);
    expect(
      extractionServiceResponseSchema.safeParse(transcriptionResponse({ extracted: { amount: 12.5 } })).success
    ).toBe(false);
  });

  it("accepts optional token counts and nothing negative", () => {
    const ok = { ...transcriptionResponse({}), usage: { inputTokens: 10, outputTokens: 2 } };
    expect(extractionServiceResponseSchema.safeParse(ok).success).toBe(true);
    const bad = { ...transcriptionResponse({}), usage: { inputTokens: -1, outputTokens: 2 } };
    expect(extractionServiceResponseSchema.safeParse(bad).success).toBe(false);
  });
});

describe("a QR entry's decodedBy", () => {
  it("is stored as model for a plain string and for an object without it", () => {
    const codes = parseQrPayloads([RKSV, { payload: RKSV }]);
    expect(codes.map((code) => code.decodedBy)).toEqual(["model", "model"]);
  });

  it("is stored as barcode when the service says a decoder read it", () => {
    const [code] = parseQrPayloads([{ payload: RKSV, decodedBy: "barcode" }]);
    expect(code).toMatchObject({ format: "rksv", decodedBy: "barcode" });
  });

  it("never reads an unknown value as a deterministic read", () => {
    const [code] = parseQrPayloads([{ payload: RKSV, decodedBy: "scanner" }]);
    expect(code.decodedBy).toBe("model");
  });

  it("survives a second parse of a stored code", () => {
    const stored = parseQrPayloads([{ payload: RKSV, decodedBy: "barcode" }]);
    expect(parseQrPayloads(stored)[0].decodedBy).toBe("barcode");
  });
});

describe("configuration", () => {
  it("is absent without a URL", () => {
    expect(externalExtractionServiceConfigured({})).toBe(false);
    expect(externalExtractionServiceConfig({})).toBeNull();
  });

  it("reads the URL, the optional token and the timeout", () => {
    expect(
      externalExtractionServiceConfig({
        FIBUKI_EXTRACTION_SERVICE_URL: "http://ocr.local:9000/extract",
        FIBUKI_EXTRACTION_SERVICE_TOKEN: "secret",
        FIBUKI_EXTRACTION_TIMEOUT_SECONDS: "600",
      })
    ).toEqual({ url: "http://ocr.local:9000/extract", token: "secret", timeoutMs: 600_000 });
    expect(
      externalExtractionServiceConfig({ FIBUKI_EXTRACTION_SERVICE_URL: "https://ocr.example/x" })
    ).toEqual({ url: "https://ocr.example/x", token: null, timeoutMs: 300_000 });
  });

  it("refuses a URL that is not http(s) rather than falling back to Gemini", () => {
    const env = { FIBUKI_EXTRACTION_SERVICE_URL: "file:///etc/passwd" };
    expect(externalExtractionServiceConfigured(env)).toBe(true);
    expect(() => externalExtractionServiceConfig(env)).toThrow(/FIBUKI_EXTRACTION_SERVICE_URL/);
  });

  it("defaults the timeout to five minutes", () => {
    expect(extractionTimeoutMs({})).toBe(300_000);
    expect(extractionTimeoutMs({ FIBUKI_EXTRACTION_TIMEOUT_SECONDS: "x" })).toBe(300_000);
  });
});

describe("the request", () => {
  it("carries only the bytes, the sniffed MIME type, the file name, treatAsInvoice and the version", () => {
    const pdf = Buffer.from("%PDF-1.4\n%fake pdf body");
    const request = buildExtractionServiceRequest({
      fileBuffer: pdf,
      declaredType: "image/jpeg",
      fileName: "rechnung.pdf",
      treatAsInvoice: true,
    });
    expect(request).toEqual({
      contractVersion: EXTRACTION_CONTRACT_VERSION,
      file: { name: "rechnung.pdf", mimeType: "application/pdf", contentBase64: pdf.toString("base64") },
      treatAsInvoice: true,
    });
    expect(extractionServiceRequestSchema.safeParse(request).success).toBe(true);
  });

  it("sends an empty name when the File has none", () => {
    const request = buildExtractionServiceRequest({
      fileBuffer: Buffer.from("x"),
      declaredType: undefined,
      fileName: undefined,
      treatAsInvoice: false,
    });
    expect(request.file.name).toBe("");
  });
});
