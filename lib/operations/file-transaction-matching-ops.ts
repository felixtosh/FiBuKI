/**
 * File-Transaction Matching Operations
 *
 * Operations for accepting/dismissing transaction suggestions. Every File
 * Connection write happens on the server, through its one writer (#612).
 *
 * IMPORTANT: All scoring is done server-side. This ensures consistent scoring
 * across all UI surfaces.
 */

import {
  collection,
  query,
  where,
  getDocs,
  getDoc,
  doc,
  orderBy,
} from "firebase/firestore";
import { TaxFile, TransactionSuggestion } from "@/types/file";
import { OperationsContext } from "./types";
import { callFunction } from "@/lib/firebase/callable";

const FILES_COLLECTION = "files";

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
 * Accept a transaction suggestion (creates connection).
 *
 * Sends only the pair and "suggestion accepted": the server reads the
 * Confidence and Match Sources from the stored suggestion and removes it from
 * the File (#612). `ctx` is unused, like the other callable-backed operations.
 */
export async function acceptTransactionSuggestion(
  _ctx: OperationsContext,
  fileId: string,
  transactionId: string
): Promise<string> {
  const result = await callFunction<
    { fileId: string; transactionId: string; origin: "suggestion" },
    { connectionId: string }
  >("connectFileToTransaction", { fileId, transactionId, origin: "suggestion" });
  return result.connectionId;
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
 * Re-run transaction matching for a file. The matcher runs on the server and
 * auto-connects under the upload trigger's rules; the rest it stores as
 * suggestions, which come back here.
 */
export async function refreshTransactionMatches(
  _ctx: OperationsContext,
  fileId: string
): Promise<TransactionSuggestion[]> {
  const result = await callFunction<
    { fileId: string },
    { suggestions: TransactionSuggestion[]; transactionIds: string[] }
  >("refreshTransactionMatches", { fileId });
  return result.suggestions;
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
