/**
 * Which Files are a Receipt and the invoice it pays? (#571, ADR-0012 rule 3)
 *
 * Pure: a File and the user's candidate Files in, a verdict out. Modelled on
 * the correction link matcher.
 *
 *  - links        the cited invoice number settles it: a Receipt whose cited
 *                 number equals exactly one live File's invoice number from
 *                 the same issuer. Worked from both sides, so the order the
 *                 two Files arrive in decides nothing. Nobody needs to
 *                 confirm it.
 *  - suggestions  same Partner, same extracted day, same currency, and the
 *                 Receipt's payment total at or above the invoice's. A person
 *                 confirms one. Amount alone never suggests.
 *
 * A number that matches a File of another issuer links nothing: an invoice
 * number is unique per issuer, not across issuers. Never a candidate: the
 * File itself, another user's File, a live Copy, a pair a person declined, or
 * a File that is itself the Receipt of a pair.
 */

import { normalizeInvoiceNumber } from "../corrections/linkMatcher";

export interface PairMatchFile {
  id: string;
  userId: string;
  partnerId?: string | null;
  /** The issuer as the Copy check compares it: the normalised VAT ID, else the normalised name. */
  issuerVatId?: string | null;
  issuerName?: string | null;
  /**
   * An invoice the User issued (rule 7), and its recipient, compared the same
   * way. A payment confirmation for it may come from either party.
   */
  outgoing?: boolean;
  recipientVatId?: string | null;
  recipientName?: string | null;
  /** The document's own invoice number (a receipt number counts). */
  invoiceNumber?: string | null;
  /** The number of the invoice this document confirms payment for. */
  paidInvoiceNumber?: string | null;
  /** What the bank was charged for it, cents (`filePaymentTotal`). */
  payment?: number | null;
  currency?: string | null;
  /** YYYY-MM-DD; the extracted day (UTC date part). */
  day?: string | null;
  documentType?: string | null;
  /** The invoice this File already is the Receipt of. */
  receiptOfFileId?: string | null;
  /** The File is a Copy right now. */
  isLiveCopy?: boolean;
  /** Files a person declined as this File's pair. */
  declinedFileIds?: string[];
  /** A Copy suggestion names this File: the pair is the Copy check's to settle. */
  copySuggestionWith?: string | null;
}

export interface PairLink {
  receiptId: string;
  invoiceId: string;
}

export interface PairMatchResult {
  /** Links the cited number settles: this File as a Receipt, or Receipts of this File. */
  links: PairLink[];
  /** Files this one may pair with; a person confirms. */
  suggestions: string[];
}

/** How many pairing suggestions a File carries at most. */
export const MAX_PAIR_SUGGESTIONS = 3;

function currencyOf(f: PairMatchFile): string {
  return (f.currency || "EUR").toUpperCase();
}

function sameParty(
  aVat: string | null | undefined,
  aName: string | null | undefined,
  bVat: string | null | undefined,
  bName: string | null | undefined
): boolean {
  if (aVat && bVat) return aVat === bVat;
  return !!aName && aName === bName;
}

/** Same issuer: the VAT ID when both carry one, otherwise the normalised name. */
export function sameIssuer(a: PairMatchFile, b: PairMatchFile): boolean {
  return sameParty(a.issuerVatId, a.issuerName, b.issuerVatId, b.issuerName);
}

/**
 * Does the Receipt's issuer agree with the invoice it cites? The same issuer,
 * or, for an invoice the User issued, its recipient: the customer confirming
 * the payment (rule 7). Either way a party to that invoice, whose numbers are
 * unique.
 */
export function issuerAgrees(receipt: PairMatchFile, invoice: PairMatchFile): boolean {
  if (sameIssuer(receipt, invoice)) return true;
  return (
    !!invoice.outgoing &&
    sameParty(receipt.issuerVatId, receipt.issuerName, invoice.recipientVatId, invoice.recipientName)
  );
}

/** A person declined this pair, on either side. */
export function declinedPair(a: PairMatchFile, b: PairMatchFile): boolean {
  return (a.declinedFileIds ?? []).includes(b.id) || (b.declinedFileIds ?? []).includes(a.id);
}

/**
 * Which File of a suggested pair is prefilled as the Receipt: the one with
 * Document Type `receipt` when exactly one has it, otherwise the larger
 * payment total. Null on a tie: the person picks.
 */
export function suggestedReceipt(a: PairMatchFile, b: PairMatchFile): string | null {
  const aReceipt = a.documentType === "receipt";
  const bReceipt = b.documentType === "receipt";
  if (aReceipt !== bReceipt) return aReceipt ? a.id : b.id;
  const aPay = Math.abs(a.payment ?? 0);
  const bPay = Math.abs(b.payment ?? 0);
  if (aPay === bPay) return null;
  return aPay > bPay ? a.id : b.id;
}

/**
 * Same Partner, same day, same currency, and the File prefilled as the
 * Receipt pays at least the other's total.
 */
