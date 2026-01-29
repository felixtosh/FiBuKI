/**
 * Callable function to initiate a user data export.
 * Creates a userExports document that triggers the queue processor.
 */

import { createCallable } from "../utils/createCallable";
import { FieldValue } from "firebase-admin/firestore";
import {
  UserExportRequest,
  UserExportResponse,
  UserExport,
  EXPORT_EXPIRY_DAYS,
} from "../types/user-export";

export const requestUserExportCallable = createCallable<
  UserExportRequest,
  UserExportResponse
>(
  {
    name: "requestUserExport",
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (ctx, request) => {
    const { userId, db } = ctx;
    const { includeStorageFiles } = request;

    // Check if there's already a pending/processing export
    const existingExport = await db
      .collection("userExports")
      .where("userId", "==", userId)
      .where("status", "in", ["pending", "processing"])
      .limit(1)
      .get();

    if (!existingExport.empty) {
      // Return existing export ID
      const existingDoc = existingExport.docs[0];
      return {
        success: true,
        exportId: existingDoc.id,
      };
    }

    // Create new export document
    const exportRef = db.collection("userExports").doc();

    // Calculate expiry date
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + EXPORT_EXPIRY_DAYS);

    const exportDoc: Omit<UserExport, "id"> = {
      userId,
      status: "pending",
      includeStorageFiles: includeStorageFiles ?? false,
      progress: {
        phase: "collecting",
        current: 0,
        total: 0,
      },
      counts: {
        sources: 0,
        transactions: 0,
        files: 0,
        partners: 0,
        categories: 0,
        noReceiptCategories: 0,
        fileConnections: 0,
      },
      retryCount: 0,
      maxRetries: 3,
      createdAt: FieldValue.serverTimestamp() as any,
    };

    await exportRef.set(exportDoc);

    console.log(`[requestUserExport] Created export ${exportRef.id} for user ${userId}`);

    return {
      success: true,
      exportId: exportRef.id,
    };
  }
);
