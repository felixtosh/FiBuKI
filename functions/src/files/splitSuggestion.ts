/**
 * The split suggestion an Extraction stores on a File (#550): the
 * separately issued invoices or Receipts it read, by page range. The User
 * confirms, adjusts or dismisses it; nothing splits on its own.
 */

import { PDFDocument } from "pdf-lib";
import type { SplitSegment } from "../extraction/geminiParser";

export interface SplitSuggestion {
  segments: SplitSegment[];
  pageCount: number;
}

/** The page count of a PDF, or null for anything that is not a readable PDF. */
export async function pdfPageCount(bytes: Buffer): Promise<number | null> {
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return null;
  try {
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return pdf.getPageCount();
  } catch {
    return null;
  }
}

/**
 * What an Extraction stores as the File's split suggestion: null when the
 * User said "not a bundle", when the File is not a PDF of two or more pages,
 * or when the segments do not fit its pages (out of range or overlapping).
 * A gap is kept: the User fills it in before confirming.
 */
export function splitSuggestionFor(
  segments: SplitSegment[] | null | undefined,
  pageCount: number | null,
  dismissed: boolean
): SplitSuggestion | null {
  if (dismissed || !segments || segments.length < 2) return null;
  if (pageCount === null || pageCount < 2) return null;
  let lastTo = 0;
  for (const { pages: [from, to] } of segments) {
    if (from <= lastTo || to > pageCount) return null;
    lastTo = to;
  }
  return { segments, pageCount };
}
