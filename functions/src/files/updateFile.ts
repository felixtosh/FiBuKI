/**
 * Update a file's metadata.
 *
 * NOT the extracted figures: a change to those is a correction, and every
 * correction goes through `updateFileExtractedFields`, which stamps
 * provenance, compares what actually moved, and re-derives the
 * reconciliation flag (#203). This callable used to accept them too, on a
 * path that consolidated the line items into the total — a derivation
 * written as if a person had ruled on it, with no stamp a re-extraction
 * would respect. No caller was left using it; now it refuses.
 */

import { FieldValue } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { cancelPartnerWorkersForFile } from "../utils/cancelWorkers";
import { applyFactChange } from "../fileFacts/applyFactChange";
import { DESCRIPTIVE_FIELDS } from "../fileFacts/handCorrection";

/** The descriptive fields this callable takes by stored name, keyed back to the module's names. */
const DETAIL_KEY_BY_STORED_FIELD: Record<string, string> = Object.fromEntries(
  Object.entries(DESCRIPTIVE_FIELDS)
    .filter(([key]) => key !== "additionalFields")
    .map(([key, stored]) => [stored, key])
);

export interface UpdateFileRequest {
  fileId: string;
  data: {
    // Basic metadata
    fileName?: string;
    thumbnailUrl?: string;
    // Partner assignment
    partnerId?: string | null;
    partnerType?: "user" | "global" | null;
    partnerMatchedBy?: "manual" | "suggestion" | "auto" | "ai" | null;
    partnerMatchConfidence?: number | null;
    // Invoice status
    isNotInvoice?: boolean;
    notInvoiceReason?: string | null;
    invoiceDirection?: "incoming" | "outgoing" | "unknown" | null;
    // Descriptive extraction text (who/where, not figures)
    extractedPartner?: string | null;
    extractedVatId?: string | null;
    extractedIban?: string | null;
    extractedAddress?: string | null;
  };
}

/**
 * The correction vocabulary. Writing any of these here would bypass the
 * provenance stamp, the moved-field comparison and the reconciliation
 * re-derivation that `updateFileExtractedFields` exists to enforce (#203).
 */
const CORRECTION_ONLY_FIELDS = [
  "extractedAmount",
  "extractedVatAmount",
  "extractedVatPercent",
  "extractedDate",
  "extractedLineItems",
  // #217: a hand-set Trinkgeld is a correction like the figures beside it, and
  // its door is the same one. Written here it would carry no stamp, so the next
  // re-extraction would silently drop the only explanation the bank line had.
  "extractedTipAmount",
] as const;

/**
 * What this callable writes, and nothing else. The payload is whatever JSON
 * the caller sent, and the old copy loop forwarded every key of it into the
 * Firestore update — so a caller could set any field on their own file
 * record: a provenance stamp, a derived classification, a review flag. The
 * interface above is the contract; this is the contract enforced.
 */
const WRITABLE_FIELDS = new Set([
  "fileName",
  "thumbnailUrl",
  "partnerId",
  "partnerType",
  "partnerMatchedBy",
  "partnerMatchConfidence",
  "isNotInvoice",
  "notInvoiceReason",
  "invoiceDirection",
  "extractedPartner",
  "extractedVatId",
  "extractedIban",
  "extractedAddress",
]);

interface UpdateFileResponse {
  success: boolean;
}

/**
 * Internal implementation, so the callable and the tool surface
 * (`assign_partner_to_file`, #213) write a File through the same contract.
 */
