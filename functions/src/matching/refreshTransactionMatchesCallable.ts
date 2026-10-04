/**
 * "Refresh matches" on a File (#612): runs the matcher on the server, which
 * auto-connects under the upload trigger's rules (the same-day Remainder rule,
 * ADR-0008, passive mode and all) and stores the rest as suggestions. The
 * browser used to auto-connect from its own copy of the threshold.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import { runTransactionMatching } from "./matchFileTransactions";

interface RefreshTransactionMatchesRequest {
  fileId: string;
}

interface RefreshTransactionMatchesResponse {
  /** The suggestions the File stores after the run. */
  suggestions: unknown[];
  /** Transactions the File is connected to after the run. */
  transactionIds: string[];
}

export const refreshTransactionMatchesCallable = createCallable<
  RefreshTransactionMatchesRequest,
  RefreshTransactionMatchesResponse
>({ name: "refreshTransactionMatches", timeoutSeconds: 120 }, async (ctx, request) => {
  const fileId = request?.fileId;
  if (typeof fileId !== "string" || !fileId) {
    throw new HttpsError("invalid-argument", "fileId is required");
  }
  const ref = ctx.db.collection("files").doc(fileId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.userId !== ctx.userId) {
    throw new HttpsError("not-found", "File not found");
  }

  // Can't match without extracted data.
  if (snap.data()!.extractionComplete) {
    await runTransactionMatching(fileId, snap.data()!);
  }

  const after = (await ref.get()).data() ?? {};
  return {
    suggestions: Array.isArray(after.transactionSuggestions) ? after.transactionSuggestions : [],
    transactionIds: Array.isArray(after.transactionIds) ? after.transactionIds : [],
  };
});
