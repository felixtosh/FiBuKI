/**
 * Mark a file as "not an invoice" (user override)
 * Clears extracted data and resets downstream matching.
 * Preserves manually-set partner assignments.
 */

import { FieldValue } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";

interface MarkFileAsNotInvoiceRequest {
  fileId: string;
  reason?: string;
}

interface MarkFileAsNotInvoiceResponse {
  success: boolean;
}

export const markFileAsNotInvoiceCallable = createCallable<
  MarkFileAsNotInvoiceRequest,
  MarkFileAsNotInvoiceResponse
>(
  { name: "markFileAsNotInvoice" },
  async (ctx, request) => {
    const { fileId, reason } = request;

    if (!fileId) {
      throw new HttpsError("invalid-argument", "fileId is required");
    }

    const fileRef = ctx.db.collection("files").doc(fileId);
    const fileSnap = await fileRef.get();

    if (!fileSnap.exists) {
      throw new HttpsError("not-found", "File not found");
    }

    const fileData = fileSnap.data()!;
    if (fileData.userId !== ctx.userId) {
      throw new HttpsError("permission-denied", "Access denied");
    }

    // Build update object
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

    await fileRef.update(updates);

    console.log(`[markFileAsNotInvoice] Marked file ${fileId} as not invoice`, {
      userId: ctx.userId,
      reason: reason || "Marked by user",
    });

    return { success: true };
  }
);
