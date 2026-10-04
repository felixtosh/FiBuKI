/**
 * Bulk update multiple transactions
 */

import { FieldValue } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { assertWritableFields, BULK_WRITABLE_FIELDS } from "./writableFields";

interface BulkUpdateTransactionsRequest {
  /** Transaction IDs to update */
  ids: string[];
  /** Fields to update on all transactions */
  data: {
    description?: string | null;
    isComplete?: boolean;
    partnerId?: string | null;
    /** Required with a partnerId: which collection the id names. */
    partnerType?: "global" | "user" | null;
    partnerMatchedBy?: "auto" | "manual" | "ai" | "suggestion" | null;
    noReceiptCategoryId?: string | null;
    noReceiptCategoryTemplateId?: string | null;
    noReceiptCategoryMatchedBy?: "manual" | "suggestion" | "auto" | null;
  };
}

interface BulkUpdateTransactionsResponse {
  success: number;
  failed: number;
  errors: Array<{ id: string; error: string }>;
}

const BATCH_SIZE = 500; // Firestore batch limit

function isDocId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && !id.includes("/");
}

/**
 * The Partner and the no-receipt category a request points the rows at must
 * be ones the caller may use: their own, or a Global Partner. Every user
 * shares one database, so without this a row could name another user's
 * record, and everything that later resolves it (names in the UI, matching,
 * the UVA run's category lookup) would read that user's data. Checked once
 * for the whole request, since every row gets the same values; not usable
 * answers like not found.
 */
async function assertUsableReferences(
  db: FirebaseFirestore.Firestore,
  userId: string,
  data: BulkUpdateTransactionsRequest["data"]
): Promise<void> {
  const { partnerId, partnerType } = data;
  if (partnerId !== undefined || partnerType !== undefined) {
    if (partnerId === null || partnerId === undefined) {
      // Clearing the Partner clears its type with it; a type alone names nothing.
      if (partnerId === undefined || (partnerType !== undefined && partnerType !== null)) {
        throw new HttpsError("invalid-argument", "partnerType is only written with a partnerId");
      }
    } else {
      if (!isDocId(partnerId)) {
        throw new HttpsError("invalid-argument", "partnerId must be a document id");
      }
      if (partnerType !== "user" && partnerType !== "global") {
        throw new HttpsError("invalid-argument", 'partnerType must be "user" or "global" with a partnerId');
      }
      const partnerSnap = await db
        .collection(partnerType === "global" ? "globalPartners" : "partners")
        .doc(partnerId)
        .get();
      const usable =
        partnerSnap.exists && (partnerType === "global" || partnerSnap.data()?.userId === userId);
      if (!usable) {
        throw new HttpsError("not-found", "Partner not found");
      }
    }
  }

  const { noReceiptCategoryId } = data;
  if (noReceiptCategoryId !== undefined && noReceiptCategoryId !== null) {
    if (!isDocId(noReceiptCategoryId)) {
      throw new HttpsError("invalid-argument", "noReceiptCategoryId must be a document id");
    }
    const categorySnap = await db.collection("noReceiptCategories").doc(noReceiptCategoryId).get();
    if (!categorySnap.exists || categorySnap.data()?.userId !== userId) {
      throw new HttpsError("not-found", "No-receipt category not found");
    }
  }
}

export const bulkUpdateTransactionsCallable = createCallable<
  BulkUpdateTransactionsRequest,
  BulkUpdateTransactionsResponse
>(
  {
    name: "bulkUpdateTransactions",
    timeoutSeconds: 120, // Allow more time for bulk operations
    memory: "512MiB",
  },
  async (ctx, request) => {
    const { ids, data } = request;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      throw new HttpsError("invalid-argument", "Transaction IDs array is required");
    }

    if (ids.length > 1000) {
      throw new HttpsError(
        "invalid-argument",
        "Cannot update more than 1000 transactions at once"
      );
    }

    assertWritableFields("bulkUpdateTransactions", data, BULK_WRITABLE_FIELDS);
    await assertUsableReferences(ctx.db, ctx.userId, data);

    const result: BulkUpdateTransactionsResponse = {
      success: 0,
      failed: 0,
      errors: [],
    };

    // Build update data
    const updateData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        updateData[key] = value;
      }
    }
    updateData.updatedAt = FieldValue.serverTimestamp();

    // Process in batches
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batchIds = ids.slice(i, i + BATCH_SIZE);
      const batch = ctx.db.batch();
      const validIds: string[] = [];

      // First verify ownership of all transactions in this batch
      for (const id of batchIds) {
        try {
          const transactionRef = ctx.db.collection("transactions").doc(id);
          const transactionSnap = await transactionRef.get();

          if (!transactionSnap.exists) {
            result.failed++;
            result.errors.push({ id, error: "Not found" });
            continue;
          }

          const transactionData = transactionSnap.data();
          if (transactionData?.userId !== ctx.userId) {
            result.failed++;
            result.errors.push({ id, error: "Access denied" });
            continue;
          }

          // Build per-transaction update (may need to adjust isComplete)
          const txUpdateData = { ...updateData };

          // Automatically manage isComplete based on noReceiptCategoryId changes
          // Green row = file attached OR no-receipt category assigned
          if (data.noReceiptCategoryId !== undefined) {
            const currentFileIds = transactionData?.fileIds || [];
            const hasFiles = currentFileIds.length > 0;

            if (data.noReceiptCategoryId) {
              // Category being assigned -> mark complete
              txUpdateData.isComplete = true;
            } else if (!hasFiles) {
              // Category being removed AND no files -> mark incomplete
              txUpdateData.isComplete = false;
            }
            // If category removed but has files, keep isComplete unchanged
          }

          batch.update(transactionRef, txUpdateData);
          validIds.push(id);
        } catch (err) {
          result.failed++;
          result.errors.push({ id, error: String(err) });
        }
      }

      // Commit batch
      if (validIds.length > 0) {
        try {
          await batch.commit();
          result.success += validIds.length;
        } catch (err) {
          // Batch failed, mark all as failed
          result.failed += validIds.length;
          for (const id of validIds) {
            result.errors.push({ id, error: `Batch commit failed: ${err}` });
          }
        }
      }
    }

    console.log(`[bulkUpdateTransactions] Completed`, {
      userId: ctx.userId,
      requested: ids.length,
      success: result.success,
      failed: result.failed,
    });

    return result;
  }
);
