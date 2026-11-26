/**
 * The web's other no-receipt category writers, moved server-side (#794,
 * ADR-0018): Receipt Lost, removing a category, and re-pointing references to
 * categories that no longer exist. Transactions are read-only for the browser,
 * so each write of a Transaction goes through here, behind the same stretch
 * check as assignNoReceiptCategoryToTransaction. The category documents'
 * own bookkeeping (manual removals, counts, partner learning) stays in
 * lib/operations/category-ops.ts.
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { assertTransactionEditable } from "../transactions/writableFields";
import { fiscalYearsGuard, stretchOf } from "../fiscalYears/fiscalYears";
import { createCallable, HttpsError } from "../utils/createCallable";
import { activityEntry, logActivity, type ActivityActor } from "../utils/activity";
import { toDateSafe } from "../utils/toDateSafe";

type Db = FirebaseFirestore.Firestore;

async function ownTransaction(db: Db, userId: string, transactionId: unknown) {
  if (typeof transactionId !== "string" || !transactionId || transactionId.includes("/")) {
    throw new HttpsError("invalid-argument", "transactionId is required");
  }
  const ref = db.collection("transactions").doc(transactionId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.userId !== userId) {
    throw new HttpsError("not-found", `Transaction ${transactionId} not found or access denied`);
  }
  await assertTransactionEditable(db, userId, snap.data()!);
  return { ref, data: snap.data()! };
}

/** Assign the User's Receipt Lost category with its Eigenbeleg entry. */
export async function assignReceiptLost(
  db: Db,
  userId: string,
  params: { transactionId: string; categoryId: string; reason: string; description: string }
): Promise<void> {
  const tx = await ownTransaction(db, userId, params.transactionId);
  const categoryRef = db.collection("noReceiptCategories").doc(String(params.categoryId || "-"));
  const category = await categoryRef.get();
  if (!category.exists || category.data()?.userId !== userId || category.data()?.templateId !== "receipt-lost") {
    throw new HttpsError("not-found", "Receipt Lost category not found or access denied");
  }

  const now = Timestamp.now();
  const batch = db.batch();
  batch.update(tx.ref, {
    noReceiptCategoryId: category.id,
    noReceiptCategoryTemplateId: "receipt-lost",
    noReceiptCategoryMatchedBy: "manual",
    noReceiptCategoryConfidence: 100,
    receiptLostEntry: {
      reason: String(params.reason ?? "").trim(),
      description: String(params.description ?? "").trim(),
      createdAt: now,
      confirmed: true,
    },
    isComplete: true,
    updatedAt: now,
  });
  batch.update(categoryRef, {
    ...(tx.data.noReceiptCategoryId === category.id ? {} : { transactionCount: FieldValue.increment(1) }),
    updatedAt: now,
  });
  await batch.commit();
}

export interface RemovedNoReceiptCategory {
  removed: boolean;
  categoryId: string | null;
  matchedBy: string | null;
  partnerId: string | null;
  partner: string | null;
  name: string;
  isComplete: boolean;
}

/**
 * Clear a Transaction's no-receipt category, log it, and move the count.
 * Single writer for the web and the MCP tool. Nothing assigned is no change.
 */
