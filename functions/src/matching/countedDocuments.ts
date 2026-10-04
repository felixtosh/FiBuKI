/**
 * The documents a Transaction counts (#571, ADR-0012).
 *
 * A charge often arrives as two Files: the invoice, which states what is
 * owed, and a Receipt, which confirms the payment. Both stay connected to the
 * Transaction, and the pair counts as ONE document: the invoice's figures,
 * its payment total raised to the largest Receipt's when that is larger. The
 * difference is Trinkgeld: part of the payment, no part of the VAT base.
 *
 * This is the one place that collapse happens. It is called at the two seams
 * every amount reader already goes through: the summary of a Transaction's
 * connected Files (Coverage, the Remainder, both scorers, both detail panels)
 * and the UVA adapter's transaction builder (the UVA and the BMD Export).
 *
 * The pair counts once only while both Files are in the input, which is a
 * Transaction's connected Files: deleting a File or making it a Copy removes
 * its File Connections, so "live and on the same Transaction" falls out of
 * the input. A Receipt whose invoice is not in the input counts as an
 * ordinary File.
 *
 * Dependency-free, like `coverage.ts`: the detail panels import it.
 */

/** One connected File, as the collapse reads it. */
export interface PairableFile {
  id: string;
  /** What the bank was charged for it (`filePaymentTotal`); null while it has no amount. */
  payment: number | null | undefined;
  /** Its currency. A missing one reads as EUR, as the panels read it. */
  currency?: string | null;
  /** The invoice this File is the Receipt of: its Receipt Link's File id. */
  receiptOfFileId?: string | null;
}

export interface CountedDocument<T> {
  /** The File the document is counted as: an ordinary File, or the invoice of a pair. */
  file: T;
  /** The payment total the document counts, the pair's surplus included. */
  payment: number | null;
  /**
   * Trinkgeld the pair adds on top of the File's own payment total: the
   * largest same-currency Receipt's excess over the invoice. Zero for an
   * ordinary File and for a Receipt at or below its invoice.
   */
  surplus: number;
  /** The Receipts folded into this document, whatever their currency. */
  receipts: T[];
}

function currencyOf(file: PairableFile): string {
  return (file.currency || "EUR").toUpperCase();
}

/** A magnitude moved away from zero, keeping the sign a credit note carries. */
function raise(payment: number, by: number): number {
  return payment < 0 ? payment - by : payment + by;
}

/**
 * Turn a Transaction's connected Files into the documents it counts, in the
 * order given. Each invoice holding Receipts in the input becomes one
 * document; its Receipts are folded in:
 *
 *  - the largest Receipt payment total in the invoice's currency raises the
 *    invoice's by its excess (never their sum: two pieces of evidence for one
 *    payment do not double it);
 *  - a Receipt smaller than the invoice adds nothing, so the partial-payment
 *    arithmetic downstream claims the paid fraction;
 *  - a Receipt in another currency adds nothing: no exchange rate is guessed.
 *
 * An invoice not yet read keeps its pending reading, and the largest Receipt
 * stands for the pair until it is read.
 */
export function countedDocuments<T extends PairableFile>(files: T[]): CountedDocument<T>[] {
  const byId = new Map(files.map((f) => [f.id, f]));
  const invoiceOf = (f: T): T | undefined => {
    const target = f.receiptOfFileId ? byId.get(f.receiptOfFileId) : undefined;
    // A link target is never itself a Receipt; a chain in the input is read
    // as no pair rather than folded twice.
    if (!target || target.id === f.id) return undefined;
    if (target.receiptOfFileId && byId.has(target.receiptOfFileId)) return undefined;
    return target;
  };

  const receiptsOf = new Map<string, T[]>();
  for (const f of files) {
    const invoice = invoiceOf(f);
    if (!invoice) continue;
    const list = receiptsOf.get(invoice.id) ?? [];
    list.push(f);
    receiptsOf.set(invoice.id, list);
  }

  const out: CountedDocument<T>[] = [];
  for (const file of files) {
    if (invoiceOf(file)) continue;
    const receipts = receiptsOf.get(file.id) ?? [];
    const own = file.payment ?? null;
    if (receipts.length === 0) {
      out.push({ file, payment: own, surplus: 0, receipts });
      continue;
    }

    const sameCurrency = (r: T) => own == null || currencyOf(r) === currencyOf(file);
    let largest: T | undefined;
    for (const r of receipts) {
      if (r.payment == null || !sameCurrency(r)) continue;
      if (!largest || Math.abs(r.payment) > Math.abs(largest.payment!)) largest = r;
    }

    if (own == null) {
      // The invoice is still being read: it keeps its pending reading, and
      // the Receipt's figure stands for the pair until it is.
      out.push({ file, payment: null, surplus: 0, receipts });
      if (largest) out.push({ file: largest, payment: largest.payment!, surplus: 0, receipts: [] });
      continue;
    }

    const surplus = largest ? Math.max(0, Math.abs(largest.payment!) - Math.abs(own)) : 0;
    out.push({ file, payment: surplus > 0 ? raise(own, surplus) : own, surplus, receipts });
  }
  return out;
}

/**
 * Each File's role on a Transaction while its pair counts: "invoice" for the
 * File the pair is counted as, "receipt" for each folded-in Receipt. A File
 * absent from the map counts as an ordinary File.
 */
export function pairRoles<T extends PairableFile>(files: T[]): Map<string, { role: "invoice" | "receipt"; invoiceId: string }> {
  const roles = new Map<string, { role: "invoice" | "receipt"; invoiceId: string }>();
  for (const doc of countedDocuments(files)) {
    if (doc.receipts.length === 0) continue;
    roles.set(doc.file.id, { role: "invoice", invoiceId: doc.file.id });
    for (const r of doc.receipts) roles.set(r.id, { role: "receipt", invoiceId: doc.file.id });
  }
  return roles;
}

/**
 * A Transaction's evidence in booking order: each invoice before the Receipts
 * that pay it, everything else where it stood. Every File is kept; this only
 * orders them (the BMD Export's ZIP and `extbelegnr`).
 */
export function orderPairEvidence<T extends PairableFile>(files: T[]): T[] {
  const ids = new Set(files.map((f) => f.id));
  const receiptsOf = new Map<string, T[]>();
  for (const f of files) {
    const target = f.receiptOfFileId;
    if (!target || target === f.id || !ids.has(target)) continue;
    receiptsOf.set(target, [...(receiptsOf.get(target) ?? []), f]);
  }
  const out: T[] = [];
  const placed = new Set<string>();
  const place = (f: T) => {
    if (placed.has(f.id)) return;
    placed.add(f.id);
    out.push(f);
    for (const r of receiptsOf.get(f.id) ?? []) place(r);
  };
  for (const f of files) {
    const target = f.receiptOfFileId;
    // A Receipt waits for its invoice, wherever the invoice stands.
    if (target && target !== f.id && ids.has(target)) continue;
    place(f);
  }
  for (const f of files) place(f);
  return out;
}
