/**
 * Precision Search Operations
 *
 * Operations for managing precision receipt search:
 * - Queue management for batch processing
 * - Transaction search history
 * - Candidate retrieval (incomplete transactions, unassociated files)
 * - Partner invoice link management
 */

import {
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  getDoc,
  doc,
  Timestamp,
} from "firebase/firestore";
import { OperationsContext } from "./types";
import {
  PrecisionSearchQueueItem,
  TransactionSearchEntry,
  DiscoveredInvoiceLink,
} from "@/types/precision-search";
import { Transaction } from "@/types/transaction";
import { TaxFile } from "@/types/file";
import { UserPartner } from "@/types/partner";

const PRECISION_SEARCH_QUEUE_COLLECTION = "precisionSearchQueue";
const TRANSACTIONS_COLLECTION = "transactions";
const TRANSACTION_SEARCHES_SUBCOLLECTION = "searches";
const FILES_COLLECTION = "files";
const PARTNERS_COLLECTION = "partners";

// ============ Queue Operations ============

/**
 * Get a precision search queue item by ID
 */
export async function getPrecisionSearchQueueItem(
  ctx: OperationsContext,
  queueId: string
): Promise<PrecisionSearchQueueItem | null> {
  const docRef = doc(ctx.db, PRECISION_SEARCH_QUEUE_COLLECTION, queueId);
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) return null;

  const data = snapshot.data();
  if (data.userId !== ctx.userId) return null;

  return { id: snapshot.id, ...data } as PrecisionSearchQueueItem;
}

/**
 * Get the next pending precision search queue item for processing.
 * Returns the oldest pending item.
 */
export async function getNextPrecisionSearchQueueItem(
  ctx: OperationsContext
): Promise<PrecisionSearchQueueItem | null> {
  const q = query(
    collection(ctx.db, PRECISION_SEARCH_QUEUE_COLLECTION),
    where("status", "==", "pending"),
    orderBy("createdAt", "asc"),
    limit(1)
  );

  const snapshot = await getDocs(q);
  if (snapshot.empty) return null;

  const docSnap = snapshot.docs[0];
  return { id: docSnap.id, ...docSnap.data() } as PrecisionSearchQueueItem;
}

/**
 * Check if a precision search is already pending for a user
 */
export async function hasPendingPrecisionSearch(
  ctx: OperationsContext,
  scope?: "all_incomplete" | "single_transaction",
  transactionId?: string
): Promise<boolean> {
  let q = query(
    collection(ctx.db, PRECISION_SEARCH_QUEUE_COLLECTION),
    where("userId", "==", ctx.userId),
    where("status", "in", ["pending", "processing"]),
    limit(5)
  );

  if (scope) {
    q = query(
      collection(ctx.db, PRECISION_SEARCH_QUEUE_COLLECTION),
      where("userId", "==", ctx.userId),
      where("status", "in", ["pending", "processing"]),
      where("scope", "==", scope),
      limit(5)
    );
  }

  const snapshot = await getDocs(q);

  if (snapshot.empty) return false;

  // For single transaction, also check transaction ID
  if (scope === "single_transaction" && transactionId) {
    return snapshot.docs.some(
      (doc) => doc.data().transactionId === transactionId
    );
  }

  return true;
}

// ============ Transaction Search History ============

/**
 * Get transaction search history
 */
export async function getTransactionSearchHistory(
  ctx: OperationsContext,
  transactionId: string,
  options?: { limitCount?: number }
): Promise<TransactionSearchEntry[]> {
  const { limitCount = 10 } = options || {};

  const searchesRef = collection(
    ctx.db,
    TRANSACTIONS_COLLECTION,
    transactionId,
    TRANSACTION_SEARCHES_SUBCOLLECTION
  );

  const q = query(searchesRef, orderBy("createdAt", "desc"), limit(limitCount));

  const snapshot = await getDocs(q);

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as TransactionSearchEntry[];
}

// ============ Candidate Retrieval ============

/**
 * Get incomplete transactions for precision search.
 * Supports cursor-based pagination for large datasets.
 */
export async function getIncompleteTransactions(
  ctx: OperationsContext,
  options?: {
    hasPartner?: boolean;
    limitCount?: number;
    afterTransactionId?: string;
  }
): Promise<Transaction[]> {
  const { hasPartner, limitCount = 50, afterTransactionId } = options || {};

  // Base query: incomplete transactions for user
  let constraints = [
    where("userId", "==", ctx.userId),
    where("isComplete", "==", false),
    orderBy("date", "desc"),
  ];

  // Filter by partner status
  if (hasPartner === true) {
    constraints = [
      where("userId", "==", ctx.userId),
      where("isComplete", "==", false),
      where("partnerId", "!=", null),
      orderBy("partnerId"),
      orderBy("date", "desc"),
    ];
  } else if (hasPartner === false) {
    constraints = [
      where("userId", "==", ctx.userId),
      where("isComplete", "==", false),
      where("partnerId", "==", null),
      orderBy("date", "desc"),
    ];
  }

  // Build query
  let q = query(
    collection(ctx.db, TRANSACTIONS_COLLECTION),
    ...constraints,
    limit(limitCount)
  );

  // If we have a cursor, we need to fetch that document first
  // Note: For simplicity, we'll just fetch all and filter. In production,
  // you'd use startAfter() with the actual document snapshot.
  if (afterTransactionId) {
    // For now, fetch extra and filter client-side
    // A proper implementation would use startAfter with document snapshot
    q = query(
      collection(ctx.db, TRANSACTIONS_COLLECTION),
      ...constraints,
      limit(limitCount + 100) // Fetch extra to find cursor
    );
  }

  const snapshot = await getDocs(q);

  let transactions = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as Transaction[];

  // Filter by cursor if provided
  if (afterTransactionId) {
    const cursorIndex = transactions.findIndex(
      (t) => t.id === afterTransactionId
    );
    if (cursorIndex >= 0) {
      transactions = transactions.slice(cursorIndex + 1, cursorIndex + 1 + limitCount);
    }
  }

  return transactions.slice(0, limitCount);
}

