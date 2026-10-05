/**
 * Callable function to initiate a BMD NTCS export.
 * Creates a bmdExports document that triggers the queue processor.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import {
  BmdExportRequest,
  BmdExportResponse,
  BmdExport,
} from "../types/bmd-export";

export const requestBmdExportCallable = createCallable<
  BmdExportRequest,
  BmdExportResponse
>(
  {
    name: "requestBmdExport",
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (ctx, request) => {
    const { userId, db } = ctx;
    const { dateFrom, dateTo, onlyWithFiles, includeFiles } = request;

    // Validate dates
    const fromDate = new Date(dateFrom);
    const toDate = new Date(dateTo);

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      throw new HttpsError("invalid-argument", "Invalid date range");
    }

    if (fromDate > toDate) {
      throw new HttpsError(
        "invalid-argument",
        "dateFrom must be before dateTo"
      );
    }

    // Check if there's already a pending/processing export
    const existingExport = await db
      .collection("bmdExports")
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
    const exportRef = db.collection("bmdExports").doc();

    const exportDoc: Omit<BmdExport, "id"> = {
      userId,
      status: "pending",
      dateFrom: Timestamp.fromDate(fromDate),
      dateTo: Timestamp.fromDate(toDate),
      onlyWithFiles: onlyWithFiles ?? true,
      includeFiles: includeFiles ?? true,
      progress: {
        phase: "collecting",
        current: 0,
        total: 0,
      },
      counts: {
        transactions: 0,
        files: 0,
        partners: 0,
        kreditoren: 0,
        debitoren: 0,
      },
      retryCount: 0,
      maxRetries: 3,
      createdAt: FieldValue.serverTimestamp() as any,
    };

    await exportRef.set(exportDoc);

    console.log(
      `[requestBmdExport] Created BMD export ${exportRef.id} for user ${userId}, date range: ${dateFrom} to ${dateTo}`
    );

    return {
      success: true,
      exportId: exportRef.id,
    };
  }
);
