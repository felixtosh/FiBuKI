/**
 * The file detail panel's save, as a callable (#149).
 *
 * The panel used to write the extracted record straight to Firestore from the
 * browser. That is a direct client write of a business decision — the thing the
 * Cloud Functions pattern in CLAUDE.md exists to prevent — and it had a
 * concrete cost: the provenance stamp #147 introduced is written inside
 * `buildExtractionCorrection`, which only the MCP tool went through, so a
 * correction typed by a person was re-rolled by the next
 * `retry_file_extraction` while the same correction made by an agent was
 * protected. The UI is the common case, so the guard covered the rarer half.
 *
 * Two things stay on the server because they are the same decision twice:
 *
 *   - *what a correction does* — `buildCorrectedFileUpdate`, shared with the
 *     MCP tool, including the derived § 11 classification and rate-review flag.
 *   - *what actually moved* — `selectMovedCorrections`. The panel posts the
 *     whole record on every save, so without that comparison the first save of
 *     an untouched file would mark all five fields hand-corrected and freeze it
 *     against re-extraction for good.
 *
 * The panel keeps its string parsing (a currency field is a UI concern) and
 * sends typed values: cents, an ISO date, normalised line items.
 */

import { FieldValue } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import {
  ExtractionCorrectionError,
  FileExtractionCorrection,
  selectMovedCorrections,
} from "./extractionCorrectionOps";
import { buildCorrectedFileUpdate } from "./correctedFileUpdate";
import { CORRECTABLE_FIELDS, correctedFieldsOf } from "./extractionProvenanceOps";
import { syncDocumentationStateForTransactions } from "../documents/syncDocumentationState";

/** An extra field the extractor kept but nothing else reads structurally. */
interface EditedAdditionalField {
  label: string;
  value: string;
  rawValue?: string;
}

/**
 * The half of the form that is description rather than judgement: who the
 * counterparty is, their VAT id, the address on the page. None of it is a
 * ruling on the figures, so none of it stamps provenance.
 */
interface ExtractedDetails {
  partner?: string | null;
  vatId?: string | null;
  iban?: string | null;
  address?: string | null;
  additionalFields?: EditedAdditionalField[] | null;
}

interface UpdateFileExtractedFieldsRequest {
  fileId: string;
  /** Correctable values, already typed. Omitted is not null — see the builder. */
  correction?: FileExtractionCorrection;
  details?: ExtractedDetails;
}

interface UpdateFileExtractedFieldsResponse {
  success: boolean;
  /** The fields this save moved. Empty when the person changed nothing. */
  changed: string[];
  /** Every field a person has ever ruled on, which re-extraction refuses on. */
  correctedFields: string[];
}

const DETAIL_FIELD: Record<keyof ExtractedDetails, string> = {
  partner: "extractedPartner",
  vatId: "extractedVatId",
  iban: "extractedIban",
  address: "extractedAddress",
  additionalFields: "extractedAdditionalFields",
};

export const updateFileExtractedFieldsCallable = createCallable<
  UpdateFileExtractedFieldsRequest,
  UpdateFileExtractedFieldsResponse
