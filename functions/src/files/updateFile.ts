/**
 * Update a file's metadata
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { cancelPartnerWorkersForFile } from "../utils/cancelWorkers";
import { ExtractedLineItem } from "../types/extraction";

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
    // Extraction override
    extractedDate?: string | null; // ISO date string
    extractedAmount?: number | null; // in cents
    extractedPartner?: string | null;
    extractedVatPercent?: number | null;
    extractedVatAmount?: number | null; // in cents
    extractedLineItems?: ExtractedLineItem[] | null;
    extractedVatId?: string | null;
    extractedIban?: string | null;
    extractedAddress?: string | null;
  };
}

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

    // Build update object, converting dates and filtering undefined
    const updateData: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;

      // Handle date conversion
      if (key === "extractedDate" && value) {
        const dateObj = new Date(value as string);
        if (!isNaN(dateObj.getTime())) {
          updateData.extractedDate = Timestamp.fromDate(dateObj);
        }
      } else {
        updateData[key] = value;
      }
    }

    updateData.updatedAt = FieldValue.serverTimestamp();

    await fileRef.update(updateData);

    console.log(`[updateFile] Updated file ${fileId}`, {
      userId: ctx.userId,
      fields: Object.keys(updateData),
    });

    return { success: true };
  }
);
