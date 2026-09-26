/**
 * The bound on a hand-set Trinkgeld (#310).
 *
 * #217 gave `extractedTipAmount` a writer and nothing bounds what it writes.
 * There is no VAT exposure — a tip is outside the scope of VAT, so it never
 * touches `extractedAmount` and never becomes a rate group — but a tip larger
 * than it can possibly be moves the reconciled total away from the bank line,
 * and the file simply stops matching with nothing on the record saying why.
 * Typing 600,00 into the Trinkgeld box of a 40,00 Beleg is silently accepted
 * today and is indistinguishable, afterwards, from a document nobody can find
 * a payment for.
 *
 * **The bound is not a single number**, because a tip reaches a file two ways:
 *
 *   - *Printed on the invoice.* The document total already contains it, so the
 *     tip is bounded by that total.
 *   - *Never printed, only in the bank line.* The case #217 exists for: the
 *     terminal took a tip the Beleg does not mention, so the document total is
 *     the Entgelt and the tip sits on top of it. Measuring against the document
 *     total is then the wrong question; the bank line is the one that knows.
 *
 * So the default is the document total and the correction may declare itself
 * the second shape, which moves the bound to the transaction total. It moves
 * it — it does not remove it: a declared-unprinted tip is still bounded, just
 * by the larger figure.
 *
 * **Less than, not at most.** The boundary is the same one `uva/tip.ts` draws
 * for the same reason (#317): a tip that is not smaller than the total it is
 * measured against is not a tip but a Gesamt transcribed into the Trinkgeld
 * field, and it leaves nothing for the document's own rates to apply to.
 * Accepting an equal tip here would only hand the UVA a figure it refuses as
 * `impossible-tip` later, further from the person who typed it.
 *
 * **Refused, never clamped.** A figure quietly reduced to fit is the same class
 * of problem as one quietly accepted: the record would carry a number nobody
 * chose.
 *
 * The rule is pure and lives here alone, so both correction doors — the detail
 * panel callable and `update_file_extraction` — measure a tip the same way.
 * Reading the totals is the caller's job; `buildCorrectedFileUpdate` does it.
 */

import { ExtractionCorrectionError } from "./extractionCorrectionOps";

/** Which total a tip was measured against. */
export type TipBoundName = "document" | "transaction";

/**
 * What the guard decided, stored on the file so the check is reproducible
 * later and a reader can tell an overridden tip from an ordinary one.
 */
export interface TipBound {
  bound: TipBoundName;
  /** The total the tip was measured against, in cents, as it stood then. */
  total: number;
}

export interface TipBoundFacts {
  /** The tip as the builder normalised it: positive cents, or null for none. */
  tip: number | null;
  /** The document total this correction leaves on the record, cents. */
  documentTotal: number | null;
  /**
   * The bank lines the file is linked to, summed, cents. Null when the file is
   * linked to nothing — only read when the tip is declared unprinted.
   */
  transactionTotal: number | null;
  /** The correction declares the document does not print this tip. */
  notPrinted: boolean;
}

/** Cents as the figure a person typed, the way every other message here reads. */
function amount(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Measure a hand-set tip against its bound, or throw.
 *
 * Returns the bound that applied, or null when there is no tip — clearing the
 * tip clears the record of what bounded it, since nothing is being claimed.
 *
 * Both totals are taken in absolute value: a credit note's total is negative
 * and a bank line that paid one is positive, and neither says anything about
 * how large a tip may be.
 */
export function checkTipBound(facts: TipBoundFacts): TipBound | null {
  const { tip, notPrinted } = facts;
  if (tip === null || tip === 0) return null;

  if (notPrinted) {
    if (facts.transactionTotal === null) {
      throw new ExtractionCorrectionError(
        "tipAmount was declared as not printed on the invoice, which measures it against " +
          "the transaction total, but this file is not connected to a transaction"
      );
    }
    return measure(tip, Math.abs(facts.transactionTotal), "transaction");
  }

  if (facts.documentTotal === null) {
    throw new ExtractionCorrectionError(
      "tipAmount is measured against the document total and this file has none. " +
        "Correct the amount first, or — if the document does not print the tip — " +
        "declare it as not printed, which measures it against the transaction total"
    );
  }
  return measure(tip, Math.abs(facts.documentTotal), "document");
}

function measure(tip: number, total: number, bound: TipBoundName): TipBound {
  if (tip >= total) {
    // The document case names the way out, because it is the common one: a tip
    // that dwarfs the invoice is usually a tip the invoice never printed.
    const hint =
      bound === "document"
        ? " If the document does not print this tip, declare it as not printed — " +
          "it is then measured against the transaction total instead."
        : "";
    throw new ExtractionCorrectionError(
      `tipAmount ${amount(tip)} must be less than the ${bound} total it is measured ` +
        `against, ${amount(total)}.${hint}`
    );
  }
  return { bound, total };
}
