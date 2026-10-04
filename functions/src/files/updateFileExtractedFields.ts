/**
 * The file detail panel's save, as a callable (#149). A Hand Correction from
 * the UI door: the File facts module decides the update and its follow-ups,
 * its applier writes them (#638).
 *
 * The panel used to write the extracted record straight to Firestore from the
 * browser. That is a direct client write of a business decision — the thing the
 * Cloud Functions pattern in CLAUDE.md exists to prevent — and it had a
 * concrete cost: the provenance stamp #147 introduced is written inside
 * the correction builder, which only the MCP tool went through, so a
 * correction typed by a person was re-rolled by the next
 * `retry_file_extraction` while the same correction made by an agent was
 * protected. The UI is the common case, so the guard covered the rarer half.
 *
 * Two things stay on the server because they are the same decision twice:
 *
 *   - *what a correction does*: the File facts module, shared with the MCP
 *     tool, including every derived field.
 *   - *what actually moved*: the module's rule for this door. The panel posts
 *     the whole record on every save, so without that comparison the first
 *     save of an untouched file would mark all five fields hand-corrected and
 *     freeze it against re-extraction for good.
 *
 * The panel keeps its string parsing (a currency field is a UI concern) and
 * sends typed values: cents, an ISO date, normalised line items.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import type { ExtractedDetails, FileExtractionCorrection } from "../fileFacts/handCorrection";
import { correctedFieldsOf } from "../fileFacts/provenance";
import { applyFactChange } from "../fileFacts/applyFactChange";

interface UpdateFileExtractedFieldsRequest {
  fileId: string;
  /** Correctable values, already typed. Omitted is not null. */
  correction?: FileExtractionCorrection;
  /**
   * The tip in this correction is not printed on the invoice (#310), so the
   * document total does not bound it (#554). Sent beside `correction` rather
   * than inside it because it is not a value the record keeps per field: it
   * says how to read the tip, and what it decided is stored as
   * `extractedTipBound`.
   */
  tipNotPrinted?: boolean;
  details?: ExtractedDetails;
}

interface UpdateFileExtractedFieldsResponse {
  success: boolean;
  /** The fields this save recorded. Empty when the person changed nothing. */
  changed: string[];
  /** Every field a person has ever ruled on, which re-extraction refuses on. */
  correctedFields: string[];
}

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

    const result = await applyFactChange(ctx.db, {
      fileId,
      userId: ctx.userId,
      change: { origin: "ui-correction", correction, details, tipNotPrinted },
    });

    if (result.refused) {
      throw new HttpsError(result.code === "NOT_FOUND" ? "not-found" : "invalid-argument", result.message);
    }

    console.log(`[updateFileExtractedFields] Saved file ${fileId}`, {
      userId: ctx.userId,
      changed: result.changed,
    });

    return { success: true, changed: result.changed, correctedFields: correctedFieldsOf(result.after) };
  }
);