export async function removeNoReceiptCategoryFromTransaction(
  db: Db,
  userId: string,
  transactionId: string,
  actor: ActivityActor
): Promise<RemovedNoReceiptCategory> {
  const tx = await ownTransaction(db, userId, transactionId);
  const categoryId: string | null = tx.data.noReceiptCategoryId ?? null;
  const hasFiles = Array.isArray(tx.data.fileIds) && tx.data.fileIds.length > 0;
  const said = {
    categoryId,
    matchedBy: (tx.data.noReceiptCategoryMatchedBy as string | undefined) ?? null,
    partnerId: (tx.data.partnerId as string | undefined) ?? null,
    partner: (tx.data.partner as string | undefined) ?? null,
    name: (tx.data.name as string | undefined) ?? "",
  };
  if (!categoryId) return { removed: false, ...said, isComplete: !!tx.data.isComplete };

  const categoryRef = db.collection("noReceiptCategories").doc(categoryId);
  const category = await categoryRef.get();
  const categoryName = (category.data()?.name as string | undefined) ?? categoryId;
  const now = Timestamp.now();
  const batch = db.batch();
  batch.update(tx.ref, {
    noReceiptCategoryId: null,
    noReceiptCategoryTemplateId: null,
    noReceiptCategoryMatchedBy: null,
    noReceiptCategoryConfidence: null,
    receiptLostEntry: null,
    isComplete: hasFiles,
    updatedAt: now,
    ...logActivity(activityEntry({
      type: "category_removed",
      actor,
      categoryName,
      summary: actor === "ai" ? `Category "${categoryName}" removed by the assistant` : `Category "${categoryName}" removed`,
    }, now)),
  });
  if (category.exists && category.data()?.userId === userId) {
    batch.update(categoryRef, { transactionCount: FieldValue.increment(-1), updatedAt: now });
  }
  await batch.commit();
  return { removed: true, ...said, isComplete: hasFiles };
}

/**
 * Re-point every Transaction whose category no longer exists: to the User's
 * category for its template where `targets` names one, else clear it. A
 * Transaction in the Closed stretch keeps its reference.
 */
export async function migrateNoReceiptCategoryRefs(
  db: Db,
  userId: string,
  targets: Record<string, string>
): Promise<{ migrated: number; cleared: number; keptClosed: number }> {
  const categories = await db.collection("noReceiptCategories").where("userId", "==", userId).get();
  const own = new Set(categories.docs.map((d) => d.id));
  const { settings } = await fiscalYearsGuard(db, userId);
  const rows = await db.collection("transactions").where("userId", "==", userId).where("noReceiptCategoryId", "!=", null).get();

  let migrated = 0;
  let cleared = 0;
  let keptClosed = 0;
  let batch = db.batch();
  let pending = 0;
  for (const row of rows.docs) {
    const data = row.data();
    if (own.has(data.noReceiptCategoryId)) continue;
    const date = toDateSafe(data.date);
    if (settings.closedThrough !== null && date && stretchOf(settings, date) === "closed") {
      keptClosed++;
      continue;
    }
    const target = targets[data.noReceiptCategoryTemplateId as string];
    const now = Timestamp.now();
    if (target && own.has(target)) {
      batch.update(row.ref, { noReceiptCategoryId: target, updatedAt: now });
      migrated++;
    } else {
      const hasFiles = Array.isArray(data.fileIds) && data.fileIds.length > 0;
      batch.update(row.ref, {
        noReceiptCategoryId: null,
        noReceiptCategoryTemplateId: null,
        noReceiptCategoryMatchedBy: null,
        noReceiptCategoryConfidence: null,
        isComplete: hasFiles,
        updatedAt: now,
      });
      cleared++;
    }
    if (++pending >= 450) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
    }
  }
  if (pending > 0) await batch.commit();
  return { migrated, cleared, keptClosed };
}

export const assignReceiptLostCategoryCallable = createCallable<
  { transactionId: string; categoryId: string; reason: string; description: string },
  { success: boolean }
>({ name: "assignReceiptLostCategory" }, async (ctx, request) => {
  await assignReceiptLost(ctx.db, ctx.userId, request);
  return { success: true };
});

export const removeNoReceiptCategoryCallable = createCallable<{ transactionId: string }, RemovedNoReceiptCategory>(
  { name: "removeNoReceiptCategory" },
  async (ctx, request) => removeNoReceiptCategoryFromTransaction(ctx.db, ctx.userId, request.transactionId, "manual")
);

export const migrateNoReceiptCategoryRefsCallable = createCallable<
  { targets?: Record<string, string> },
  { migrated: number; cleared: number; keptClosed: number }
>({ name: "migrateNoReceiptCategoryRefs" }, async (ctx, request) => {
  const targets = request.targets && typeof request.targets === "object" ? request.targets : {};
  return migrateNoReceiptCategoryRefs(ctx.db, ctx.userId, targets);
});
