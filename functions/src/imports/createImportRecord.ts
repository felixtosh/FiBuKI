/**
 * Create an import record after transaction import completes.
 * If importJobId refers to an existing draft, updates it to completed status.
 * Otherwise creates a new import record (for backwards compatibility).
 */

import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";

interface FieldMapping {
  csvColumn: string;
  targetField: string | null;
  confidence: number;
  userConfirmed: boolean;
  keepAsMetadata: boolean;
  format?: string | null;
}

interface ParseOptions {
  delimiter?: string;
  encoding?: string;
  hasHeader?: boolean;
  skipRows?: number;
}

interface CreateImportRecordRequest {
  importJobId: string;
  sourceId: string;
  fileName: string;
  importedCount: number;
  skippedCount: number;
  errorCount: number;
  totalRows: number;
  csvStoragePath?: string | null;
  csvDownloadUrl?: string | null;
  parseOptions?: ParseOptions | null;
  fieldMappings?: FieldMapping[] | null;
}

interface CreateImportRecordResponse {
  success: boolean;
  importId: string;
}

export const createImportRecordCallable = createCallable<
  CreateImportRecordRequest,
  CreateImportRecordResponse
>(
  { name: "createImportRecord" },
  async (ctx, request) => {
    const {
      importJobId,
      sourceId,
      fileName,
      importedCount,
      skippedCount,
      errorCount,
      totalRows,
      csvStoragePath,
      csvDownloadUrl,
      parseOptions,
      fieldMappings,
    } = request;

    if (!importJobId || !sourceId || !fileName) {
      throw new HttpsError(
        "invalid-argument",
        "importJobId, sourceId, and fileName are required"
      );
    }

    // Verify source ownership
    const sourceRef = ctx.db.collection("sources").doc(sourceId);
    const sourceSnap = await sourceRef.get();

    if (!sourceSnap.exists) {
      throw new HttpsError("not-found", "Source not found");
    }

    if (sourceSnap.data()!.userId !== ctx.userId) {
      throw new HttpsError("permission-denied", "Source access denied");
    }

    const importDocRef = ctx.db.collection("imports").doc(importJobId);
    const existingImport = await importDocRef.get();

    // Check if this is completing an existing draft
    if (existingImport.exists) {
      const existingData = existingImport.data()!;

      // Verify ownership of existing draft
      if (existingData.userId !== ctx.userId) {
        throw new HttpsError("permission-denied", "Import access denied");
      }

      // Only allow completing drafts, not re-completing completed imports
      if (existingData.status === "completed") {
        console.log(
          `[createImportRecord] Import ${importJobId} already completed, skipping`,
          { userId: ctx.userId }
        );
        return {
          success: true,
          importId: importJobId,
        };
      }

      // Update draft to completed status
      const updateData = {
        status: "completed",
        importedCount: importedCount || 0,
        skippedCount: skippedCount || 0,
        errorCount: errorCount || 0,
        totalRows: totalRows || existingData.totalRows || 0,
        updatedAt: Timestamp.now(),
        // Remove expiration since it's now completed
        expiresAt: FieldValue.delete(),
        // Update mappings if provided (user may have edited them)
        ...(fieldMappings && { fieldMappings }),
        ...(parseOptions && { parseOptions }),
        // Update CSV storage if provided (may have been re-uploaded)
        ...(csvStoragePath !== undefined && {
          csvStoragePath: csvStoragePath ?? null,
        }),
        ...(csvDownloadUrl !== undefined && {
          csvDownloadUrl: csvDownloadUrl ?? null,
        }),
      };

      await importDocRef.update(updateData);

      console.log(
        `[createImportRecord] Completed draft import ${importJobId}`,
        {
          userId: ctx.userId,
          sourceId,
          importedCount,
          skippedCount,
          errorCount,
        }
      );

      return {
        success: true,
        importId: importJobId,
      };
    }

    // Create new import record (backwards compatibility for non-draft imports)
    const importRecordData = {
      sourceId,
      fileName,
      status: "completed", // New imports are created as completed
      importedCount: importedCount || 0,
      skippedCount: skippedCount || 0,
      errorCount: errorCount || 0,
      totalRows: totalRows || 0,
      userId: ctx.userId,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      // CSV storage fields - use null for queryability
      csvStoragePath: csvStoragePath ?? null,
      csvDownloadUrl: csvDownloadUrl ?? null,
      // Parse options and mappings for re-mapping feature
      parseOptions: parseOptions ?? null,
      fieldMappings: fieldMappings ?? null,
    };

    await importDocRef.set(importRecordData);

    console.log(`[createImportRecord] Created import record ${importJobId}`, {
      userId: ctx.userId,
      sourceId,
      importedCount,
      skippedCount,
      errorCount,
    });

    return {
      success: true,
      importId: importJobId,
    };
  }
);
