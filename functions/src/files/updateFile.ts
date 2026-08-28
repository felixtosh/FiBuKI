/**
 * Update a file's metadata.
 *
 * NOT the extracted figures: a change to those is a correction, and every
 * correction goes through `updateFileExtractedFields`, which stamps
 * provenance, compares what actually moved, and re-derives the
 * reconciliation flag (#203). This callable used to accept them too, on a
 * path that consolidated the line items into the total — a derivation
 * written as if a person had ruled on it, with no stamp a re-extraction
 * would respect. No caller was left using it; now it refuses.
 */

import { FieldValue } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { cancelPartnerWorkersForFile } from "../utils/cancelWorkers";
import { classifyFileRecord, documentTypeFields } from "../documents/adapter";
import { computeDirectionReviewFields } from "../documents/syncDirectionReview";
import { syncDocumentationStateForTransactions } from "../documents/syncDocumentationState";
import { buildCorrectionProvenance } from "./extractionProvenanceOps";

interface UpdateFileRequest {
  fileId: string;
  data: {
    // Basic metadata
    fileName?: string;
    thumbnailUrl?: string;
    // Partner assignment
    partnerId?: string | null;
    partnerType?: "user" | "global" | null;
    partnerMatchedBy?: "manual" | "suggestion" | "auto" | null;
    partnerMatchConfidence?: number | null;
    // Invoice status
    isNotInvoice?: boolean;
    notInvoiceReason?: string | null;
    invoiceDirection?: "incoming" | "outgoing" | "unknown" | null;
    // Descriptive extraction text (who/where, not figures)
    extractedPartner?: string | null;
    extractedVatId?: string | null;
    extractedIban?: string | null;
    extractedAddress?: string | null;
  };
}

/**
 * The correction vocabulary. Writing any of these here would bypass the
 * provenance stamp, the moved-field comparison and the reconciliation
 * re-derivation that `updateFileExtractedFields` exists to enforce (#203).
 */
const CORRECTION_ONLY_FIELDS = [
  "extractedAmount",
  "extractedVatAmount",
  "extractedVatPercent",
  "extractedDate",
  "extractedLineItems",
] as const;

/**
 * What this callable writes, and nothing else. The payload is whatever JSON
 * the caller sent, and the old copy loop forwarded every key of it into the
 * Firestore update — so a caller could set any field on their own file
 * record: a provenance stamp, a derived classification, a review flag. The
 * interface above is the contract; this is the contract enforced.
 */
const WRITABLE_FIELDS = new Set([
  "fileName",
  "thumbnailUrl",
  "partnerId",
  "partnerType",
  "partnerMatchedBy",
  "partnerMatchConfidence",
  "isNotInvoice",
  "notInvoiceReason",
  "invoiceDirection",
  "extractedPartner",
  "extractedVatId",
  "extractedIban",
  "extractedAddress",
]);

interface UpdateFileResponse {
  success: boolean;
}

export const updateFileCallable = createCallable<
  UpdateFileRequest,
  UpdateFileResponse
>(
  { name: "updateFile" },
  async (ctx, request) => {
    const { fileId, data } = request;

    if (!fileId) {
      throw new HttpsError("invalid-argument", "fileId is required");
    }

    // Verify ownership
    const fileRef = ctx.db.collection("files").doc(fileId);
    const fileSnap = await fileRef.get();

    if (!fileSnap.exists) {
      throw new HttpsError("not-found", "File not found");
    }

    if (fileSnap.data()!.userId !== ctx.userId) {
      throw new HttpsError("permission-denied", "Access denied");
    }

    // Cancel running partner automation when user manually assigns or accepts suggestion
    const isManualPartnerAssignment =
      data.partnerId &&
      (data.partnerMatchedBy === "manual" || data.partnerMatchedBy === "suggestion");

    if (isManualPartnerAssignment) {
      cancelPartnerWorkersForFile(ctx.userId, fileId).catch((err) => {
        console.error("[updateFile] Failed to cancel partner workers:", err);
      });
    }

    // Refusing loudly beats stripping silently: a silent strip is the same
    // "correction that looks like it worked" this rule exists to end. The
    // figure fields get the specific message, since they have a correct door.
    const figures = CORRECTION_ONLY_FIELDS.filter(
      (field) => (data as Record<string, unknown>)[field] !== undefined
    );
    if (figures.length > 0) {
      throw new HttpsError(
        "invalid-argument",
        `${figures.join(", ")} cannot be written through updateFile — corrections ` +
          "to the extracted figures go through updateFileExtractedFields"
      );
    }

    const unknown = Object.keys(data).filter(
      (key) => !WRITABLE_FIELDS.has(key) && (data as Record<string, unknown>)[key] !== undefined
    );
    if (unknown.length > 0) {
      throw new HttpsError(
        "invalid-argument",
        `updateFile does not write ${unknown.join(", ")}`
      );
    }

    // Build update object, filtering undefined
    const updateData: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      updateData[key] = value;
    }

    // #233: the direction is a read of the document, and until now setting it
    // through this callable left everything downstream stale — the § 11
    // classification (which asks whether the user issued the document), the
    // direction review flags, and the provenance a re-extraction reads before
    // it overwrites a person's work.
    if (data.invoiceDirection !== undefined) {
      // Null stores `unknown` rather than removing the field: the review rule
      // reads an absent direction and an explicit unknown identically.
      updateData.invoiceDirection = data.invoiceDirection ?? "unknown";

      // #184: a hand-set direction is a correction like any other, so a later
      // re-extraction has to refuse the file rather than quietly undo it.
      Object.assign(
        updateData,
        buildCorrectionProvenance(fileSnap.data(), ["invoiceDirection"])
      );

      const next = { ...fileSnap.data()!, ...updateData };
      Object.assign(updateData, documentTypeFields(classifyFileRecord(next)));
      Object.assign(updateData, await computeDirectionReviewFields(ctx.db, next));
    }

    updateData.updatedAt = FieldValue.serverTimestamp();

    await fileRef.update(updateData);

    // A file's classification changing is invisible to onTransactionUpdate —
    // nothing on the transaction document moved — so the propagation happens
    // here, through the same derivation the trigger uses (#104).
    const connectedTransactionIds = (fileSnap.data()?.transactionIds as string[] | undefined) ?? [];
    if (
      updateData.documentType !== undefined &&
      updateData.documentType !== fileSnap.data()?.documentType &&
      connectedTransactionIds.length > 0
    ) {
      await syncDocumentationStateForTransactions(ctx.db, connectedTransactionIds);
    }

    console.log(`[updateFile] Updated file ${fileId}`, {
      userId: ctx.userId,
      fields: Object.keys(updateData),
    });

    return { success: true };
  }
);
