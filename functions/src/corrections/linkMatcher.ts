/**
 * Which File does a correction correct? (#564, ADR-0010 rule 2, D21)
 *
 * Pure: a correction File and the user's candidate Files in, a verdict out.
 *
 *  - link         the referenced invoice number matches exactly one File of
 *                 the same Partner. Nobody needs to confirm it.
 *  - suggestions  no unique number match, but Files of the same Partner that
 *                 could be the original: an amount at or above the refund,
 *                 dated on or before it. Ranked; a person confirms one.
 *  - none         nothing to offer.
 *
 * A number that matches a File of another Partner links nothing: an invoice
 * number is unique per issuer, not across issuers. Partner and amount only
 * ever suggest. A candidate of another user is never returned, and neither is
 * one a person declined for this correction.
 */

export interface LinkMatchCorrection {
  id: string;
  userId: string;
  partnerId?: string | null;
  referencedInvoiceNumber?: string | null;
  /** The correction's amount, cents; read as a magnitude. */
  amount?: number | null;
  /** YYYY-MM-DD; the document date. */
  date?: string | null;
  /** Files a person declined as this correction's original. */
  declinedFileIds?: string[];
}

export interface LinkMatchCandidate {
  id: string;
  userId: string;
  partnerId?: string | null;
  invoiceNumber?: string | null;
  amount?: number | null;
  date?: string | null;
  /** The candidate is itself a correction document; a correction is never an original. */
  isCorrection?: boolean;
}

export type LinkMatchResult =
  | { kind: "link"; fileId: string }
  | { kind: "suggestions"; fileIds: string[] }
  | { kind: "none" };

/** How many suggestions a correction carries at most. */
export const MAX_CORRECTION_SUGGESTIONS = 3;

/** An invoice number as printed, compared without spacing, punctuation or case. */
export function normalizeInvoiceNumber(n: string | null | undefined): string | null {
  const s = (n ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s || null;
}

export function matchCorrectionLink(
  correction: LinkMatchCorrection,
  candidates: LinkMatchCandidate[]
): LinkMatchResult {
  const declined = new Set(correction.declinedFileIds ?? []);
  const partnerId = correction.partnerId ?? null;
  if (!partnerId) return { kind: "none" };

  const eligible = candidates.filter(
    (c) =>
      c.id !== correction.id &&
      c.userId === correction.userId &&
      c.partnerId === partnerId &&
      !c.isCorrection &&
      !declined.has(c.id)
  );

  const ref = normalizeInvoiceNumber(correction.referencedInvoiceNumber);
  if (ref) {
    const byNumber = eligible.filter((c) => normalizeInvoiceNumber(c.invoiceNumber) === ref);
    if (byNumber.length === 1) return { kind: "link", fileId: byNumber[0].id };
    if (byNumber.length > 1) {
      return { kind: "suggestions", fileIds: rank(byNumber, correction).slice(0, MAX_CORRECTION_SUGGESTIONS) };
    }
  }

  const refund = Math.abs(correction.amount ?? 0);
  const plausible = eligible.filter((c) => {
    const amount = Math.abs(c.amount ?? 0);
    if (amount <= 0 || (refund > 0 && amount < refund)) return false;
    if (correction.date && c.date && c.date > correction.date) return false;
    return true;
  });
  if (plausible.length === 0) return { kind: "none" };
  return { kind: "suggestions", fileIds: rank(plausible, correction).slice(0, MAX_CORRECTION_SUGGESTIONS) };
}

/** An equal amount first, then the closest date before the refund, then the closest amount. */
function rank(candidates: LinkMatchCandidate[], correction: LinkMatchCorrection): string[] {
  const refund = Math.abs(correction.amount ?? 0);
  return [...candidates]
    .sort((a, b) => {
      const aEq = Math.abs(a.amount ?? 0) === refund ? 0 : 1;
      const bEq = Math.abs(b.amount ?? 0) === refund ? 0 : 1;
      if (aEq !== bEq) return aEq - bEq;
      const dateCmp = (b.date ?? "").localeCompare(a.date ?? "");
      if (dateCmp !== 0) return dateCmp;
      return Math.abs(a.amount ?? 0) - Math.abs(b.amount ?? 0) || a.id.localeCompare(b.id);
    })
    .map((c) => c.id);
}
