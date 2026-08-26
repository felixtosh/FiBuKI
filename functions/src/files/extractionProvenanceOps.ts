/**
 * Provenance for a hand-corrected extracted record (#184).
 *
 * A correction used to leave no trace of itself. Re-extraction overwrites the
 * record unconditionally, so every sweep silently discarded the corrections in
 * it unless a list of file ids was carried by hand from sweep to sweep — and
 * that list rots. The fork #137 downgrade guard does not cover this: it
 * protects the VAT fields only, and only against a strict rank downgrade, so a
 * correction that moved `extractedAmount` was unprotected.
 *
 * The marker is **per field**, not one timestamp on the document, because the
 * corrections in the corpus differ in kind: a `vatPercent: 0` ruling on a levy
 * says nothing about the total, and a total-and-itemisation rewrite says
 * nothing about the date. Recording which field a person ruled on is what lets
 * a later reader tell the two apart instead of treating the whole record as
 * frozen.
 *
 * Two fields carry it, and they have different jobs:
 *
 *   `extractionCorrectedFields` — the provenance itself: field name → when.
 *   `extractionCorrectedAt`     — the newest of those, so the corrected
 *                                 population is one query rather than a scan.
 *
 * Reading either is enough to build a sweep's exclusion list, which is the
 * specific chore this exists to retire.
 */

import { Timestamp } from "firebase-admin/firestore";

/**
 * The fields a correction can set, as data — the same names
 * `update_file_extraction` takes and `buildExtractionCorrection` reports in
 * `changed`. The marker keys on the correction's own vocabulary rather than on
 * the stored field names (`extractedAmount`, …) so a refusal names something
 * the caller can act on directly.
 */
export const CORRECTABLE_FIELDS = [
  "amount",
  "vatAmount",
  "vatPercent",
  "date",
  "lineItems",
] as const;

export type CorrectableField = (typeof CORRECTABLE_FIELDS)[number];

/** The stored marker: which fields a human set, and when each was set. */
export type ExtractionCorrectedFields = Record<string, unknown>;

/**
 * The half of a file record these functions read. Deliberately one field: the
 * marker is the only thing they know about, and taking the whole document would
 * invite them to grow a second opinion about the record.
 */
export interface CorrectionProvenanceRecord {
  extractionCorrectedFields?: unknown;
}

/**
 * Merge new stamps into whatever the record already carries.
 *
 * Whole-map, not `extractionCorrectedFields.amount` dot paths: the correction
 * write path already reads the document before it writes (the § 11
 * classification is recomputed from the merged record), so the previous map is
 * in hand, and one shape of update is easier to reason about than two. The
 * merge is what keeps a `vatPercent` correction from erasing the `amount`
 * stamp an earlier correction left.
 *
 * Nothing is ever removed here. A field stamped once stays stamped even if a
 * later correction moves a different field, because the question the marker
 * answers is "did a person rule on this field", and that stays true.
 */
export function buildCorrectionProvenance(
  previous: CorrectionProvenanceRecord | undefined,
  changed: readonly string[],
  at: Timestamp = Timestamp.now()
): Record<string, unknown> {
  const merged: ExtractionCorrectedFields = { ...readStampMap(previous) };
  for (const field of changed) {
    merged[field] = at;
  }

  return {
    extractionCorrectedFields: merged,
    extractionCorrectedAt: at,
  };
}

/** The marker as stored, defensively — a record written before #184 has none. */
function readStampMap(record: CorrectionProvenanceRecord | undefined): ExtractionCorrectedFields {
  const raw = record?.extractionCorrectedFields;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as ExtractionCorrectedFields;
}

/**
 * Which fields a human set on this record, sorted in the order
 * `CORRECTABLE_FIELDS` declares so a refusal message reads the same way twice.
 * A field the marker names that is not in that set is kept and sorted last,
 * rather than dropped: an unknown key still means a person touched something.
 */
export function correctedFieldsOf(record: CorrectionProvenanceRecord | undefined): string[] {
  const keys = Object.keys(readStampMap(record));
  const known = CORRECTABLE_FIELDS.filter((field) => keys.includes(field)) as string[];
  const rest = keys.filter((key) => !known.includes(key)).sort();
  return [...known, ...rest];
}

/** True when this record carries any hand correction at all. */
export function hasHandCorrections(record: CorrectionProvenanceRecord | undefined): boolean {
  return correctedFieldsOf(record).length > 0;
}
