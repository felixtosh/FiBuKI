import {
  collection,
  query,
  orderBy,
  where,
  getDocs,
  getDoc,
  doc,
  Timestamp,
  limit as firestoreLimit,
} from "firebase/firestore";
import { Transaction, TransactionFilters } from "@/types/transaction";
import { OperationsContext } from "./types";

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

// NOTE: bulkDeleteTransactions has been removed.
// Individual transaction deletion is not allowed - transactions must be
// deleted together with their source to maintain accounting integrity.
// Use deleteTransactionsBySource() instead.
