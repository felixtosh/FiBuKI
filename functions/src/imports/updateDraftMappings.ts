/**
 * Update field mappings on a draft import.
 * Called when user edits column mappings to persist their changes.
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

interface UpdateDraftMappingsRequest {
  importId: string;
  fieldMappings: FieldMapping[];
}

interface UpdateDraftMappingsResponse {
  success: boolean;
}

export const updateDraftMappingsCallable = createCallable<
  UpdateDraftMappingsRequest,
  UpdateDraftMappingsResponse
>(
  { name: "updateDraftMappings" },
  async (ctx, request) => {
    const { importId, fieldMappings } = request;

    if (!importId || !fieldMappings) {
      throw new HttpsError(
        "invalid-argument",
        "importId and fieldMappings are required"
      );
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

    // Verify it's still a draft
    if (importData.status !== "draft") {
      throw new HttpsError(
        "failed-precondition",
        "Cannot update mappings on a completed import"
      );
    }

    // Update the mappings
    await importRef.update({
      fieldMappings,
      updatedAt: Timestamp.now(),
    });

    console.log(`[updateDraftMappings] Updated mappings for ${importId}`, {
      userId: ctx.userId,
      mappingCount: fieldMappings.length,
    });

    return { success: true };
  }
);
