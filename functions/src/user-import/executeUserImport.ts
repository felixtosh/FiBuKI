/**
 * Callable function to execute a validated import.
 * Requires explicit confirmation to wipe existing data.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import { FieldValue } from "firebase-admin/firestore";

import {
  ExecuteUserImportRequest,
  ExecuteUserImportResponse,
} from "../types/user-export";

export const executeUserImportCallable = createCallable<
  ExecuteUserImportRequest,
  ExecuteUserImportResponse
>(
  {
    name: "executeUserImport",
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (ctx, request) => {
    const { userId, db } = ctx;
    const { importId, confirmWipe } = request;

    if (!importId) {
      throw new HttpsError("invalid-argument", "importId is required");
    }

    if (!confirmWipe) {
      throw new HttpsError(
        "failed-precondition",
        "Must confirm data wipe to proceed with import"
      );
    }

    // Get the import record
    const importRef = db.collection("userImports").doc(importId);
    const importDoc = await importRef.get();

    if (!importDoc.exists) {
      throw new HttpsError("not-found", "Import record not found");
    }

    const importData = importDoc.data();

    // Verify ownership
    if (importData?.userId !== userId) {
      throw new HttpsError("permission-denied", "Import does not belong to user");
    }

    // Verify status
    if (importData?.status !== "pending") {
      throw new HttpsError(
        "failed-precondition",
        `Cannot execute import with status: ${importData?.status}`
      );
    }

    // Verify validation passed
    if (!importData?.validation?.valid) {
      throw new HttpsError("failed-precondition", "Import validation failed");
    }

    // Update status to trigger queue processor
    await importRef.update({
      status: "validating",
      startedAt: FieldValue.serverTimestamp(),
      "progress.phase": "validating",
    });

    console.log(`[executeUserImport] Started import ${importId} for user ${userId}`);

    return {
      success: true,
    };
  }
);
