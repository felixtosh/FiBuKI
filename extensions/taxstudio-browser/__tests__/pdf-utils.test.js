/**
 * Tests for PDF utility functions
 */

const {
  isPdfMagic,
  isPdfContentType,
  hasPdfFilename,
  extractFilenameFromDisposition,
  extractFilenameFromUrl,
  guessFilename,
} = require("../lib/pdf-utils");

describe("PDF Utils", () => {
  describe("isPdfMagic", () => {
    it("recognizes PDF magic bytes %PDF", () => {
      // %PDF in bytes: 0x25, 0x50, 0x44, 0x46
      const pdfBuffer = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
      expect(isPdfMagic(pdfBuffer)).toBe(true);
    });

    it("works with ArrayBuffer", () => {
      const buffer = new ArrayBuffer(6);
      const view = new Uint8Array(buffer);
      view[0] = 0x25; // %
      view[1] = 0x50; // P
      view[2] = 0x44; // D
      view[3] = 0x46; // F
      expect(isPdfMagic(buffer)).toBe(true);
    });

    it("rejects non-PDF content", () => {
      // <html in bytes
      const htmlBuffer = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c]);
      expect(isPdfMagic(htmlBuffer)).toBe(false);
    });

    it("rejects PNG content", () => {
      // PNG header: 0x89, P, N, G
      const pngBuffer = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      expect(isPdfMagic(pngBuffer)).toBe(false);
    });

    it("rejects JPEG content", () => {
      // JPEG header: 0xFF, 0xD8, 0xFF
      const jpegBuffer = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      expect(isPdfMagic(jpegBuffer)).toBe(false);
    });

    it("returns false for empty/short buffers", () => {
      expect(isPdfMagic(new Uint8Array([]))).toBe(false);
      expect(isPdfMagic(new Uint8Array([0x25, 0x50]))).toBe(false);
      expect(isPdfMagic(null)).toBe(false);
      expect(isPdfMagic(undefined)).toBe(false);
    });
  });

  describe("isPdfContentType", () => {
    it("accepts application/pdf", () => {
      expect(isPdfContentType("application/pdf")).toBe(true);
    });

    it("accepts application/pdf with charset", () => {
      expect(isPdfContentType("application/pdf; charset=utf-8")).toBe(true);
    });

    it("accepts case variations", () => {
      expect(isPdfContentType("APPLICATION/PDF")).toBe(true);
      expect(isPdfContentType("Application/Pdf")).toBe(true);
    });

    it("rejects text/html", () => {
      expect(isPdfContentType("text/html")).toBe(false);
    });

    it("rejects image types", () => {
      expect(isPdfContentType("image/png")).toBe(false);
      expect(isPdfContentType("image/jpeg")).toBe(false);
    });

    it("returns false for empty/null", () => {
      expect(isPdfContentType("")).toBe(false);
      expect(isPdfContentType(null)).toBe(false);
      expect(isPdfContentType(undefined)).toBe(false);
    });
  });

  describe("hasPdfFilename", () => {
    it("detects .pdf in disposition", () => {
      expect(hasPdfFilename('attachment; filename="invoice.pdf"')).toBe(true);
      expect(hasPdfFilename("attachment; filename=document.pdf")).toBe(true);
    });

    it("handles case variations", () => {
      expect(hasPdfFilename('attachment; filename="INVOICE.PDF"')).toBe(true);
    });

    it("returns false for non-PDF filenames", () => {
      expect(hasPdfFilename('attachment; filename="data.csv"')).toBe(false);
      expect(hasPdfFilename('attachment; filename="image.png"')).toBe(false);
    });

    it("returns false for empty/null", () => {
      expect(hasPdfFilename("")).toBe(false);
      expect(hasPdfFilename(null)).toBe(false);
    });
  });

  describe("extractFilenameFromDisposition", () => {
    it('extracts filename from filename="..."', () => {
      expect(
        extractFilenameFromDisposition('attachment; filename="invoice-2024.pdf"')
      ).toBe("invoice-2024.pdf");
    });

    it("extracts filename from filename=... (unquoted)", () => {
      expect(
        extractFilenameFromDisposition("attachment; filename=invoice.pdf")
      ).toBe("invoice.pdf");
    });

    it("extracts from RFC 5987 extended notation", () => {
      expect(
        extractFilenameFromDisposition(
          "attachment; filename*=utf-8''invoice%20document.pdf"
        )
      ).toBe("invoice document.pdf");
    });

    it("handles complex disposition headers", () => {
      expect(
        extractFilenameFromDisposition(
          'attachment; filename="fallback.pdf"; filename*=utf-8\'\'preferred.pdf'
        )
      ).toBe("preferred.pdf");
    });

    it("returns null for missing filename", () => {
      expect(extractFilenameFromDisposition("attachment")).toBe(null);
      expect(extractFilenameFromDisposition("inline")).toBe(null);
    });

    it("returns null for empty/null", () => {
      expect(extractFilenameFromDisposition("")).toBe(null);
      expect(extractFilenameFromDisposition(null)).toBe(null);
    });
  });

  describe("extractFilenameFromUrl", () => {
    it("extracts filename from URL path", () => {
      expect(
        extractFilenameFromUrl("https://example.com/docs/invoice.pdf")
      ).toBe("invoice.pdf");
    });

    it("handles URL-encoded filenames", () => {
      expect(
        extractFilenameFromUrl(
          "https://example.com/docs/my%20invoice.pdf"
        )
      ).toBe("my invoice.pdf");
    });

    it("returns null for URLs without filename-like paths", () => {
      expect(extractFilenameFromUrl("https://example.com/download")).toBe(null);
      expect(extractFilenameFromUrl("https://example.com/")).toBe(null);
    });

    it("returns null for invalid URLs", () => {
      expect(extractFilenameFromUrl("not-a-url")).toBe(null);
      expect(extractFilenameFromUrl("")).toBe(null);
      expect(extractFilenameFromUrl(null)).toBe(null);
    });
  });

  describe("guessFilename", () => {
    it("prefers Content-Disposition over URL", () => {
      expect(
        guessFilename(
          "https://example.com/download/123.pdf",
          'attachment; filename="invoice-2024.pdf"'
        )
      ).toBe("invoice-2024.pdf");
    });

    it("falls back to URL when no disposition", () => {
      expect(
        guessFilename("https://example.com/docs/receipt.pdf", "")
      ).toBe("receipt.pdf");
    });

    it("returns default when nothing available", () => {
      expect(guessFilename("https://example.com/download", "")).toBe(
        "invoice.pdf"
      );
      expect(guessFilename("", "")).toBe("invoice.pdf");
    });
  });
});
