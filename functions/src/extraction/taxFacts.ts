/**
 * Pure tax arithmetic the extraction and the correction path share (#540).
 *
 * No Firestore, no SDK: the parser, extractionCore and the correction ops all
 * import it, and its tests run without a model.
 */

import { ExtractedLineItem } from "../types/extraction";

/**
 * VAT rates in force in the EU member states and Switzerland, standard and
 * reduced. Used only to recognise the rate behind a printed VAT AMOUNT when
 * the document prints no rate: a rate is accepted only when it reproduces the
 * printed amount to the cent, so the list widens what can be recognised and
 * never what gets guessed.
 */
const KNOWN_VAT_RATES: readonly number[] = [
  0, 2.1, 2.6, 3, 3.8, 4, 5, 5.5, 6, 7, 8, 8.1, 9, 10, 12, 13, 13.5, 14, 15, 16,
  17, 18, 19, 20, 21, 22, 23, 24, 25, 25.5, 27,
];

/**
 * The single rate behind a document's printed VAT amount, or null.
 *
 * "Tax 11,25" under a gross total of 67,50 is 20 %: the only known rate whose
 * VAT inside 67,50 rounds to 11,25. The tolerance is the rounding of the
 * printed figure itself (one cent), so a mixed-rate document, whose VAT no
 * single rate reproduces, gets no rate rather than an average.
 */
export function rateFromDocumentVat(
  grossTotal: number | null | undefined,
  vatAmount: number | null | undefined
): number | null {
  if (
    typeof grossTotal !== "number" || !Number.isFinite(grossTotal) || grossTotal <= 0 ||
    typeof vatAmount !== "number" || !Number.isFinite(vatAmount) || vatAmount <= 0 ||
    vatAmount >= grossTotal
  ) {
    return null;
  }
  let best: { rate: number; error: number } | null = null;
  for (const rate of KNOWN_VAT_RATES) {
    if (rate <= 0) continue;
    const error = Math.abs(Math.round((grossTotal * rate) / (100 + rate)) - vatAmount);
    if (error <= 1 && (!best || error < best.error)) {
      best = { rate, error };
    }
  }
  return best?.rate ?? null;
}

/** The VAT inside a gross amount at a rate, cents. */
export function vatInsideGross(gross: number, rate: number): number {
  return Math.round((gross * rate) / (100 + rate));
}

/**
 * Tolerance for a row's VAT against the VAT its own gross and rate imply.
 *
 * Wide enough for the rounding residual a proportional split puts on one row
 * (#511), narrow enough that a rate taken off the net (10 % of 26,80 written
 * as 2,68 where 2,44 is inside it) or a mistyped figure is caught.
 */
function rowVatTolerance(expected: number): number {
  return Math.max(5, Math.round(Math.abs(expected) * 0.01));
}

/**
 * Make a GROSS row's three numbers agree with each other (#540).
 *
 * The rows a correction posts are gross (the editor's box says so, and the
 * extraction converts net rows before storing them, fork #137). On a gross
 * row, `vatAmount` is fixed by `amount` and `vatPercent`; a correction that
 * sends a contradicting pair would store a row whose VAT no rate explains, and
 * the UVA sums that VAT as if it were read off the document.
 *
 *  - rate given: the VAT is what the rate puts inside the amount. A VAT
 *    within rounding of it is kept as sent (a split residual is not an
 *    error); anything else is replaced by the derived figure.
 *  - no rate, VAT given: the rate is derived from the two, to one decimal.
 *  - VAT larger than the amount: no rate can produce it, so it is refused.
 */
export function enforceGrossRowVat(item: ExtractedLineItem): ExtractedLineItem {
  const { amount } = item;
  if (item.vatPercent !== null) {
    const expected = vatInsideGross(amount, item.vatPercent);
    const vatAmount =
      Math.abs(item.vatAmount - expected) <= rowVatTolerance(expected) ? item.vatAmount : expected;
    return { ...item, vatAmount };
  }
  if (item.vatAmount === 0 || amount === 0) {
    return item;
  }
  if (Math.abs(item.vatAmount) >= Math.abs(amount) || item.vatAmount * amount < 0) {
    throw new RangeError("vatAmount must be smaller than the amount and have the same sign");
  }
  const net = amount - item.vatAmount;
  const vatPercent =
    rateFromDocumentVat(Math.abs(amount), Math.abs(item.vatAmount)) ??
    Math.round(((item.vatAmount * 100) / net) * 10) / 10;
  return { ...item, vatPercent };
}

/** 5 cents or 0.5 %, whichever is larger: the reconciliation's own tolerance. */
function totalTolerance(total: number): number {
  return Math.max(5, Math.round(Math.abs(total) * 0.005));
}

/**
 * Enforce the row invariant on a posted itemisation, unless it is net (#540).
 *
 * Some stored itemisations are NET rows whose VAT sits on top (an outgoing
 * invoice's layout that reconciled as net + VAT, fork #137). Their VAT is not
 * inside the amount, and forcing the gross reading on them would rewrite every
 * row of a correct file on its next save. A set is read as net only when the
 * document total says so: the rows plus their VAT reach it, the rows alone do
 * not. Without a total, the rows are taken as the editor labels them, gross.
 */
export function enforceLineItemVat(
  items: ExtractedLineItem[],
  documentTotal: number | null | undefined
): ExtractedLineItem[] {
  if (typeof documentTotal === "number" && Number.isFinite(documentTotal) && documentTotal > 0) {
    const sum = items.reduce((acc, item) => acc + item.amount, 0);
    const vat = items.reduce((acc, item) => acc + item.vatAmount, 0);
    const tolerance = totalTolerance(documentTotal);
    const readsNet =
      Math.abs(sum + vat - documentTotal) <= tolerance && Math.abs(sum - documentTotal) > tolerance;
    if (readsNet) return items;
  }
  return items.map(enforceGrossRowVat);
}

/**
 * The country a VAT ID belongs to, ISO 3166-1 alpha-2, or null.
 *
 * Every EU VAT ID opens with its member state's prefix, which is the ISO code
 * except for Greece (EL). Swiss UIDs open with CHE, Northern Ireland's with XI.
 */
export function countryFromVatId(vatId: string | null | undefined): string | null {
  if (typeof vatId !== "string") return null;
  const compact = vatId.replace(/[\s.-]/g, "").toUpperCase();
  if (compact.startsWith("CHE")) return "CH";
  const prefix = compact.slice(0, 2);
  if (!/^[A-Z]{2}$/.test(prefix)) return null;
  if (prefix === "EL") return "GR";
  if (prefix === "XI") return "GB";
  return prefix;
}

/** A two-letter country code, uppercased, or null. */
export function normalizeCountry(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}
