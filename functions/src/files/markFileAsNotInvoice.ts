/**
 * Mark a file as "not an invoice" (user override)
 * Clears extracted data and resets downstream matching.
 * Preserves manually-set partner assignments.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import { buildMarkNotInvoiceUpdates } from "./notInvoiceOps";

interface MarkFileAsNotInvoiceRequest {
  fileId: string;
  reason?: string;
}

interface MarkFileAsNotInvoiceResponse {
  success: boolean;
}

export const markFileAsNotInvoiceCallable = createCallable<
  MarkFileAsNotInvoiceRequest,
  MarkFileAsNotInvoiceResponse
>(
  { name: "markFileAsNotInvoice" },
  async (ctx, request) => {
    const { fileId, reason } = request;

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

    await fileRef.update(buildMarkNotInvoiceUpdates(fileData, reason));

    console.log(`[markFileAsNotInvoice] Marked file ${fileId} as not invoice`, {
      userId: ctx.userId,
      reason: reason || "Marked by user",
    });

    return { success: true };
  }
);
