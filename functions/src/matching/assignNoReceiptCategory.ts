/**
 * Assign a no-receipt category to a transaction.
 *
 * Single writer for this mutation (#164): both the web operations layer
 * (lib/operations/category-ops.ts, via the callable below) and the
 * server-side tool registry (functions/src/tools/handlers.ts, calling
 * assignNoReceiptCategoryToTransaction directly) go through this function,
 * so a MCP-driven assignment teaches the category matcher exactly like a
 * web-driven one does.
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";

export type NoReceiptCategoryMatchedBy = "manual" | "suggestion" | "auto";

export interface AssignNoReceiptCategoryParams {
  transactionId: string;
  categoryId: string;
  matchedBy: NoReceiptCategoryMatchedBy;
  confidence?: number | null;
}

export interface AssignNoReceiptCategoryResult {
  transactionId: string;
  categoryId: string;
  categoryName: string;
  categoryTemplateId: string | null;
  partnerAdded: boolean;
}

/**
 * Core assignment: marks the transaction complete with the category, moves
 * the category's transactionCount, and - when the transaction has a partner
 * and the assignment is confirmed (manual or auto, not a bare suggestion) -
 * adds that partner to the category's matchedPartnerIds so future
 * transactions from the same partner auto-apply above threshold.
 */
export async function assignNoReceiptCategoryToTransaction(
  db: FirebaseFirestore.Firestore,
  userId: string,
  params: AssignNoReceiptCategoryParams
): Promise<AssignNoReceiptCategoryResult> {
  const { transactionId, categoryId, matchedBy, confidence } = params;

  const txRef = db.collection("transactions").doc(transactionId);
  const categoryRef = db.collection("noReceiptCategories").doc(categoryId);

  const [txSnap, categorySnap] = await Promise.all([txRef.get(), categoryRef.get()]);

  if (!txSnap.exists || txSnap.data()?.userId !== userId) {
    throw new Error(`Transaction ${transactionId} not found or access denied`);
  }
  if (!categorySnap.exists || categorySnap.data()?.userId !== userId) {
    throw new Error(`Category ${categoryId} not found or access denied`);
  }

  const txData = txSnap.data()!;
  const categoryData = categorySnap.data()!;
  const now = Timestamp.now();
  const batch = db.batch();

  batch.update(txRef, {
    noReceiptCategoryId: categoryId,
    noReceiptCategoryTemplateId: categoryData.templateId ?? null,
    noReceiptCategoryMatchedBy: matchedBy,
    noReceiptCategoryConfidence: confidence ?? (matchedBy === "manual" ? 100 : null),
    isComplete: true,
    updatedAt: now,
  });

  const partnerId: string | undefined = txData.partnerId;
  const existingMatchedPartnerIds: string[] = categoryData.matchedPartnerIds || [];
  const partnerAdded =
    !!partnerId &&
    (matchedBy === "manual" || matchedBy === "auto") &&
    !existingMatchedPartnerIds.includes(partnerId);

  // A batch may only write to a given document once, so transactionCount and
  // matchedPartnerIds move together in one update (#164 AC: they must move
  // together on both surfaces).
  const categoryUpdate: Record<string, unknown> = {
    transactionCount: FieldValue.increment(1),
    updatedAt: now,
  };
  if (partnerAdded) {
    categoryUpdate.matchedPartnerIds = FieldValue.arrayUnion(partnerId);
  }
  batch.update(categoryRef, categoryUpdate);

  await batch.commit();

  return {
    transactionId,
    categoryId,
    categoryName: categoryData.name,
    categoryTemplateId: categoryData.templateId ?? null,
    partnerAdded,
  };
}

interface AssignNoReceiptCategoryRequest {
  transactionId: string;
  categoryId: string;
  matchedBy?: NoReceiptCategoryMatchedBy;
  confidence?: number | null;
}

interface AssignNoReceiptCategoryResponse {
  success: boolean;
  transactionId: string;
  categoryId: string;
  categoryName: string;
}

export const assignNoReceiptCategoryCallable = createCallable<
  AssignNoReceiptCategoryRequest,
  AssignNoReceiptCategoryResponse
>(
  { name: "assignNoReceiptCategory" },
  async (ctx, request) => {
    const { transactionId, categoryId, confidence } = request;
    const matchedBy = request.matchedBy ?? "manual";

    if (!transactionId || !categoryId) {
      throw new HttpsError("invalid-argument", "transactionId and categoryId are required");
    }

    let result: AssignNoReceiptCategoryResult;
    try {
      result = await assignNoReceiptCategoryToTransaction(ctx.db, ctx.userId, {
        transactionId,
        categoryId,
        matchedBy,
        confidence,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("not found or access denied")) {
        throw new HttpsError("not-found", message);
      }
      throw error;
    }

    return {
      success: true,
      transactionId: result.transactionId,
      categoryId: result.categoryId,
      categoryName: result.categoryName,
    };
  }
);
