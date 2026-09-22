/**
 * #281 split `sniffMimeType` into a strict magic-number sniffer plus the
 * fallback it always had. The fallback is right for extraction, which needs
 * *some* MIME type for one model call and throws it away, and wrong for the
 * backfill, which writes it to the record forever. These tests pin both halves:
 * the fallback still fires for the extraction caller, and the strict half says
 * "I don't know" instead.
 */

import { describe, it, expect } from "vitest";
import { sniffMimeType, sniffMimeTypeStrict } from "../geminiParser";

const pad = (head: Buffer) => Buffer.concat([head, Buffer.alloc(20)]);

const PDF = pad(Buffer.from("%PDF-1.4\n"));
const PNG = pad(Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG")]));
const JPEG = pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
const GIF = pad(Buffer.from("GIF89a"));
const WEBP = pad(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]));
// An OOXML container (.docx/.xlsx) — a real file with no magic number we know.
const DOCX = pad(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

describe("sniffMimeTypeStrict", () => {
  it("names the formats it recognises by magic number", () => {
    expect(sniffMimeTypeStrict(PDF)).toBe("application/pdf");
    expect(sniffMimeTypeStrict(PNG)).toBe("image/png");
    expect(sniffMimeTypeStrict(JPEG)).toBe("image/jpeg");
    expect(sniffMimeTypeStrict(GIF)).toBe("image/gif");
    expect(sniffMimeTypeStrict(WEBP)).toBe("image/webp");
  });

  it("returns undefined for bytes it cannot name, rather than guessing", () => {
    expect(sniffMimeTypeStrict(DOCX)).toBeUndefined();
    expect(sniffMimeTypeStrict(Buffer.from("hello"))).toBeUndefined();
    expect(sniffMimeTypeStrict(Buffer.alloc(0))).toBeUndefined();
  });
});

describe("sniffMimeType (unchanged for the extraction caller)", () => {
  it("still prefers the magic number over a wrong declared type", () => {
    expect(sniffMimeType(PDF, "image/png")).toBe("application/pdf");
    expect(sniffMimeType(PNG, "application/pdf")).toBe("image/png");
  });

  it("still falls back to a declared type Gemini accepts", () => {
    expect(sniffMimeType(DOCX, "application/pdf")).toBe("application/pdf");
    expect(sniffMimeType(DOCX, " image/png ")).toBe("image/png");
  });

  it("still returns image/jpeg for unrecognised bytes with no usable declared type", () => {
    expect(sniffMimeType(DOCX)).toBe("image/jpeg");
    expect(sniffMimeType(DOCX, "application/vnd.openxmlformats-officedocument")).toBe("image/jpeg");
    expect(sniffMimeType(Buffer.alloc(0))).toBe("image/jpeg");
  });
});
