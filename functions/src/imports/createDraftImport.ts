/**
 * Create a draft import record immediately after CSV upload.
 * This allows users to save their import progress and resume later.
 */

import { Timestamp } from "firebase-admin/firestore";
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

interface CreateDraftImportRequest {
  sourceId: string;
  fileName: string;
  csvHash: string;
  csvStoragePath: string;
  csvDownloadUrl: string;
  parseOptions: ParseOptions;
  detectedHeaders: string[];
  sampleRows: Record<string, string>[];
  totalRows: number;
  fieldMappings?: FieldMapping[] | null;
}

interface CreateDraftImportResponse {
  success: boolean;
  importId: string;
  /** If a draft with the same CSV hash already exists, returns its ID */
  existingDraftId?: string;
}

const DRAFT_EXPIRATION_DAYS = 7;

export const createDraftImportCallable = createCallable<
  CreateDraftImportRequest,
  CreateDraftImportResponse
>(
  { name: "createDraftImport" },
  async (ctx, request) => {
    const {
      sourceId,
      fileName,
      csvHash,
      csvStoragePath,
      csvDownloadUrl,
      parseOptions,
      detectedHeaders,
      sampleRows,
      totalRows,
      fieldMappings,
    } = request;

    // Validate required fields
    if (!sourceId || !fileName || !csvHash || !csvStoragePath) {
      throw new HttpsError(
        "invalid-argument",
        "sourceId, fileName, csvHash, and csvStoragePath are required"
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

    // Check for existing draft with same CSV hash for this source
    const existingDraftQuery = await ctx.db
      .collection("imports")
      .where("sourceId", "==", sourceId)
      .where("status", "==", "draft")
      .where("csvHash", "==", csvHash)
      .limit(1)
      .get();

    if (!existingDraftQuery.empty) {
      const existingDraft = existingDraftQuery.docs[0];
      console.log(
        `[createDraftImport] Found existing draft ${existingDraft.id} with same CSV hash`,
        { userId: ctx.userId, sourceId, csvHash }
      );

      return {
        success: true,
        importId: existingDraft.id,
        existingDraftId: existingDraft.id,
      };
    }

    // Calculate expiration date (7 days from now)
    const expiresAt = Timestamp.fromMillis(
      Date.now() + DRAFT_EXPIRATION_DAYS * 24 * 60 * 60 * 1000
    );

    // Create the draft import record
    const importDocRef = ctx.db.collection("imports").doc();

    const draftData = {
      sourceId,
      fileName,
      status: "draft",
      csvHash,
      csvStoragePath,
      csvDownloadUrl,
      parseOptions: parseOptions ?? null,
      detectedHeaders: detectedHeaders ?? [],
      sampleRows: sampleRows ?? [],
      totalRows: totalRows ?? 0,
      fieldMappings: fieldMappings ?? null,
      userId: ctx.userId,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      expiresAt,
      // These will be set when the import completes
      importedCount: null,
      skippedCount: null,
      errorCount: null,
    };

    await importDocRef.set(draftData);

    console.log(`[createDraftImport] Created draft import ${importDocRef.id}`, {
      userId: ctx.userId,
      sourceId,
      fileName,
      csvHash: csvHash.substring(0, 8) + "...",
      expiresAt: expiresAt.toDate().toISOString(),
    });

    return {
      success: true,
      importId: importDocRef.id,
    };
  }
);
