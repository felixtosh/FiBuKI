import { Timestamp } from "firebase-admin/firestore";

/**
 * The fields a retry clears before extraction re-runs.
 *
 * Partner and transaction matching are reset because both derive from the
 * extracted data — leaving them would pin the file to conclusions drawn from
 * the output being replaced. A manual partner assignment survives: the user
 * decided that, not the matcher.
 */
export function buildRetryResetUpdates(fileData: {
  partnerMatchedBy?: unknown;
}): Record<string, unknown> {
  const resetData: Record<string, unknown> = {
    extractionComplete: false,
    extractionError: null,
    // Back to "Queued" until a worker claims it.
    extractionStartedAt: null,
    isNotInvoice: null,
    notInvoiceReason: null,
    partnerMatchComplete: false,
    partnerMatchedAt: null,
    partnerSuggestions: [],
    transactionMatchComplete: false,
    transactionMatchedAt: null,
    transactionSuggestions: [],
    updatedAt: Timestamp.now(),
  };

  if (fileData.partnerMatchedBy !== "manual") {
    resetData.partnerId = null;
    resetData.partnerType = null;
    resetData.partnerMatchedBy = null;
    resetData.partnerMatchConfidence = null;
  }

  return resetData;
}
