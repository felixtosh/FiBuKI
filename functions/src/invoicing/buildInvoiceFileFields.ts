/**
 * Shared helper used by issueInvoice + regenerateInvoicePdf to produce the
 * TaxFile field set for a Fibuki-generated invoice file. Keeps the two
 * paths in lockstep so post-issue edits stay reflected on the file record
 * (fileName, extractedAmount, line items, etc.).
 *
 * `draftFileStubFields` is the other end: the TaxFile a draft carries before
 * any PDF exists, written by createInvoice and restored by undoIssueInvoice.
 */

import { Timestamp } from "firebase-admin/firestore";
import { Invoice } from "./types";
import { invoiceSupplyKind } from "./supplyAbroad";
import { generatedInvoiceFileFacts } from "../fileFacts/factChange";

/** The placeholder number a draft shows until it is issued. */
export function draftPlaceholderNumber(): string {
  return `DRAFT-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
}

/**
 * The stub TaxFile of a draft invoice. The PDF does not exist yet
 * (storagePath/downloadUrl empty); issueInvoice fills this same doc in place.
 *
 * extractionComplete=true + isFibukiGenerated=true short-circuits the
 * extractFileData onCreate trigger (see functions/src/extraction/extractFileData.ts).
 */
export function draftFileStubFields(invoiceId: string): Record<string, unknown> {
  return {
    fileName: "Rechnungsentwurf",
    fileType: "application/pdf",
    fileSize: 0,
    storagePath: "",
    downloadUrl: "",
    extractionComplete: true,
    classificationComplete: true,
    isNotInvoice: false,
    isFibukiGenerated: true,
    sourceType: "fibuki_invoice",
    invoiceId,
    // The User is the issuer; the File facts module writes it (#640).
    ...generatedInvoiceFileFacts(null),
  };
}

interface BuildOptions {
  storagePath: string;
  downloadUrl: string;
  fileSize: number;
}

export function buildInvoiceFileFields(
  invoice: Invoice,
  opts: BuildOptions,
): Record<string, unknown> {
  const now = Timestamp.now();
  return {
    fileName: `${invoice.number}.pdf`,
    fileType: "application/pdf",
    fileSize: opts.fileSize,
    storagePath: opts.storagePath,
    downloadUrl: opts.downloadUrl,
    classificationComplete: true,
    isNotInvoice: false,
    isFibukiGenerated: true,
    invoiceId: invoice.id,
    // The figures and parties the PDF prints, as the File facts module
    // writes them (#640).
    ...generatedInvoiceFileFacts(invoice, now),
    // What the UVA reads before any detection (#565). Null clears it when the
    // setting is turned off and the PDF regenerated.
    invoiceSupplyKind: invoiceSupplyKind(invoice),
    updatedAt: now,
  };
}
