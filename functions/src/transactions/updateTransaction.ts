/**
 * Update a single transaction
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { deriveActivityLevel } from "../utils/activityLevel";

interface UpdateTransactionRequest {
  /** Transaction ID to update */
  id: string;
  /** Fields to update */
  data: {
    description?: string | null;
    fileIds?: string[];
    isComplete?: boolean;
    partnerId?: string | null;
    partnerType?: "global" | "user" | null;
    partnerMatchConfidence?: number | null;
    partnerMatchedBy?: "auto" | "manual" | "ai" | "suggestion" | null;
    noReceiptCategoryId?: string | null;
    noReceiptCategoryTemplateId?: string | null;
    noReceiptCategoryMatchedBy?: "manual" | "suggestion" | "auto" | null;
    noReceiptCategoryConfidence?: number | null;
    receiptLostEntry?: {
      reason: string;
      description?: string;
      estimatedAmount?: number;
      dateRecorded: string;
    } | null;
    rejectedFileIds?: string[];
    aiSearchQueries?: string[] | null;
    aiSearchQueriesForPartnerId?: string | null;
    // Tax fields
    vatRate?: number | null;
    vatAmount?: number | null;
    isEuTransaction?: boolean | null;
    isReverseCharge?: boolean | null;
    /** Goods/service answer to the foreign-regime review (#214); null clears. */
    foreignSupplyKind?: "goods" | "service" | null;
  };
}

interface UpdateTransactionResponse {
  success: boolean;
}

export const updateTransactionCallable = createCallable<
  UpdateTransactionRequest,
  UpdateTransactionResponse
>(
  { name: "updateTransaction" },
  async (ctx, request) => {
    const { id, data } = request;

    if (!id) {
      throw new HttpsError("invalid-argument", "Transaction ID is required");
    }

    if (
      data.foreignSupplyKind !== undefined &&
      data.foreignSupplyKind !== null &&
      data.foreignSupplyKind !== "goods" &&
      data.foreignSupplyKind !== "service"
    ) {
      throw new HttpsError(
        "invalid-argument",
        'foreignSupplyKind must be "goods", "service", or null to clear'
      );
    }

    // Verify ownership
    const transactionRef = ctx.db.collection("transactions").doc(id);
    const transactionSnap = await transactionRef.get();

    if (!transactionSnap.exists) {
      throw new HttpsError("not-found", "Transaction not found");
    }

    const transactionData = transactionSnap.data();
    if (transactionData?.userId !== ctx.userId) {
      throw new HttpsError("permission-denied", "Access denied");
    }

    // Build update object, filtering out undefined values
    const updateData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        updateData[key] = value;
      }
    }

    // Automatically manage isComplete based on noReceiptCategoryId changes
    // Green row = file attached OR no-receipt category assigned
    if (data.noReceiptCategoryId !== undefined) {
      const currentFileIds = transactionData?.fileIds || [];
      const hasFiles = currentFileIds.length > 0;

      if (data.noReceiptCategoryId) {
        // Category being assigned -> mark complete
        updateData.isComplete = true;
      } else if (!hasFiles) {
        // Category being removed AND no files -> mark incomplete
        updateData.isComplete = false;
      }
      // If category removed but has files, keep isComplete=true (don't change)
    }

    // Log category changes to activity log
    if (data.noReceiptCategoryId !== undefined) {
      const previousCategoryId = transactionData?.noReceiptCategoryId;
      const actor = (data.noReceiptCategoryMatchedBy === "suggestion" ? "suggestion" : data.noReceiptCategoryMatchedBy === "auto" ? "auto" : "manual") as "manual" | "suggestion" | "auto";

      if (data.noReceiptCategoryId && data.noReceiptCategoryId !== previousCategoryId) {
        // Look up category name
        let categoryName: string | null = null;
        try {
          const catSnap = await ctx.db.collection("noReceiptCategories").doc(data.noReceiptCategoryId).get();
          categoryName = catSnap.data()?.name || null;
        } catch { /* best effort */ }

        updateData.automationHistory = FieldValue.arrayUnion({
          type: "category_assigned",
          ranAt: Timestamp.now(),
          status: "completed",
          actor,
          level: deriveActivityLevel({ type: "category_assigned", actor }),
          categoryName: categoryName || data.noReceiptCategoryTemplateId || null,
          confidence: data.noReceiptCategoryConfidence ?? null,
          summary: `Category "${categoryName || data.noReceiptCategoryTemplateId || "unknown"}" assigned`,
        });
      } else if (!data.noReceiptCategoryId && previousCategoryId) {
        // Look up previous category name
        let categoryName: string | null = null;
        try {
          const catSnap = await ctx.db.collection("noReceiptCategories").doc(previousCategoryId).get();
          categoryName = catSnap.data()?.name || null;
        } catch { /* best effort */ }

        updateData.automationHistory = FieldValue.arrayUnion({
          type: "category_removed",
          ranAt: Timestamp.now(),
          status: "completed",
          actor: "manual" as const,
          level: "decision" as const,
          categoryName: categoryName || null,
          summary: `Category "${categoryName || "unknown"}" removed`,
        });
      }
    }

    // Always update timestamp
    updateData.updatedAt = FieldValue.serverTimestamp();

    await transactionRef.update(updateData);

    console.log(`[updateTransaction] Updated transaction ${id}`, {
      userId: ctx.userId,
      fields: Object.keys(updateData),
    });

    return { success: true };
  }
);
