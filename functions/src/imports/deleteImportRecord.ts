/**
 * Delete an import record and its associated CSV file.
 * Uses Admin SDK to delete from Firebase Storage.
 */

import { getStorage } from "firebase-admin/storage";
import { createCallable, HttpsError } from "../utils/createCallable";
import { detachTransactions } from "../fileConnections/writer";

interface DeleteImportRecordRequest {
  importId: string;
}

interface DeleteImportRecordResponse {
  success: boolean;
  deletedTransactions: number;
}

export const deleteImportRecordCallable = createCallable<
  DeleteImportRecordRequest,
  DeleteImportRecordResponse
>(
  { name: "deleteImportRecord", timeoutSeconds: 300 },
  async (ctx, request) => {
    const { importId } = request;

    if (!importId) {
      throw new HttpsError("invalid-argument", "importId is required");
    }

    // Get the import record
    const importRef = ctx.db.collection("imports").doc(importId);
    const importSnap = await importRef.get();

    if (!importSnap.exists) {
      throw new HttpsError("not-found", "Import not found");
    }

    const importData = importSnap.data()!;

    // Verify ownership
    if (importData.userId !== ctx.userId) {
      throw new HttpsError("permission-denied", "Import access denied");
    }

    // Delete CSV file from storage if it exists
    if (importData.csvStoragePath) {
      try {
        const bucket = getStorage().bucket();
        await bucket.file(importData.csvStoragePath).delete();
        console.log(
          `[deleteImportRecord] Deleted CSV file ${importData.csvStoragePath}`
        );
      } catch (error) {
        // Log but don't fail if file doesn't exist
        console.warn(
          `[deleteImportRecord] Could not delete CSV file: ${error}`
        );
      }
    }

    // Find and delete all transactions with this importJobId
    const txQuery = ctx.db
      .collection("transactions")
      .where("importJobId", "==", importId)
      .where("userId", "==", ctx.userId);

    const txSnapshot = await txQuery.get();
    let deletedTransactions = 0;

    // Batch delete transactions (Firestore has 500 doc limit per batch)
    const BATCH_SIZE = 500;
    const docs = txSnapshot.docs;

    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const chunk = docs.slice(i, i + BATCH_SIZE);
      // Take every File off them first, through the File Connection writer
      // (#612): only these Transactions leave the Files' lists, and their
      // records go with them.
      await detachTransactions(
        ctx.db,
        ctx.userId,
        chunk.map((d) => ({ id: d.id, data: d.data() }))
      );

      const batch = ctx.db.batch();
      for (const txDoc of chunk) {
        batch.delete(txDoc.ref);
        deletedTransactions++;
      }

      await batch.commit();
    }

    // Delete the import record
    await importRef.delete();

    console.log(`[deleteImportRecord] Deleted import ${importId}`, {
      userId: ctx.userId,
      deletedTransactions,
    });

    return {
      success: true,
      deletedTransactions,
    };
  }
);
