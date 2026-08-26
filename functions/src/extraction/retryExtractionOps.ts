/**
 * Re-running extraction on one file, shared by the callable and the MCP tool.
 *
 * The callable (retryFileExtraction) drives the UI's retry action; the
 * `retry_file_extraction` tool handler drives the MCP surface. Both must apply
 * the same eligibility rule and write the same reset, or a file re-extracted by
 * an agent and one re-extracted by a click end up in different states — so the
 * decision and the writes live here and nowhere else. Mirrors
 * files/dismissSuggestionOps, which shares the dismissal builders the same way.
 *
 * Ownership is checked here too. The callable used to fetch a file by id and
 * re-extract it without looking at `userId` or even `request.auth`, which the
 * MCP surface must not inherit: an API key is scoped to one user, and a tool
 * that re-extracts by bare id would cross that boundary and spend another
 * account's extraction budget doing it (fork #74).
 */

import type { Firestore } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";
import { runExtraction } from "./extractionCore";
import { correctedFieldsOf } from "../files/extractionProvenanceOps";

/** Why a retry was refused. Each surface maps these onto its own error type. */
export type RetryRefusalCode =
  | "NOT_FOUND"
  | "ACCESS_DENIED"
  | "ALREADY_EXTRACTED"
  | "HAND_CORRECTED"
  | "EXTRACTION_FAILED";

export class RetryExtractionError extends Error {
  constructor(readonly code: RetryRefusalCode, message: string) {
    super(message);
    this.name = "RetryExtractionError";
  }
}

export interface RetryExtractionOptions {
  fileId: string;
  /** The caller's uid. The file must belong to it. */
  userId: string;
  /**
   * Re-extract a file that already extracted without error. Required for the
   * files whose extraction "succeeded" and produced nothing usable — no line
   * items, no VAT — which is the whole population a re-extraction sweep is for.
   */
  force?: boolean;
  /**
   * Re-extract a file carrying hand corrections, replacing what a person set
   * with whatever the model reads this time (#184).
   *
   * Deliberately NOT `force`. Every bulk sweep passes `force: true` as a matter
   * of habit — the UI's own retry button does too, because a cleanly extracted
   * file needs it — so gating corrections on that flag would be no gate at all.
   * A caller that means to overwrite a person's ruling says so per file.
   */
  overwriteCorrections?: boolean;
  anthropicApiKey: string;
}

/**
 * True when this file may be re-extracted.
 *
 * A file that errored, or one whose invoice/not-invoice classification the user
 * overrode, is always retryable — that is what the button was built for. A file
 * that completed cleanly needs `force`, so an accidental repeat does not spend
 * an extraction on a document that already has good data.
 */
export function canRetryExtraction(
  fileData: { extractionError?: unknown; isNotInvoice?: unknown; extractionComplete?: unknown },
  force?: boolean
): boolean {
  const hasError = !!fileData.extractionError;
  const wasNotInvoice = fileData.isNotInvoice === true;
  const userMarkedAsInvoice = fileData.isNotInvoice === false && !hasError;

  if (force === true || hasError || wasNotInvoice || userMarkedAsInvoice) return true;
  return !fileData.extractionComplete;
}

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

/**
 * Re-run extraction on one file the caller owns.
 *
 * Throws RetryExtractionError for every refusal, including a failed extraction
 * — the failure is stamped on the document first, exactly as the trigger path
 * does, so a file never sits with `extractionComplete: false` forever after a
 * crash mid-run.
 *
 * A file carrying hand corrections is refused outright unless the caller asks
 * for those corrections to be overwritten (#184), and the refusal names the
 * fields so the caller can judge what it is about to destroy. The marker itself
 * is not cleared when the overwrite goes ahead: it records that a person once
 * ruled on this document, which stays true, and it keeps the file on the next
 * sweep's exclusion list rather than quietly falling off it after one override.
 */
export async function retryExtractionForFile(
  db: Firestore,
  { fileId, userId, force, overwriteCorrections, anthropicApiKey }: RetryExtractionOptions
): Promise<Awaited<ReturnType<typeof runExtraction>>> {
  const fileRef = db.collection("files").doc(fileId);
  const fileDoc = await fileRef.get();

  if (!fileDoc.exists) {
    throw new RetryExtractionError("NOT_FOUND", "File not found");
  }

  const fileData = fileDoc.data()!;

  if (fileData.userId !== userId) {
    throw new RetryExtractionError("ACCESS_DENIED", "Access denied");
  }

  // Ahead of the force check, because a corrected file has almost always
  // extracted cleanly: whichever refusal fires, the caller needs to hear about
  // the corrections rather than be told to pass the flag that destroys them.
  const correctedFields = correctedFieldsOf(fileData);
  if (correctedFields.length > 0 && overwriteCorrections !== true) {
    throw new RetryExtractionError(
      "HAND_CORRECTED",
      `File carries hand corrections a re-extraction would discard (${correctedFields.join(", ")}). ` +
        "Pass overwriteCorrections to re-extract it anyway."
    );
  }

  if (!canRetryExtraction(fileData, force)) {
    throw new RetryExtractionError(
      "ALREADY_EXTRACTED",
      "File has already been extracted successfully. Pass force to re-extract it anyway."
    );
  }

  // A classification the user overrode is not re-litigated: they already said
  // this document is an invoice.
  const isUserOverride =
    fileData.isNotInvoice === true ||
    (fileData.isNotInvoice === false && !fileData.extractionError);

  console.log(
    `[${new Date().toISOString()}] Retrying extraction for file: ${fileData.fileName} (${fileId})`,
    { userId, force: force === true, isUserOverride, overwrittenCorrections: correctedFields }
  );

  await fileRef.update(buildRetryResetUpdates(fileData));

  try {
    return await runExtraction(fileId, fileData, { anthropicApiKey, skipClassification: isUserOverride });
  } catch (error) {
    console.error(`Retry extraction failed for file ${fileId}:`, error);

    await fileRef.update({
      extractionComplete: true,
      extractionError: error instanceof Error ? error.message : "Unknown extraction error",
      updatedAt: Timestamp.now(),
    });

    throw new RetryExtractionError(
      "EXTRACTION_FAILED",
      error instanceof Error ? error.message : "Extraction failed"
    );
  }
}
