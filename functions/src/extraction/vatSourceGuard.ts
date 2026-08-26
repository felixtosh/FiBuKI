/**
 * The write policy for re-extraction (fork #137).
 *
 * `retry_file_extraction` overwrites a file's extracted record unconditionally,
 * so a pass that reads a document worse than the pass before it silently costs
 * the figure — and the record afterwards carries no trace that it used to be
 * better. The D6 sweep of 2026-08-19 lost derivable VAT on 29 of 325 files that
 * way, all of them output-VAT documents, which is the understating direction.
 *
 * This module ranks how strong a record's VAT evidence is, on the same ladder
 * the UVA derivation walks, and lets the write path refuse to replace a
 * stronger record with a weaker one.
 */

/** Ladder positions, strongest first. Mirrors `fileRateGroups` in uva/calculateUva.ts. */
export type VatSource = "rate-groups" | "line-items" | "top-level" | "rate-only" | "none";

const RANK: Record<VatSource, number> = {
  "rate-groups": 4,
  "line-items": 3,
  "top-level": 2,
  "rate-only": 1,
  "none": 0,
};

export function vatSourceRank(source: VatSource): number {
  return RANK[source];
}

/** The VAT-bearing half of a file record — everything the guard may preserve. */
export const VAT_FIELDS = [
  "extractedVatPercent",
  "extractedVatAmount",
  "extractedLineItems",
  "extractedRateGroups",
  "lineItemsUnreconciled",
  "lineItemsUnreconciledRates",
] as const;

function isNonEmptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Which derivation step this record can still reach.
 *
 * The unreconciled flag is not a warning here, it is a wall: a transaction
 * whose file carries `lineItemsUnreconciled` and no printed rate-group block is
 * dropped outright by the UVA calculation ("amount-mismatch"), so such a record
 * yields nothing at all even when it still has a top-level rate. Ranking it any
 * higher than "none" would let the guard wave through exactly the write that
 * cost the figure.
 */
export function vatSourceOf(record: Record<string, unknown>): VatSource {
  if (isNonEmptyArray(record.extractedRateGroups)) {
    return "rate-groups";
  }
  if (record.lineItemsUnreconciled === true) {
    return "none";
  }

  const lineItems = record.extractedLineItems;
  if (
    isNonEmptyArray(lineItems) &&
    lineItems.every((item) => asFiniteNumber((item as { vatPercent?: unknown })?.vatPercent) !== null)
  ) {
    return "line-items";
  }
  if (asFiniteNumber(record.extractedVatAmount) !== null) {
    return "top-level";
  }
  if (asFiniteNumber(record.extractedVatPercent) !== null) {
    return "rate-only";
  }
  return "none";
}

/** Same tolerance the reconciler uses: 5 cents or 0.5%, whichever is larger. */
function amountTolerance(amount: number): number {
  return Math.max(5, Math.round(Math.abs(amount) * 0.005));
}

export interface VatDowngradeReport {
  from: VatSource;
  to: VatSource;
  /** The incoming pass reads the document's VAT worse than the record it replaces. */
  downgraded: boolean;
  /** ...and the previous VAT fields were kept instead of being overwritten. */
  preserved: boolean;
}

/**
 * Refuse to let a weaker pass overwrite a stronger record's VAT fields.
 *
 * Mutates `updateData` in place, because that is the object the write path has
 * already assembled and is about to send. Everything outside `VAT_FIELDS` — the
 * date, the total, the partner, the raw text — is written either way: this
 * guards the VAT evidence, it does not veto the re-extraction.
 *
 * Preservation is conditional on the two passes agreeing about the document
 * total. If the total moved, the old VAT fields describe a different reading of
 * the document and carrying them forward would build a record that never
 * existed; the downgrade is then recorded but not repaired, and the file is
 * findable through `vatSourceDowngraded` for a human to settle.
 *
 * A "not an invoice" classification clears the extracted record deliberately
 * and must never be blocked, so it is exempt.
 */
export function applyVatDowngradeGuard(
  previous: Record<string, unknown>,
  updateData: Record<string, unknown>
): VatDowngradeReport {
  const from = vatSourceOf(previous);
  const to = vatSourceOf(updateData);

  if (updateData.isNotInvoice === true) {
    return { from, to, downgraded: false, preserved: false };
  }

  const downgraded = vatSourceRank(to) < vatSourceRank(from);
  let preserved = false;

  if (downgraded) {
    const previousAmount = asFiniteNumber(previous.extractedAmount);
    const nextAmount = asFiniteNumber(updateData.extractedAmount);
    const totalsAgree =
      previousAmount !== null &&
      nextAmount !== null &&
      Math.abs(previousAmount - nextAmount) <= amountTolerance(nextAmount);

    if (totalsAgree) {
      for (const field of VAT_FIELDS) {
        updateData[field] = previous[field] ?? null;
      }
      preserved = true;
    }
  }

  updateData.vatSourceDowngraded = downgraded;
  updateData.vatFieldsPreserved = preserved;

  return { from, to, downgraded, preserved };
}