>(
  { name: "updateFileExtractedFields" },
  async (ctx, request) => {
    const { fileId, correction = {}, details = {} } = request;

    if (!fileId) {
      throw new HttpsError("invalid-argument", "fileId is required");
    }

    const fileRef = ctx.db.collection("files").doc(fileId);
    const fileSnap = await fileRef.get();

    if (!fileSnap.exists || fileSnap.data()?.userId !== ctx.userId) {
      throw new HttpsError("not-found", "File not found");
    }

    const record = fileSnap.data()!;
    const moved = selectMovedCorrections(sanitizeCorrection(correction), record);

    const updates: Record<string, unknown> = {};
    let changed: string[] = [];

    if (Object.keys(moved).length > 0) {
      try {
        const built = await buildCorrectedFileUpdate(ctx.db, moved, record);
        Object.assign(updates, built.updates);
        changed = built.changed;
      } catch (error) {
        if (error instanceof ExtractionCorrectionError) {
          throw new HttpsError("invalid-argument", error.message);
        }
        throw error;
      }
    }

    // Fork #64/#67: a person who has the itemisation editor open in front of
    // them and saves has settled this file, whether or not they retyped a row —
    // so the artefacts that would keep it in the review bucket come off, the
    // same as they did when the panel wrote the document itself. That is an
    // acknowledgement, not a ruling on a figure, so it stamps nothing; a save
    // that did move a row goes through the builder above and clears them there
    // as well.
    if (correction.lineItems !== undefined) {
      updates.lineItemsUnreconciled = false;
      updates.lineItemsUnreconciledRates = null;
      updates.extractedRateGroups = null;
      updates.vatSourceDowngraded = false;
      updates.vatFieldsPreserved = false;
    }

    for (const [key, storedField] of Object.entries(DETAIL_FIELD)) {
      const value = details[key as keyof ExtractedDetails];
      if (value === undefined) continue;
      updates[storedField] =
        key === "additionalFields"
          ? normalizeAdditionalFields(value)
          : normalizeText(value, key);
    }

    if (Object.keys(updates).length === 0) {
      return { success: true, changed: [], correctedFields: correctedFieldsOf(record) };
    }

    updates.updatedAt = updates.updatedAt ?? FieldValue.serverTimestamp();

    await fileRef.update(updates);

    // The stored documentation state of a connected transaction is derived from
    // the file's document type, so a correction that reclassifies the file has
    // to move it too — the same follow-up the MCP tool makes (#104).
    const connectedTransactionIds = (record.transactionIds as string[] | undefined) ?? [];
    if (
      updates.documentType !== undefined &&
      updates.documentType !== record.documentType &&
      connectedTransactionIds.length > 0
    ) {
      await syncDocumentationStateForTransactions(ctx.db, connectedTransactionIds);
    }

    const after = (await fileRef.get()).data() ?? {};

    console.log(`[updateFileExtractedFields] Saved file ${fileId}`, {
      userId: ctx.userId,
      changed,
    });

    return { success: true, changed, correctedFields: correctedFieldsOf(after) };
  }
);

/**
 * The descriptive boxes are free text, so they are taken as text and nothing
 * else. The browser used to write this document directly, which is exactly why
 * the shape is checked now that a callable owns the write.
 */
function normalizeText(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", `${field} must be a string or null`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Label/value pairs the extractor kept, taken as pairs of text. */
function normalizeAdditionalFields(value: unknown): Array<Record<string, string>> | null {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new HttpsError("invalid-argument", "additionalFields must be an array or null");
  }

  const fields = value
    .map((raw) => (raw ?? {}) as Partial<EditedAdditionalField>)
    .filter((field) => typeof field.label === "string" && typeof field.value === "string")
    .map((field) => ({
      label: (field.label as string).trim(),
      value: (field.value as string).trim(),
      rawValue:
        typeof field.rawValue === "string" ? field.rawValue.trim() : (field.value as string).trim(),
    }))
    .filter((field) => field.label && field.value);

  return fields.length > 0 ? fields : null;
}

/**
 * Take only the keys the correction vocabulary defines, so an extra key posted
 * by a stale client cannot reach the update map. Values are left as they came:
 * validating them is the builder's job, and a value it refuses must produce its
 * error rather than be quietly dropped here.
 */
function sanitizeCorrection(correction: FileExtractionCorrection): FileExtractionCorrection {
  const clean: Record<string, unknown> = {};
  for (const key of CORRECTABLE_FIELDS) {
    const value = (correction as Record<string, unknown>)[key];
    if (value !== undefined) {
      clean[key] = value;
    }
  }
  return clean as FileExtractionCorrection;
}
