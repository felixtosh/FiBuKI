/**
 * Dismiss a transaction suggestion from a file
 * Removes the suggestion from the file's transactionSuggestions array
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";

interface TransactionSuggestion {
  transactionId: string;
  confidence: number;
  matchSources: Array<{
    type: string;
    weight: number;
    details?: string;
  }>;
  suggestedAt: FirebaseFirestore.Timestamp;
}

interface DismissTransactionSuggestionRequest {
  fileId: string;
  transactionId: string;
}

interface DismissTransactionSuggestionResponse {
  success: boolean;
}

export const dismissTransactionSuggestionCallable = createCallable<
  DismissTransactionSuggestionRequest,
  DismissTransactionSuggestionResponse
>(
  { name: "dismissTransactionSuggestion" },
  async (ctx, request) => {
    const { fileId, transactionId } = request;

    if (!fileId) {
      throw new HttpsError("invalid-argument", "fileId is required");
    }
    if (!transactionId) {
      throw new HttpsError("invalid-argument", "transactionId is required");
    }

    const fileRef = ctx.db.collection("files").doc(fileId);
    const fileSnap = await fileRef.get();

    if (!fileSnap.exists) {
      throw new HttpsError("not-found", "File not found");
    }

    const fileData = fileSnap.data()!;
    if (fileData.userId !== ctx.userId) {
      throw new HttpsError("permission-denied", "Access denied");
    }

    // Filter out the dismissed suggestion and capture its confidence
    const currentSuggestions = (fileData.transactionSuggestions || []) as TransactionSuggestion[];
    const dismissedSuggestion = currentSuggestions.find(
      (s) => s.transactionId === transactionId
    );
    const updatedSuggestions = currentSuggestions.filter(
      (s) => s.transactionId !== transactionId
    );

    // Track dismissed suggestions to prevent them from being re-suggested
    // Write both legacy (string[]) and new (object[]) formats
    const dismissedSuggestions = (fileData.dismissedTransactionIds || []) as string[];
    if (!dismissedSuggestions.includes(transactionId)) {
      dismissedSuggestions.push(transactionId);
    }

    const updateData: Record<string, unknown> = {
      transactionSuggestions: updatedSuggestions,
      dismissedTransactionIds: dismissedSuggestions,
      dismissedTransactions: FieldValue.arrayUnion({
        transactionId,
        dismissedAt: Timestamp.now(),
        confidence: dismissedSuggestion?.confidence ?? null,
      }),
      updatedAt: FieldValue.serverTimestamp(),
    };

    await fileRef.update(updateData);

    console.log(`[dismissTransactionSuggestion] Dismissed suggestion for file ${fileId}`, {
      userId: ctx.userId,
      transactionId,
    });

    return { success: true };
  }
);
