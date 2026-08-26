/**
 * Unmark a file as "not an invoice" (restore as invoice)
 * Triggers re-extraction while preserving manually-set partner and transactions.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import { buildUnmarkNotInvoiceUpdates } from "./notInvoiceOps";

interface UnmarkFileAsNotInvoiceRequest {
  fileId: string;
}

interface UnmarkFileAsNotInvoiceResponse {
  success: boolean;
}

export const unmarkFileAsNotInvoiceCallable = createCallable<
  UnmarkFileAsNotInvoiceRequest,
  UnmarkFileAsNotInvoiceResponse
>(
  { name: "unmarkFileAsNotInvoice" },
  async (ctx, request) => {
    const { fileId } = request;

    if (!fileId) {
      throw new HttpsError("invalid-argument", "fileId is required");
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

    // Check for manual transaction connections before resetting transaction matching
    const connectionsQuery = await ctx.db
      .collection("fileConnections")
      .where("fileId", "==", fileId)
      .where("connectionType", "==", "manual")
      .get();

    await fileRef.update(buildUnmarkNotInvoiceUpdates(fileData, !connectionsQuery.empty));

    console.log(`[unmarkFileAsNotInvoice] Unmarked file ${fileId} as invoice`, {
      userId: ctx.userId,
    });

    return { success: true };
  }
);