function suggestible(file: PairMatchFile, c: PairMatchFile): boolean {
  if (!file.partnerId || c.partnerId !== file.partnerId) return false;
  if (!file.day || c.day !== file.day) return false;
  if (currencyOf(file) !== currencyOf(c)) return false;
  if (file.payment == null || c.payment == null) return false;
  const receiptId = suggestedReceipt(file, c);
  if (receiptId === null) return true;
  const [receipt, invoice] = receiptId === file.id ? [file, c] : [c, file];
  return Math.abs(receipt.payment!) >= Math.abs(invoice.payment!);
}

export function matchReceiptPair(file: PairMatchFile, candidates: PairMatchFile[]): PairMatchResult {
  const eligible = candidates.filter(
    (c) =>
      c.id !== file.id &&
      c.userId === file.userId &&
      !c.isLiveCopy &&
      !c.receiptOfFileId &&
      !declinedPair(file, c)
  );
  const links: PairLink[] = [];
  if (file.isLiveCopy) return { links, suggestions: [] };

  // As a Receipt: the File whose invoice number this one cites.
  const cited = normalizeInvoiceNumber(file.paidInvoiceNumber);
  if (cited && !file.receiptOfFileId) {
    // A sibling Receipt that cites the same invoice (a GitHub receipt carries
    // the invoice's number as its own) is no rival invoice.
    const invoices = eligible.filter(
      (c) =>
        normalizeInvoiceNumber(c.invoiceNumber) === cited &&
        normalizeInvoiceNumber(c.paidInvoiceNumber) !== cited &&
        issuerAgrees(file, c)
    );
    if (invoices.length === 1) links.push({ receiptId: file.id, invoiceId: invoices[0].id });
  }
  const isReceipt = !!file.receiptOfFileId || links.length > 0;

  // As an invoice: the Files that cite this one's number. A link target is
  // never itself a Receipt, and each Receipt's number must point at this File
  // alone among its issuer's Files.
  const own = normalizeInvoiceNumber(file.invoiceNumber);
  if (own && !isReceipt) {
    for (const r of eligible) {
      if (normalizeInvoiceNumber(r.paidInvoiceNumber) !== own || !issuerAgrees(r, file)) continue;
      const rivals = eligible.filter(
        (c) =>
          c.id !== r.id &&
          normalizeInvoiceNumber(c.invoiceNumber) === own &&
          normalizeInvoiceNumber(c.paidInvoiceNumber) !== own &&
          issuerAgrees(r, c)
      );
      if (rivals.length === 0) links.push({ receiptId: r.id, invoiceId: file.id });
    }
  }

  // A Receipt pays one invoice: it is offered nothing further.
  if (isReceipt) return { links, suggestions: [] };
  const linked = new Set(links.map((l) => l.receiptId));
  const suggestions = eligible
    .filter(
      (c) =>
        !linked.has(c.id) &&
        file.copySuggestionWith !== c.id &&
        c.copySuggestionWith !== file.id &&
        suggestible(file, c)
    )
    .sort(
      (a, b) =>
        Math.abs(Math.abs(a.payment ?? 0) - Math.abs(file.payment ?? 0)) -
          Math.abs(Math.abs(b.payment ?? 0) - Math.abs(file.payment ?? 0)) || a.id.localeCompare(b.id)
    )
    .slice(0, MAX_PAIR_SUGGESTIONS)
    .map((c) => c.id);
  return { links, suggestions };
}

/**
 * Whether the Copy check must leave a pair alone (ADR-0012 rule 2): a Receipt
 * and its invoice are never a Copy of each other. True when either File cites
 * the other's number as paid, or a Receipt Link, a pairing suggestion or a
 * declined pairing joins them.
 */
export function pairedForCopyCheck(
  a: { id: string; data: Record<string, unknown> },
  b: { id: string; data: Record<string, unknown> }
): boolean {
  const cites = (x: Record<string, unknown>, y: Record<string, unknown>) => {
    const paid = normalizeInvoiceNumber(x.extractedPaidInvoiceNumber as string | null | undefined);
    return !!paid && paid === normalizeInvoiceNumber(y.extractedInvoiceNumber as string | null | undefined);
  };
  if (cites(a.data, b.data) || cites(b.data, a.data)) return true;
  const linkOf = (x: Record<string, unknown>) => (x.receiptLink as { fileId?: string } | null | undefined)?.fileId;
  if (linkOf(a.data) === b.id || linkOf(b.data) === a.id) return true;
  const ids = (x: Record<string, unknown>, field: string): string[] => {
    const v = x[field];
    if (!Array.isArray(v)) return [];
    return v.map((e) => (typeof e === "string" ? e : (e as { fileId?: string })?.fileId)).filter((e): e is string => !!e);
  };
  for (const field of ["receiptPairSuggestions", "receiptPairDeclinedFileIds"]) {
    if (ids(a.data, field).includes(b.id) || ids(b.data, field).includes(a.id)) return true;
  }
  return false;
}
