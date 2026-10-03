/**
 * Which Transactions are corrections, and of what (#564, ADR-0010).
 *
 * The period run and the BMD Export fetch the records; this module reads them
 * and hands each Transaction its `UvaCorrection`, so both outputs resolve a
 * refund the same way. Pure: plain records in, a map out.
 *
 * A Transaction is a correction when one of its Files:
 *
 *  - carries a correction link to the File it corrects (auto, accepted or
 *    manual), or
 *  - is an Invoice Correction FiBuKI issued, which names its original Invoice
 *    (whose generated File is the original), or
 *  - is itself the original: a purchase File connected both to the
 *    Transaction that paid it and to this refund (D9), or a sale File
 *    connected to the money that came in and to this money going back, or
 *  - reads as an Invoice Correction (D8) with none of the above: unlinked.
 *
 * The original's claim is what its paying Transactions booked, worked out on
 * the original File alone with the same per-transaction ladder the UVA uses.
 * Earlier refunds of the same original — on an earlier bank day, any period —
 * set what is left to take back.
 */

import { buildUvaTransaction, payableTotalOf, type BuildOptions, type CategoryRecord, type FileRecord, type TimestampLike, type TransactionRecord } from "../uva/adapter";
import { deriveTransactionVat } from "../uva/transactionVat";
import { priorCorrectedOf } from "../uva/correction";
import { classifyCorrectionDocument } from "./classifyCorrectionDocument";
import type { EcbRateTable } from "../fx/ecbRates";
import type { CorrectionBasis, CorrectionRateGroup, UvaCorrection } from "../uva/types";

/** Who set a correction link (#564). */
export type CorrectionLinkSetBy = "auto" | "suggested-accepted" | "manual";

/** The stored correction link on a File: it points at a File, never a Transaction. */
export interface CorrectionLinkRecord {
  fileId: string;
  setBy: CorrectionLinkSetBy;
  setAt?: unknown;
}

/** The File fields correction resolution reads, beyond what the UVA adapter reads. */
export interface CorrectionFileRecord extends FileRecord {
  transactionIds?: string[];
  invoiceId?: string | null;
  invoiceDirection?: "incoming" | "outgoing" | "unknown" | null;
  correctionLink?: CorrectionLinkRecord | null;
  extractedSelfDesignation?: string | null;
  extractedReferencedInvoiceNumber?: string | null;
}

/** The Invoice fields resolution reads: a FiBuKI-issued correction names its original. */
export interface CorrectionInvoiceRecord {
  id: string;
  fileId?: string | null;
  correctsInvoice?: { invoiceId: string } | null;
}

export interface ResolveCorrectionsInput {
  /** The Transactions to resolve (a period's, or an export's). */
  transactions: TransactionRecord[];
  /** Every File the resolution may read: theirs, the originals, and the originals' other corrections. */
  filesById: Map<string, CorrectionFileRecord>;
  /** Every Transaction the resolution may read beyond `transactions`: payers and earlier refunds. */
  transactionsById: Map<string, TransactionRecord>;
  invoicesById?: Map<string, CorrectionInvoiceRecord>;
  categoriesById?: Map<string, CategoryRecord>;
  /**
   * For each original File id, the correction Files linked to it (directly or
   * as FiBuKI-issued corrections), so earlier refunds through a credit note
   * count against the cap as well as refunds on the original itself.
   */
  correctionFileIdsByOriginal?: Map<string, string[]>;
  ecbRates?: EcbRateTable | null;
}

/** The File a correction File names as its original, through its link or its Invoice. */
export function linkedOriginalFileId(
  f: CorrectionFileRecord,
  invoicesById?: Map<string, CorrectionInvoiceRecord>
): { fileId: string; basis: "link" | "issued-correction" } | null {
  if (f.correctionLink?.fileId) return { fileId: f.correctionLink.fileId, basis: "link" };
  if (f.invoiceId && invoicesById) {
    const originalInvoiceId = invoicesById.get(f.invoiceId)?.correctsInvoice?.invoiceId;
    const originalFileId = originalInvoiceId ? invoicesById.get(originalInvoiceId)?.fileId : null;
    if (originalFileId) return { fileId: originalFileId, basis: "issued-correction" };
  }
  return null;
}

