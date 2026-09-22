/**
 * The Trinkgeld figure on one transaction, and the one predicate that decides
 * whether it is possible at all (#317).
 *
 * A tip is a Betriebsausgabe and no part of the VAT base (#172): it is charged
 * on top of the Summe, so the bank line carries `totalGross + tipAmount` and
 * the tip itself carries nothing. A tip that is NOT smaller than the bank line
 * cannot be that — it is a Gesamt transcribed into the Trinkgeld field, or a
 * bank line that is not the whole payment. Either way the figure is wrong, and
 * every reading built on it is wrong with it.
 *
 * The two ends read it in opposite directions and so used to disagree on
 * exactly these transactions. The BMD export refuses one (#194); the UVA
 * ladder took the tip into `invoiceTotal`, found the bank short of it, and
 * scaled the document's rates by `bank / invoiceTotal` as a partial payment —
 * a 54,00 charge carrying a 54,00 tip claimed 2,86 of Vorsteuer, on the side
 * whose figures are the ones actually filed.
 *
 * So the predicate lives here and nowhere else, and both sides import it. What
 * they do with a `true` stays theirs: the export withholds the transaction and
 * names the documents, the UVA puts it on the review list as "impossible-tip".
 */

import type { UvaFile } from "./types";

export interface TipAssessment {
  /** The tip summed across the transaction's documents, cents. */
  tip: number;
  /**
   * The documents that carry a tip figure. All of them, because correcting
   * one of two 27,00 tips on a 54,00 charge does not make the sum possible.
   */
  tipFiles: UvaFile[];
  /** The tip is not less than the bank line, so it is not a tip. */
  impossible: boolean;
}

/**
 * Read the tip off a transaction's (already converted) documents and judge it
 * against the bank line. `bankGross` is `Math.abs(tx.amount)` on both sides.
 *
 * The boundary is `>=`, not `>`: a tip that EQUALS the payment is the exact
 * misextraction #194 is about — the Gesamt copied into the Trinkgeld field —
 * and it leaves nothing at all for the document's rates to apply to.
 */
export function assessTip(
  files: readonly UvaFile[] | null | undefined,
  bankGross: number
): TipAssessment {
  const tipFiles = (files ?? []).filter((f) => (f.tipAmount ?? 0) > 0);
  const tip = tipFiles.reduce((s, f) => s + (f.tipAmount ?? 0), 0);
  return { tip, tipFiles, impossible: tip > 0 && tip >= bankGross };
}
