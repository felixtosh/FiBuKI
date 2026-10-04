import {
  collection,
  query,
  orderBy,
  where,
  getDocs,
  getDoc,
  doc,
  updateDoc,
  deleteDoc,
  Timestamp,
  limit as firestoreLimit,
  writeBatch,
} from "firebase/firestore";
import { Transaction, TransactionFilters } from "@/types/transaction";
import { OperationsContext, BulkOperationResult } from "./types";

const TRANSACTIONS_COLLECTION = "transactions";

/**
 * List transactions with optional filters
 */
export async function listTransactions(
  ctx: OperationsContext,
  filters?: TransactionFilters & { limit?: number }
): Promise<Transaction[]> {
  // Build query constraints
  const constraints: Parameters<typeof query>[1][] = [
    where("userId", "==", ctx.userId),
    orderBy("date", "desc"),
  ];

  // Apply filters that can be done in Firestore
  if (filters?.sourceId) {
    constraints.push(where("sourceId", "==", filters.sourceId));
  }

  if (filters?.isComplete !== undefined) {
    constraints.push(where("isComplete", "==", filters.isComplete));
  }

  // Only apply limit in Firestore if NOT doing client-side search
  // (search needs to scan all results first, then limit)
  const hasClientSideFilters = filters?.search || filters?.dateFrom || filters?.dateTo ||
    filters?.hasFile !== undefined || (filters?.amountType && filters.amountType !== "all");

  if (filters?.limit && !hasClientSideFilters) {
    constraints.push(firestoreLimit(filters.limit));
  }

  const q = query(collection(ctx.db, TRANSACTIONS_COLLECTION), ...constraints);
  const snapshot = await getDocs(q);

  let transactions = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as Transaction[];

  // Apply filters that need to be done client-side
  if (filters?.dateFrom) {
    const fromTimestamp = Timestamp.fromDate(filters.dateFrom);
    transactions = transactions.filter((t) => t.date.toMillis() >= fromTimestamp.toMillis());
  }

  if (filters?.dateTo) {
    const toTimestamp = Timestamp.fromDate(filters.dateTo);
    transactions = transactions.filter((t) => t.date.toMillis() <= toTimestamp.toMillis());
  }

  if (filters?.hasFile !== undefined) {
    transactions = transactions.filter((t) =>
      filters.hasFile ? (t.fileIds?.length || 0) > 0 : (t.fileIds?.length || 0) === 0
    );
  }

  if (filters?.search) {
    const searchLower = filters.search.toLowerCase();
    transactions = transactions.filter(
      (t) =>
        (t.name?.toLowerCase() || "").includes(searchLower) ||
        (t.description?.toLowerCase() || "").includes(searchLower) ||
        (t.partner?.toLowerCase() || "").includes(searchLower)
    );
  }

  if (filters?.amountType && filters.amountType !== "all") {
    transactions = transactions.filter((t) =>
      filters.amountType === "income" ? t.amount > 0 : t.amount < 0
    );
  }

  // Apply limit AFTER client-side filters
  if (filters?.limit && hasClientSideFilters) {
    transactions = transactions.slice(0, filters.limit);
  }

  return transactions;
}

/**
 * Get a single transaction by ID
 */
export async function getTransaction(
  ctx: OperationsContext,
  transactionId: string
): Promise<Transaction | null> {
  const docRef = doc(ctx.db, TRANSACTIONS_COLLECTION, transactionId);
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) {
    return null;
  }

  const data = snapshot.data();
  // Verify ownership
  if (data.userId !== ctx.userId) {
    return null;
  }

  return { id: snapshot.id, ...data } as Transaction;
}

/**
 * Update a transaction
 */
export async function updateTransaction(
  ctx: OperationsContext,
  transactionId: string,
  data: Partial<Pick<Transaction, "description" | "fileIds" | "isComplete">>
): Promise<void> {
  // Verify ownership first
  const existing = await getTransaction(ctx, transactionId);
  if (!existing) {
    throw new Error(`Transaction ${transactionId} not found or access denied`);
  }

  const docRef = doc(ctx.db, TRANSACTIONS_COLLECTION, transactionId);
  await updateDoc(docRef, {
    ...data,
    updatedAt: Timestamp.now(),
  });
}

/**
 * Delete a transaction - INTERNAL USE ONLY
 *
 * Individual transaction deletion is NOT allowed in the UI or MCP.
 * Transactions must be deleted together with their source to maintain
 * accounting integrity. Use deleteTransactionsBySource() instead.
 *
 * This function exists only for internal/migration purposes.
 * @internal
 */
export async function _deleteTransactionInternal(
  ctx: OperationsContext,
  transactionId: string
): Promise<void> {
  // Verify ownership first
  const existing = await getTransaction(ctx, transactionId);
  if (!existing) {
    throw new Error(`Transaction ${transactionId} not found or access denied`);
  }

  await deleteDoc(doc(ctx.db, TRANSACTIONS_COLLECTION, transactionId));
}

/**
 * Bulk update transactions (e.g., assign category to multiple)
 */
export async function bulkUpdateTransactions(
  ctx: OperationsContext,
  transactionIds: string[],
  data: Partial<Pick<Transaction, "description" | "isComplete">>
): Promise<BulkOperationResult> {
  const result: BulkOperationResult = {
    success: 0,
    failed: 0,
    errors: [],
  };

  // Process in batches of 500 (Firestore limit)
  const BATCH_SIZE = 500;
  const now = Timestamp.now();

  for (let i = 0; i < transactionIds.length; i += BATCH_SIZE) {
    const batchIds = transactionIds.slice(i, i + BATCH_SIZE);
    const batch = writeBatch(ctx.db);

    for (const id of batchIds) {
      try {
        // Verify ownership
        const existing = await getTransaction(ctx, id);
        if (!existing) {
          result.failed++;
          result.errors.push({ id, error: "Not found or access denied" });
          continue;
        }

        const docRef = doc(ctx.db, TRANSACTIONS_COLLECTION, id);
        batch.update(docRef, {
          ...data,
          updatedAt: now,
        });
        result.success++;
      } catch (err) {
        result.failed++;
        result.errors.push({ id, error: String(err) });
      }
    }

    await batch.commit();
  }

  return result;
}

// NOTE: bulkDeleteTransactions has been removed.
// Individual transaction deletion is not allowed - transactions must be
// deleted together with their source to maintain accounting integrity.
// Use deleteTransactionsBySource() instead.