export function resolveCorrections(input: ResolveCorrectionsInput): Map<string, UvaCorrection> {
  const out = new Map<string, UvaCorrection>();
  const txById = new Map(input.transactionsById);
  for (const tx of input.transactions) txById.set(tx.id, tx);

  for (const tx of input.transactions) {
    const c = resolveOne(tx, input, txById);
    if (c) out.set(tx.id, c);
  }
  return out;
}

function resolveOne(
  tx: TransactionRecord,
  input: ResolveCorrectionsInput,
  txById: Map<string, TransactionRecord>
): UvaCorrection | null {
  if (!tx.amount) return null;
  const files = (tx.fileIds ?? [])
    .map((id) => input.filesById.get(id))
    .filter((f): f is CorrectionFileRecord => !!f);

  let found: { originalId: string; basis: CorrectionBasis; correctionFile: CorrectionFileRecord | null } | null = null;
  const unlinked: string[] = [];
  for (const f of files) {
    const linked = linkedOriginalFileId(f, input.invoicesById);
    if (linked) {
      found = { originalId: linked.fileId, basis: linked.basis, correctionFile: f };
      break;
    }
    if (isConnectedOriginal(f, tx, txById)) {
      found = { originalId: f.id, basis: "connected-original", correctionFile: null };
      break;
    }
    if (classifyCorrectionDocument(f).kind === "invoice-correction") unlinked.push(f.id);
  }

  if (!found) {
    return unlinked.length > 0 ? { status: "unlinked", reason: "no-link", fileIds: unlinked } : null;
  }

  const original = input.filesById.get(found.originalId);
  const correctionFileIds = found.correctionFile ? [found.correctionFile.id] : [];
  // The original pays on the other side of the bank from its refund.
  const payers = (original?.transactionIds ?? [])
    .map((id) => txById.get(id))
    .filter((p): p is TransactionRecord => !!p && p.id !== tx.id && Math.sign(p.amount) === -Math.sign(tx.amount));
  if (!original || payers.length === 0) {
    return {
      status: "unlinked",
      reason: "original-unpaid",
      fileIds: correctionFileIds.length ? correctionFileIds : [found.originalId],
      originalFileId: found.originalId,
    };
  }

  const claim = originalClaim(original, payers, input);
  const earlier = earlierRefunds(tx, found.originalId, original, input, txById);
  return {
    status: "linked",
    kind: tx.amount > 0 ? "purchase" : "sale",
    basis: found.basis,
    original: {
      fileId: original.id,
      paidByTransactionIds: payers.map((p) => p.id),
      gross: claim.gross,
      claimed: claim.claimed,
    },
    priorCorrected: priorCorrectedOf(earlier, claim.claimed, claim.gross),
    printedVat: found.correctionFile ? printedVatOf(found.correctionFile) : null,
    correctionFileId: found.correctionFile?.id ?? null,
  };
}

/**
 * The File sits on both sides of the bank: it is the original of this line
 * when this line is on the opposite side to the one the File was paid on.
 * The File's own side is its invoice direction where one is set (incoming =
 * a purchase), otherwise the side of its earliest Transaction. A correction
 * document is never an original.
 */
function isConnectedOriginal(
  f: CorrectionFileRecord,
  tx: TransactionRecord,
  txById: Map<string, TransactionRecord>
): boolean {
  if (classifyCorrectionDocument(f).kind === "invoice-correction") return false;
  const others = (f.transactionIds ?? [])
    .filter((id) => id !== tx.id)
    .map((id) => txById.get(id))
    .filter((p): p is TransactionRecord => !!p && !!p.amount);
  if (others.length === 0) return false;

  let originalSign: number;
  if (f.invoiceDirection === "incoming") originalSign = -1;
  else if (f.invoiceDirection === "outgoing") originalSign = 1;
  else {
    const all = [tx, ...others].sort(
      (a, b) => dayOf(a.date).localeCompare(dayOf(b.date)) || a.amount - b.amount
    );
    originalSign = Math.sign(all[0].amount);
  }
  return Math.sign(tx.amount) !== originalSign && others.some((p) => Math.sign(p.amount) === originalSign);
}