export async function updateFileInternal(
  db: FirebaseFirestore.Firestore,
  userId: string,
  request: UpdateFileRequest
): Promise<UpdateFileResponse> {
  const ctx = { db, userId };
  const { fileId, data } = request;

  if (!fileId) {
    throw new HttpsError("invalid-argument", "fileId is required");
  }

  // Verify ownership
  const fileRef = ctx.db.collection("files").doc(fileId);
  const fileSnap = await fileRef.get();

  if (!fileSnap.exists) {
    throw new HttpsError("not-found", "File not found");
  }

  if (fileSnap.data()!.userId !== ctx.userId) {
    throw new HttpsError("permission-denied", "Access denied");
  }

  // Cancel running partner automation when user manually assigns or accepts suggestion
  const isManualPartnerAssignment =
    data.partnerId &&
    (data.partnerMatchedBy === "manual" || data.partnerMatchedBy === "suggestion");

  if (isManualPartnerAssignment) {
    cancelPartnerWorkersForFile(ctx.userId, fileId).catch((err) => {
      console.error("[updateFile] Failed to cancel partner workers:", err);
    });
  }

  // Refusing loudly beats stripping silently: a silent strip is the same
  // "correction that looks like it worked" this rule exists to end. The
  // figure fields get the specific message, since they have a correct door.
  const figures = CORRECTION_ONLY_FIELDS.filter(
    (field) => (data as Record<string, unknown>)[field] !== undefined
  );
  if (figures.length > 0) {
    throw new HttpsError(
      "invalid-argument",
      `${figures.join(", ")} cannot be written through updateFile — corrections ` +
        "to the extracted figures go through updateFileExtractedFields"
    );
  }

  const unknown = Object.keys(data).filter(
    (key) => !WRITABLE_FIELDS.has(key) && (data as Record<string, unknown>)[key] !== undefined
  );
  if (unknown.length > 0) {
    throw new HttpsError(
      "invalid-argument",
      `updateFile does not write ${unknown.join(", ")}`
    );
  }

  // The Partner a File points at must be one the caller may use: their own
  // user Partner or a Global Partner. Every user shares one database, so
  // without this a File could name another user's Partner, and everything
  // that later resolves it (names in the UI, matching, the agent's replies)
  // would read that user's record. Not usable answers like not found.
  if (data.partnerId !== undefined || data.partnerType !== undefined) {
    const current = fileSnap.data()!;
    const partnerId = data.partnerId !== undefined ? data.partnerId : current.partnerId;
    const partnerType = data.partnerType !== undefined ? data.partnerType : current.partnerType;
    if (partnerId !== null && partnerId !== undefined) {
      if (typeof partnerId !== "string" || !partnerId || partnerId.includes("/")) {
        throw new HttpsError("invalid-argument", "partnerId must be a document id");
      }
      const partnerSnap = await ctx.db
        .collection(partnerType === "global" ? "globalPartners" : "partners")
        .doc(partnerId)
        .get();
      const usable =
        partnerSnap.exists &&
        (partnerType === "global" || partnerSnap.data()?.userId === ctx.userId);
      if (!usable) {
        throw new HttpsError("not-found", "Partner not found");
      }
    }
  }

  // The direction and the descriptive extracted fields are a File's extracted
  // facts: setting them is a Hand Correction from the UI, which the File facts
  // module decides and its applier writes (#638), the same as the detail
  // panel's save. The § 11 classification, the direction review, the Hand
  // Correction record a re-extraction refuses on (#233, #184) and the
  // re-score all come with it. Everything else here is metadata.
  const correction: Record<string, unknown> = {};
  const details: Record<string, unknown> = {};
  const updateData: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (key === "invoiceDirection") correction[key] = value;
    else if (DETAIL_KEY_BY_STORED_FIELD[key]) details[DETAIL_KEY_BY_STORED_FIELD[key]] = value;
    else updateData[key] = value;
  }

  let factFields: string[] = [];
  if (Object.keys(correction).length > 0 || Object.keys(details).length > 0) {
    const result = await applyFactChange(ctx.db, {
      fileId,
      userId: ctx.userId,
      change: { origin: "ui-correction", correction, details },
    });
    if (result.refused) {
      throw new HttpsError(result.code === "NOT_FOUND" ? "not-found" : "invalid-argument", result.message);
    }
    factFields = Object.keys(result.update);
  }

  if (Object.keys(updateData).length > 0) {
    updateData.updatedAt = FieldValue.serverTimestamp();
    await fileRef.update(updateData);
  }

  console.log(`[updateFile] Updated file ${fileId}`, {
    userId: ctx.userId,
    fields: [...Object.keys(updateData), ...factFields],
  });

  return { success: true };
}

export const updateFileCallable = createCallable<
  UpdateFileRequest,
  UpdateFileResponse
>(
  { name: "updateFile" },
  async (ctx, request) => updateFileInternal(ctx.db, ctx.userId, request)
);
