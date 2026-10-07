/**
 * Bulk update multiple transactions
 */

import { FieldValue } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { assertWritableFields, BULK_WRITABLE_FIELDS } from "./writableFields";
import { activityEntry, type ActivityActor } from "../utils/activity";

interface BulkUpdateTransactionsRequest {
  /** Transaction IDs to update */
  ids: string[];
  /** Who edits, for the activity log (#752): the chat agent sends `ai`. Anything else is the User. */
  actor?: "manual" | "ai";
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

    // The log (#752): the same lines on every row, built once.
    const editActivity = await bulkEditActivity(ctx.db, data, request.actor === "ai" ? "ai" : "manual");
    if (editActivity.length > 0) updateData.automationHistory = FieldValue.arrayUnion(...editActivity);

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

/** Fields a person recognises, by stored name. */
const EDIT_LABELS: Record<string, string> = {
  description: "description",
  isComplete: "completion",
};

/**
 * The log lines for one bulk edit (#752): a Partner or category set or
 * cleared gets its own line, any other field one "edited" line.
 */
async function bulkEditActivity(
  db: FirebaseFirestore.Firestore,
  data: BulkUpdateTransactionsRequest["data"],
  actor: ActivityActor
): Promise<Array<Record<string, unknown>>> {
  const entries: Array<Record<string, unknown>> = [];
  if (data.partnerId !== undefined) {
    if (data.partnerId) {
      const collection = data.partnerType === "global" ? "globalPartners" : "partners";
      const name = ((await db.collection(collection).doc(data.partnerId).get()).data()?.name as string | undefined) ?? data.partnerId;
      entries.push(activityEntry({ type: "partner_assigned", actor, partnerName: name, forPartnerId: data.partnerId, summary: `Partner "${name}" assigned` }));
    } else {
      entries.push(activityEntry({ type: "partner_removed", actor, summary: "Partner removed" }));
    }
  }
  if (data.noReceiptCategoryId !== undefined) {
    if (data.noReceiptCategoryId) {
      const name = ((await db.collection("noReceiptCategories").doc(data.noReceiptCategoryId).get()).data()?.name as string | undefined) ?? data.noReceiptCategoryId;
      entries.push(activityEntry({ type: "category_assigned", actor, categoryName: name, summary: `Category "${name}" assigned` }));
    } else {
      entries.push(activityEntry({ type: "category_removed", actor, summary: "Category removed" }));
    }
  }
  const other = Object.keys(data)
    .filter((key) => (data as Record<string, unknown>)[key] !== undefined && key in EDIT_LABELS)
    .map((key) => EDIT_LABELS[key]);
  if (other.length > 0) {
    entries.push(activityEntry({ type: "transaction_edited", actor, summary: `Edited: ${other.join(", ")}` }));
  }
  return entries;
}