/**
 * What the original booked: each paying Transaction, read on the original File
 * alone through the same per-transaction ladder the UVA and the BMD Export
 * run. A payer carrying other Files too pays this one in full at most.
 *
 * A purchase that claimed nothing (no document, an Eigenbeleg, a foreign
 * regime, a non-claimable or 0% document) yields no VAT, so its correction
 * corrects nothing. A sale owes what the ladder books, the defaulted 20%
 * included.
 */
function originalClaim(
  original: CorrectionFileRecord,
  payers: TransactionRecord[],
  input: ResolveCorrectionsInput
): { gross: number; claimed: CorrectionRateGroup[] } {
  const opts: BuildOptions = {
    filesById: new Map([[original.id, original]]),
    categoriesById: input.categoriesById ?? new Map(),
  };
  const byRate = new Map<number, CorrectionRateGroup>();
  let gross = 0;
  for (const p of payers) {
    const ownShare = (p.fileIds ?? []).length > 1 ? payableTotalOf(original) : null;
    const amount = ownShare !== null ? Math.sign(p.amount) * Math.min(ownShare, Math.abs(p.amount)) : p.amount;
    const uvaTx = buildUvaTransaction({ ...p, amount, fileIds: [original.id] }, opts);
    const vat = deriveTransactionVat(uvaTx, input.ecbRates ?? null);
    gross += Math.abs(amount);
    if (vat.kind !== "groups") continue;
    for (const g of vat.groups) {
      const acc = byRate.get(g.rate) ?? { rate: g.rate, net: 0, vat: 0 };
      acc.net += g.net;
      acc.vat += g.vat;
      byRate.set(g.rate, acc);
    }
  }
  return { gross, claimed: [...byRate.values()].sort((a, b) => b.rate - a.rate) };
}

/**
 * The bank amounts of earlier refunds of the same original, oldest first:
 * Transactions on the refund's side carrying the original itself or one of
 * its correction Files. Earlier means an earlier bank day; on the same day,
 * the lower id.
 */
function earlierRefunds(
  tx: TransactionRecord,
  originalId: string,
  original: CorrectionFileRecord,
  input: ResolveCorrectionsInput,
  txById: Map<string, TransactionRecord>
): number[] {
  const refundIds = new Set<string>(original.transactionIds ?? []);
  for (const fid of input.correctionFileIdsByOriginal?.get(originalId) ?? []) {
    for (const id of input.filesById.get(fid)?.transactionIds ?? []) refundIds.add(id);
  }
  const day = dayOf(tx.date);
  return [...refundIds]
    .filter((id) => id !== tx.id)
    .map((id) => txById.get(id))
    .filter((r): r is TransactionRecord => !!r && Math.sign(r.amount) === Math.sign(tx.amount))
    .filter((r) => {
      const d = dayOf(r.date);
      return d < day || (d === day && r.id < tx.id);
    })
    .sort((a, b) => dayOf(a.date).localeCompare(dayOf(b.date)) || a.id.localeCompare(b.id))
    .map((r) => Math.abs(r.amount));
}

/** A correction document's printed VAT total, absolute cents: the cross-check. */
function printedVatOf(f: CorrectionFileRecord): number | null {
  if (f.extractedRateGroups?.length) {
    return Math.abs(f.extractedRateGroups.reduce((s, g) => s + g.vat, 0));
  }
  return f.extractedVatAmount != null ? Math.abs(f.extractedVatAmount) : null;
}

function dayOf(date: TimestampLike): string {
  return date.toDate().toISOString().slice(0, 10);
}
