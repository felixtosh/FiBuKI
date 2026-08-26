/**
 * File-Transaction Matching Operations
 *
 * Operations for accepting/dismissing transaction suggestions
 * and managing file-transaction connections from matching.
 *
 * IMPORTANT: All scoring is done server-side via the findTransactionMatchesForFile
 * callable. This ensures consistent scoring across all UI surfaces.
 */

import {
  collection,
  query,
  where,
  getDocs,
  getDoc,
  doc,
  updateDoc,
  writeBatch,
  Timestamp,
  arrayUnion,
  orderBy,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import {
  TaxFile,
  TransactionSuggestion,
  TransactionMatchSource,
} from "@/types/file";
import { OperationsContext } from "./types";
import {
  FindTransactionMatchesRequest,
  FindTransactionMatchesResponse,
  TransactionMatchResult,
  TRANSACTION_MATCH_CONFIG,
} from "@/types/transaction-matching";
import { functions } from "@/lib/firebase/config";
import { callFunction } from "@/lib/firebase/callable";

// Server callable for transaction matching (single source of truth for scoring)
const findTransactionMatchesFn = httpsCallable<
  FindTransactionMatchesRequest,
  FindTransactionMatchesResponse
>(functions, "findTransactionMatchesForFile");

const FILES_COLLECTION = "files";
const TRANSACTIONS_COLLECTION = "transactions";
const FILE_CONNECTIONS_COLLECTION = "fileConnections";

/**
 * Get transaction suggestions for a file (from stored data)
 */
export async function getTransactionSuggestionsForFile(
  ctx: OperationsContext,
  fileId: string
): Promise<TransactionSuggestion[]> {
  const fileDoc = await getDoc(doc(ctx.db, FILES_COLLECTION, fileId));

  if (!fileDoc.exists() || fileDoc.data().userId !== ctx.userId) {
    return [];
  }

  return fileDoc.data().transactionSuggestions || [];
}

/**
 * Accept a transaction suggestion (creates connection)
 */
export async function acceptTransactionSuggestion(
  ctx: OperationsContext,
  fileId: string,
  transactionId: string,
  confidence: number,
  matchSources: TransactionMatchSource[]
): Promise<string> {
  const fileRef = doc(ctx.db, FILES_COLLECTION, fileId);
  const file = await getDoc(fileRef);

  if (!file.exists() || file.data().userId !== ctx.userId) {
    throw new Error("File not found or access denied");
  }

  const txRef = doc(ctx.db, TRANSACTIONS_COLLECTION, transactionId);
  const tx = await getDoc(txRef);

  if (!tx.exists() || tx.data().userId !== ctx.userId) {
    throw new Error("Transaction not found or access denied");
  }

  // Check if already connected
  const existingQ = query(
    collection(ctx.db, FILE_CONNECTIONS_COLLECTION),
    where("fileId", "==", fileId),
    where("transactionId", "==", transactionId),
    where("userId", "==", ctx.userId)
  );
  const existingSnap = await getDocs(existingQ);
  if (!existingSnap.empty) {
    return existingSnap.docs[0].id; // Already connected
  }

  const now = Timestamp.now();
  const batch = writeBatch(ctx.db);

  // 1. Create connection document
  const connectionRef = doc(collection(ctx.db, FILE_CONNECTIONS_COLLECTION));
  batch.set(connectionRef, {
    fileId,
    transactionId,
    userId: ctx.userId,
    connectionType: "suggestion_accepted",
    matchSources,
    matchConfidence: confidence,
    createdAt: now,
  });

  // 2. Update file's transactionIds array and remove from suggestions
  const currentSuggestions = file.data().transactionSuggestions || [];
  const filteredSuggestions = currentSuggestions.filter(
    (s: TransactionSuggestion) => s.transactionId !== transactionId
  );

  batch.update(fileRef, {
    transactionIds: arrayUnion(transactionId),
    transactionSuggestions: filteredSuggestions,
    updatedAt: now,
  });

  // 3. Update transaction's fileIds array
  batch.update(txRef, {
    fileIds: arrayUnion(fileId),
    updatedAt: now,
  });

  await batch.commit();
  return connectionRef.id;
}

/**
 * Reject a proposed file-to-transaction pair.
 *
 * Delegates to the dismissTransactionSuggestion callable rather than writing
 * the file document here. Rejecting is not "drop an entry from an array": it
 * also has to blacklist the pair in `dismissedTransactionIds` /
 * `dismissedTransactions`, which is what matching reads to keep the pair from
 * being re-proposed (fork #94). Those field-writes are built in exactly one
 * place, functions/src/files/dismissSuggestionOps, shared by the callable and
 * the MCP tool — a client-side copy would be a third writer to drift out of
 * step, and the browser cannot be trusted with a blacklist write anyway.
 *
 * Before fork #100 this trimmed `transactionSuggestions` and stopped there, so
 * a rejection clicked in the UI did not survive the next re-score while one
 * made by an agent did.
 *
 * `ctx` is unused: the callable resolves the caller from the auth token and
 * enforces ownership server-side. It stays in the signature because every
 * operation in this module takes it, and the two detail panels call this one
 * alongside its siblings.
 *
 * @param reason optional free text stored with the rejection (max 500 chars,
 *   refused by the callable above that). No UI passes one yet.
 */
export async function dismissTransactionSuggestion(
  ctx: OperationsContext,
  fileId: string,
  transactionId: string,
  reason?: string
): Promise<void> {
  await callFunction<
    { fileId: string; transactionId: string; reason?: string },
    { success: boolean; dismissedConfidence: number | null }
  >("dismissTransactionSuggestion", { fileId, transactionId, reason });
}

/**
 * Convert server match result to TransactionSuggestion for storage
 */
function matchResultToSuggestion(
  match: TransactionMatchResult
): TransactionSuggestion {
  return {
    transactionId: match.transactionId,
    confidence: match.confidence,
    matchSources: match.matchSources as TransactionMatchSource[],
    preview: {
      date: Timestamp.fromDate(new Date(match.preview.date)),
      amount: match.preview.amount,
      currency: match.preview.currency,
      name: match.preview.name,
      partner: match.preview.partner,
    },
  };
}

/**
 * Re-run transaction matching for a file using server-side scoring
 *
 * This is the ONLY place transaction matching should be triggered from the client.
 * All scoring is done server-side for consistency.
 *
 * - Matches ≥85% are auto-connected
 * - Matches 50-84% are stored as suggestions
 */
export async function refreshTransactionMatches(
  ctx: OperationsContext,
  fileId: string
): Promise<TransactionSuggestion[]> {
  const fileRef = doc(ctx.db, FILES_COLLECTION, fileId);
  const fileDoc = await getDoc(fileRef);

  if (!fileDoc.exists() || fileDoc.data().userId !== ctx.userId) {
    throw new Error("File not found or access denied");
  }

  const file = { id: fileDoc.id, ...fileDoc.data() } as TaxFile;

  // Can't match without extracted data
  if (!file.extractionComplete) {
    return [];
  }

  // Call server callable for scoring (single source of truth)
  const response = await findTransactionMatchesFn({
    fileId,
    excludeTransactionIds: file.transactionIds || [],
    limit: TRANSACTION_MATCH_CONFIG.MAX_RESULTS,
  });

  const { matches } = response.data;

  // Separate auto-matches (≥85%) from suggestions (50-84%)
  const autoMatches = matches.filter(
    (m) => m.confidence >= TRANSACTION_MATCH_CONFIG.AUTO_MATCH_THRESHOLD
  );
  const suggestionMatches = matches.filter(
    (m) =>
      m.confidence >= TRANSACTION_MATCH_CONFIG.SUGGESTION_THRESHOLD &&
      m.confidence < TRANSACTION_MATCH_CONFIG.AUTO_MATCH_THRESHOLD
  );

  // Auto-connect high-confidence matches
  for (const match of autoMatches) {
    try {
      await acceptTransactionSuggestion(
        ctx,
        fileId,
        match.transactionId,
        match.confidence,
        match.matchSources as TransactionMatchSource[]
      );
    } catch (err) {
      // Log but continue - don't fail the whole refresh
      console.error(
        `Failed to auto-connect transaction ${match.transactionId}:`,
        err
      );
    }
  }

  // Convert remaining matches to suggestions
  const suggestions = suggestionMatches.map(matchResultToSuggestion);

  // Update file with suggestions (auto-matched ones are already connected)
  await updateDoc(fileRef, {
    transactionSuggestions: suggestions,
    transactionMatchedAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });

  return suggestions;
}

/**
 * Get files that have pending transaction suggestions
 */
export async function getFilesWithPendingSuggestions(
  ctx: OperationsContext,
  limit?: number
): Promise<TaxFile[]> {
  // Query all files for user
  const q = query(
    collection(ctx.db, FILES_COLLECTION),
    where("userId", "==", ctx.userId),
    where("extractionComplete", "==", true),
    orderBy("uploadedAt", "desc")
  );

  const snapshot = await getDocs(q);
  let files = snapshot.docs
    .map((d) => ({ id: d.id, ...d.data() }) as TaxFile)
    .filter(
      (f) => f.transactionSuggestions && f.transactionSuggestions.length > 0
    );

  if (limit) {
    files = files.slice(0, limit);
  }

  return files;
}

/**
 * Get count of files with pending suggestions (for badge display)
 */
export async function countFilesWithPendingSuggestions(
  ctx: OperationsContext
): Promise<number> {
  const files = await getFilesWithPendingSuggestions(ctx);
  return files.length;
}