/**
 * Get unassociated files for a specific partner.
 * These are files that:
 * - Are assigned to the partner
 * - Are not connected to any transaction
 */
export async function getUnassociatedFilesForPartner(
  ctx: OperationsContext,
  partnerId: string,
  options?: {
    dateRange?: { from: Date; to: Date };
    limitCount?: number;
  }
): Promise<TaxFile[]> {
  const { dateRange, limitCount = 100 } = options || {};

  // Get files for this partner that have no transaction connections
  let q = query(
    collection(ctx.db, FILES_COLLECTION),
    where("userId", "==", ctx.userId),
    where("partnerId", "==", partnerId),
    where("extractionComplete", "==", true),
    orderBy("extractedDate", "desc"),
    limit(limitCount)
  );

  const snapshot = await getDocs(q);

  let files = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as TaxFile[];

  // Filter out files that are already connected to transactions
  files = files.filter(
    (f) => !f.transactionIds || f.transactionIds.length === 0
  );

  // Filter by date range if provided
  if (dateRange) {
    files = files.filter((f) => {
      if (!f.extractedDate) return false;
      const fileDate = f.extractedDate.toDate();
      return fileDate >= dateRange.from && fileDate <= dateRange.to;
    });
  }

  return files;
}

/**
 * Get unassociated files by amount range.
 * These are files that:
 * - Are not connected to any transaction
 * - Have an extracted amount within the tolerance range
 * - Fall within the date range
 */
export async function getUnassociatedFilesByAmount(
  ctx: OperationsContext,
  amount: number,
  tolerance: number,
  dateRange: { from: Date; to: Date },
  options?: { limitCount?: number }
): Promise<TaxFile[]> {
  const { limitCount = 100 } = options || {};

  const minAmount = Math.abs(amount) - tolerance;
  const maxAmount = Math.abs(amount) + tolerance;

  // Query files within amount range
  // Note: Firestore doesn't support OR on different fields, so we query broadly
  // and filter client-side
  const q = query(
    collection(ctx.db, FILES_COLLECTION),
    where("userId", "==", ctx.userId),
    where("extractionComplete", "==", true),
    where("extractedDate", ">=", Timestamp.fromDate(dateRange.from)),
    where("extractedDate", "<=", Timestamp.fromDate(dateRange.to)),
    orderBy("extractedDate", "desc"),
    limit(limitCount * 2) // Fetch extra for filtering
  );

  const snapshot = await getDocs(q);

  let files = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as TaxFile[];

  // Filter by amount and unassociated
  files = files.filter((f) => {
    // Must not be connected to any transaction
    if (f.transactionIds && f.transactionIds.length > 0) return false;

    // Must have extracted amount in range
    if (f.extractedAmount == null) return false;
    const fileAmount = Math.abs(f.extractedAmount);
    return fileAmount >= minAmount && fileAmount <= maxAmount;
  });

  return files.slice(0, limitCount);
}

/**
 * Get all unassociated files for a user (no transaction connection).
 * Used for broad amount-based searching.
 */
export async function getAllUnassociatedFiles(
  ctx: OperationsContext,
  options?: {
    dateRange?: { from: Date; to: Date };
    limitCount?: number;
  }
): Promise<TaxFile[]> {
  const { dateRange, limitCount = 200 } = options || {};

  let constraints = [
    where("userId", "==", ctx.userId),
    where("extractionComplete", "==", true),
    orderBy("extractedDate", "desc"),
    limit(limitCount * 2), // Fetch extra for filtering
  ];

  if (dateRange) {
    constraints = [
      where("userId", "==", ctx.userId),
      where("extractionComplete", "==", true),
      where("extractedDate", ">=", Timestamp.fromDate(dateRange.from)),
      where("extractedDate", "<=", Timestamp.fromDate(dateRange.to)),
      orderBy("extractedDate", "desc"),
      limit(limitCount * 2),
    ];
  }

  const q = query(collection(ctx.db, FILES_COLLECTION), ...constraints);

  const snapshot = await getDocs(q);

  let files = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as TaxFile[];

  // Filter out files that are already connected to transactions
  files = files.filter(
    (f) => !f.transactionIds || f.transactionIds.length === 0
  );

  return files.slice(0, limitCount);
}

// ============ Partner Invoice Links ============

/**
 * Get invoice links for a partner
 */
export async function getInvoiceLinksForPartner(
  ctx: OperationsContext,
  partnerId: string
): Promise<DiscoveredInvoiceLink[]> {
  const partnerRef = doc(ctx.db, PARTNERS_COLLECTION, partnerId);
  const partnerSnapshot = await getDoc(partnerRef);

  if (!partnerSnapshot.exists() || partnerSnapshot.data().userId !== ctx.userId) {
    return [];
  }

  return partnerSnapshot.data().invoiceLinks || [];
}

// ============ Helper Functions ============

/**
 * Get partner with email domains for precision search
 */
export async function getPartnerWithEmailDomains(
  ctx: OperationsContext,
  partnerId: string
): Promise<UserPartner | null> {
  const partnerRef = doc(ctx.db, PARTNERS_COLLECTION, partnerId);
  const partnerSnapshot = await getDoc(partnerRef);

  if (!partnerSnapshot.exists() || partnerSnapshot.data().userId !== ctx.userId) {
    return null;
  }

  return { id: partnerSnapshot.id, ...partnerSnapshot.data() } as UserPartner;
}

