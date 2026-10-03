/**
 * The bound on a hand-set Trinkgeld (#310, narrowed by #554).
 *
 * #217 gave `extractedTipAmount` a writer and nothing bounds what it writes.
 * There is no VAT exposure — a tip is outside the scope of VAT, so it never
 * touches `extractedAmount` and never becomes a rate group — but a tip larger
 * than the document can hold is a figure the document itself contradicts.
 * Typing 600,00 into the Trinkgeld box of a 40,00 Beleg is silently accepted
 * otherwise, and is indistinguishable, afterwards, from a document nobody can
 * find a payment for.
 *
 * **A correction checks only what the document can show.** A tip reaches a
 * file two ways:
 *
 *   - *Printed on the invoice.* The document total already contains it, so the
 *     tip is bounded by that total. That is a fact of the page.
 *   - *Never printed, only in the bank line.* The case #217 exists for: the
 *     terminal took a tip the Beleg does not mention, so the document total is
 *     the Entgelt and the tip sits on top of it. The document says nothing
 *     about how large such a tip can be, so the correction has nothing to
 *     measure it against, and it does not borrow a figure from elsewhere.
 *
 * #310 measured the second shape against the bank line of the connected
 * Transaction. #554 took that out: it judged a document fact by a matching
 * fact, so the same tip on the same receipt was accepted or refused depending
 * on which Transaction the File happened to be connected to, or refused for
 * not being connected yet. Whether `document + tip` lands on the bank line is
 * matching's question (the Remainder shows the gap), and what an uncovered tip
 * means is the tax side's: `uva/tip.ts` stops a tip that is not less than the
 * bank line (`impossible-tip`, #317) and one the bank line falls short of
 * (`tip-partial-payment`, #554).
 *
 * The declaration is still recorded, as `{ bound: "not-printed" }`, so the
 * detail panel can show the tip as unprinted and re-send the declaration on
 * the next save. A record written under #310 carries `{ bound: "transaction",
 * total }` for the same declaration and reads the same way.
 *
 * **Less than, not at most.** The boundary is the same one `uva/tip.ts` draws
 * for the same reason (#317): a printed tip that is not smaller than the total
 * containing it is not a tip but a Gesamt transcribed into the Trinkgeld
 * field, and it leaves nothing for the document's own rates to apply to.
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

/**
 * What the guard decided, stored on the file so the check is reproducible
 * later and a reader can tell an unprinted tip from an ordinary one.
 */
export type TipBound =
  /** A printed tip, measured against the document total (cents, as it stood then). */
  | { bound: "document"; total: number }
  /** A tip declared as not printed on the invoice: nothing on the document bounds it. */
  | { bound: "not-printed" };

export interface TipBoundFacts {
  /** The tip as the builder normalised it: positive cents, or null for none. */
  tip: number | null;
  /** The document total this correction leaves on the record, cents. */
  documentTotal: number | null;
  /** The correction declares the document does not print this tip. */
  notPrinted: boolean;
}

/** Cents as the figure a person typed, the way every other message here reads. */
function amount(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Measure a hand-set tip against the document, or throw.
 *
 * Returns the bound that applied, or null when there is no tip — clearing the
 * tip clears the record of what bounded it, since nothing is being claimed.
 *
 * The document total is taken in absolute value: a credit note's total is
 * negative, and that says nothing about how large a tip may be.
 */
export function checkTipBound(facts: TipBoundFacts): TipBound | null {
  const { tip, notPrinted } = facts;
  if (tip === null || tip === 0) return null;

  if (notPrinted) return { bound: "not-printed" };

  if (facts.documentTotal === null) {
    throw new ExtractionCorrectionError(
      "tipAmount is measured against the document total and this file has none. " +
        "Correct the amount first, or — if the document does not print the tip — " +
        "declare it as not printed"
    );
  }
  const total = Math.abs(facts.documentTotal);
  if (tip >= total) {
    // The way out is named, because it is the common case: a tip that dwarfs
    // the invoice is usually a tip the invoice never printed.
    throw new ExtractionCorrectionError(
      `tipAmount ${amount(tip)} must be less than the document total it is measured ` +
        `against, ${amount(total)}. If the document does not print this tip, declare it ` +
        `as not printed — the document total does not contain it then.`
    );
  }
  return { bound: "document", total };
}

