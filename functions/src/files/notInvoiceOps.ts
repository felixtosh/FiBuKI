/**
 * "Not an invoice" state transitions, shared by the callables and the MCP tools.
 *
 * The callables (markFileAsNotInvoice / unmarkFileAsNotInvoice) drive the UI
 * buttons; the tool handlers of the same name drive the MCP surface. Both must
 * write the identical field set, or a file flagged by an agent and a file
 * flagged by a click end up in different states — so the update objects are
 * built here and nowhere else.
 */

import { FieldValue } from "firebase-admin/firestore";

/**
 * Fields the transition reads. Deliberately narrow: everything else on the
 * file document is irrelevant to the decision.
 */
export interface NotInvoiceFileState {
  partnerMatchedBy?: string | null;
}

/**
 * Marking a file as "not an invoice" clears the extracted data, because there
 * is nothing to extract from a document that is not an invoice, and resets the
 * downstream partner/transaction matching that was derived from it.
 *
 * A manually-set partner survives: the user chose it, and the classification
 * being wrong does not make that choice wrong.
 */
export function buildMarkNotInvoiceUpdates(
  fileData: NotInvoiceFileState,
  reason?: string
): Record<string, unknown> {
  const updates: Record<string, unknown> = {
    isNotInvoice: true,
    notInvoiceReason: reason || "Marked by user",
    classificationComplete: true,
    // Clear all extracted data since it's not an invoice
    extractedDate: null,
    extractedAmount: null,
    extractedCurrency: null,
    extractedVatPercent: null,
    extractedVatAmount: null,
    extractedLineItems: null,
    extractedPartner: null,
    extractedVatId: null,
    extractedIban: null,
    extractedAddress: null,
    extractedText: null,
    extractedRaw: null,
    extractedAdditionalFields: null,
    extractedFields: null,
    extractionConfidence: null,
    invoiceDirection: null,
    // Mark extraction as complete (nothing to extract for non-invoices)
    extractionComplete: true,
    // Reset downstream matching
    partnerMatchComplete: false,
    partnerSuggestions: [],
    transactionMatchComplete: false,
    transactionSuggestions: [],
    updatedAt: FieldValue.serverTimestamp(),
  };

  // Only clear partner if NOT manually set (preserve user's intentional choice)
  if (fileData.partnerMatchedBy !== "manual") {
    updates.partnerId = null;
    updates.partnerType = null;
    updates.partnerMatchedBy = null;
    updates.partnerMatchConfidence = null;
  }

  return updates;
}

/**
 * Unmarking restores the file as an invoice and re-opens extraction, which is
 * what recovers the data `buildMarkNotInvoiceUpdates` cleared.
 *
 * `hasManualConnections` says whether the file is manually connected to at
 * least one transaction. When it is, transaction matching is left alone —
 * re-running it would discard a connection a human made by hand.
 */
export function buildUnmarkNotInvoiceUpdates(
  fileData: NotInvoiceFileState,
  hasManualConnections: boolean
): Record<string, unknown> {
  const updates: Record<string, unknown> = {
    isNotInvoice: false,
    notInvoiceReason: null,
    // Skip classification - user has confirmed it's an invoice
    classificationComplete: true,
    // Reset extraction to trigger re-extraction
    extractionComplete: false,
    extractionError: null,
    updatedAt: FieldValue.serverTimestamp(),
  };

  // Only reset partner if NOT manually set (preserve user's intentional choice)
  if (fileData.partnerMatchedBy !== "manual") {
    updates.partnerId = null;
    updates.partnerType = null;
    updates.partnerMatchedBy = null;
    updates.partnerMatchConfidence = null;
    updates.partnerMatchComplete = false;
    updates.partnerSuggestions = [];
  }

  // Only reset transaction matching if no manual connections exist
  if (!hasManualConnections) {
    updates.transactionMatchComplete = false;
    updates.transactionSuggestions = [];
  }

  return updates;
}
