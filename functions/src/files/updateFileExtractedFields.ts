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

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import type { ExtractedLineItem, ExtractedRateGroup } from "../types/extraction";
import { reconcileLineItemsWithDocumentTotal } from "../extraction/lineItemReconciliation";
import {
  ExtractionCorrectionError,
  FileExtractionCorrection,
  selectMovedCorrections,
} from "./extractionCorrectionOps";
import { buildCorrectedFileUpdate } from "./correctedFileUpdate";
import { CORRECTABLE_FIELDS, correctedFieldsOf } from "./extractionProvenanceOps";
import { syncDocumentationStateForTransactions } from "../documents/syncDocumentationState";
import { retireRepairAmbiguity } from "../documents/repairReview";
import { dueDateFromAdditionalFields } from "../matching/dueDate";
import { debitDateFromAdditionalFields } from "../matching/debitDate";
import { toDateSafe } from "../utils/toDateSafe";
import { isAdditionalFieldKey, normalizePaymentMethod } from "../extraction/fieldVocabulary";

/** An extra field the extractor kept but nothing else reads structurally. */
interface EditedAdditionalField {
  /** Canonical key from the extraction vocabulary (#252); absent on a row a person added. */
  key?: string;
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
  /**
   * The tip in this correction is not printed on the invoice (#310), so the
   * document total does not bound it (#554). Sent
   * beside `correction` rather than inside it because it is not a value the
   * record keeps per field: it says how to read the tip, and what it decided
   * is stored as `extractedTipBound`.
   */
  tipNotPrinted?: boolean;
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
    const { fileId, correction = {}, details = {}, tipNotPrinted } = request;

    if (!fileId) {
      throw new HttpsError("invalid-argument", "fileId is required");
    }

    if (tipNotPrinted !== undefined && typeof tipNotPrinted !== "boolean") {
      throw new HttpsError("invalid-argument", "tipNotPrinted must be a boolean");
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
        const built = await buildCorrectedFileUpdate(ctx.db, moved, record, {
          tipNotPrinted: tipNotPrinted === true,
        });
        Object.assign(updates, built.updates);
        changed = built.changed;
      } catch (error) {
        if (error instanceof ExtractionCorrectionError) {
          throw new HttpsError("invalid-argument", error.message);
        }
        throw error;
      }
    }

    // Fork #64/#67 read a save with the itemisation editor open as "this
    // person has settled the file" and cleared the review artefacts wholesale.
    // #203 showed what that costs: the clear removed both the flag the UVA's
    // amount-mismatch guard tests and the printed rate-group block that is its
    // other escape, so a save that changed NOTHING silently turned a refused
    // file into one contributing VAT summed from an incomplete itemisation.
    // A save that moved a figure re-derives the flag inside the builder above;
    // an untouched save re-derives it here against the stored record — with
    // its printed block still standing, which a save that corrected nothing
    // says nothing against — and writes only when the answer differs. A file
    // whose items genuinely contradict its total therefore stays flagged until
    // someone completes the itemisation, clears it, or corrects the total.
    if (correction.lineItems !== undefined && updates.lineItemsUnreconciled === undefined) {
      const items = record.extractedLineItems as ExtractedLineItem[] | null | undefined;
      const reconciled = reconcileLineItemsWithDocumentTotal(
        Array.isArray(items) ? items : [],
        (record.extractedAmount as number | null | undefined) ?? null,
        (record.extractedRateGroups as ExtractedRateGroup[] | null | undefined) ?? null,
        (record.extractedVatPercent as number | null | undefined) ?? null
      );
      if (reconciled.unreconciled !== Boolean(record.lineItemsUnreconciled)) {
        updates.lineItemsUnreconciled = reconciled.unreconciled;
        updates.lineItemsUnreconciledRates =
          reconciled.unreconciledRates.length > 0 ? reconciled.unreconciledRates : null;
      }
    }

    const movedDetails: string[] = [];
    for (const [key, storedField] of Object.entries(DETAIL_FIELD)) {
      const value = details[key as keyof ExtractedDetails];
      if (value === undefined) continue;
      updates[storedField] =
        key === "additionalFields"
          ? normalizeAdditionalFields(value, record.extractedAdditionalFields)
          : normalizeText(value, key);
      if (key !== "additionalFields" && updates[storedField] !== (record[storedField] ?? null)) {
        movedDetails.push(storedField);
      }
    }

    // #236: the typed Due Date is read off these rows, so an edit to them
    // re-reads it. A person who corrects or deletes the Due Date row moves
    // the payment window the Match scores against. Read against the issue
    // date this same save settles on, so a due date earlier than it is
    // rejected rather than written, since it would invert the window (#135).
    if (details.additionalFields !== undefined) {
      const issueDate = toDateSafe(
        updates.extractedDate !== undefined ? updates.extractedDate : record.extractedDate
      );
      const dueDate = dueDateFromAdditionalFields(updates.extractedAdditionalFields, issueDate);
      updates.extractedDueDate = dueDate ? Timestamp.fromDate(dueDate) : null;
      const debitDate = debitDateFromAdditionalFields(updates.extractedAdditionalFields, issueDate);
      updates.extractedDebitDate = debitDate ? Timestamp.fromDate(debitDate) : null;
    }

    // #301: a detail typed over retires the repair warning for that field, the
    // same as a figure does inside the builder. Measured against what the
    // builder already left, so a save that corrects both kinds retires both.
    if (movedDetails.length > 0) {
      const flagged = { ...record, ...updates };
      Object.assign(updates, retireRepairAmbiguity(flagged, movedDetails));
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

/**
 * Label/value pairs, each under a key from the closed vocabulary (#252, #540).
 *
 * A row with a key outside the vocabulary is refused rather than dropped: the
 * editor only offers vocabulary keys, so anything else is a stale or hostile
 * client, and silently losing a row a person typed is worse than saying so.
 * A row WITHOUT a key is legacy: stored before the vocabulary closed. It is
 * carried through a save (its value may be edited) only when the stored record
 * already holds a keyless row under the same label, so the open bag cannot be
 * re-created by hand.
 */
function normalizeAdditionalFields(
  value: unknown,
  stored: unknown
): Array<Record<string, string>> | null {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new HttpsError("invalid-argument", "additionalFields must be an array or null");
  }
  const legacyLabels = new Set(
    (Array.isArray(stored) ? stored : [])
      .map((raw) => (raw ?? {}) as Partial<EditedAdditionalField>)
      .filter((field) => !field.key && typeof field.label === "string")
      .map((field) => (field.label as string).trim())
  );

  const fields = value
    .map((raw) => (raw ?? {}) as Partial<EditedAdditionalField>)
    .filter((field) => typeof field.label === "string" && typeof field.value === "string")
    .map((field) => {
      const hasKey = typeof field.key === "string" && field.key !== "";
      if (hasKey && !isAdditionalFieldKey(field.key)) {
        throw new HttpsError("invalid-argument", `additionalFields: unknown key "${field.key}"`);
      }
      const label = (field.label as string).trim();
      const text = (field.value as string).trim();
      return {
        ...(hasKey ? { key: field.key as string } : {}),
        label,
        value: field.key === "paymentMethod" ? normalizePaymentMethod(text) : text,
        rawValue: typeof field.rawValue === "string" ? field.rawValue.trim() : text,
      };
    })
    .filter((field) => field.label && field.value)
    .filter((field) => field.key !== undefined || legacyLabels.has(field.label));

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
