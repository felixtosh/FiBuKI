/**
 * The Debit Date (Einzugsdatum) a File states, read off its Extraction (#136).
 *
 * The date a Partner states it will collect under a SEPA mandate. A different
 * fact from the Due Date: a Due Date is an obligation on the User, a Debit Date
 * is what the Partner will do. They coincide on many invoices and diverge on
 * others, so they are two fields, and a row of one is never read as the other.
 *
 * Same shape as dueDate.ts: the extraction vocabulary's `debitDate` key, or on
 * a keyless legacy row a closed set of printed labels, failing closed. The
 * prose form ("wird am ... eingezogen") has no label to match; the prompt
 * files it under the key.
 */

import { parseIsoDueDate, SETTLEMENT_LAG_DAYS, utcDayOf } from "./dueDate";

/**
 * Days after the Debit Date a collection may still be booked: the Debit Date
 * can fall on a weekend or bank holiday, and the bank then books the next
 * banking day. The same lag a Due Date gets (#618).
 */
export const DEBIT_DATE_SETTLEMENT_DAYS = SETTLEMENT_LAG_DAYS;

interface AdditionalFieldLike {
  key?: unknown;
  label?: unknown;
  value?: unknown;
}

/** CONTEXT.md's `_Also printed as_` labels for the Debit Date. */
const DEBIT_DATE_LABELS: ReadonlySet<string> = new Set([
  "einzugsdatum",
  "einzug am",
  "lastschrift am",
  "abbuchung am",
  "abbuchung erfolgt am",
  "abbuchungsdatum",
  "debit date",
]);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isDebitDateRow(field: AdditionalFieldLike): boolean {
  const key = typeof field.key === "string" ? field.key : undefined;
  if (key === "debitDate") return true;
  if (key !== undefined) return false;
  const label =
    typeof field.label === "string"
      ? field.label.trim().replace(/:$/, "").trim().toLowerCase()
      : "";
  return DEBIT_DATE_LABELS.has(label);
}

/**
 * The Debit Date among a File's additional fields, or null. With `issueDate`
 * given, a Debit Date before the issue day is a misread and is rejected; the
 * issue day is its UTC date part, as for the Due Date.
 */
export function debitDateFromAdditionalFields(
  fields: unknown,
  issueDate?: Date | null
): Date | null {
  if (!Array.isArray(fields)) return null;

  const issueDay = utcDayOf(issueDate);

  for (const raw of fields) {
    if (!raw || typeof raw !== "object") continue;
    const field = raw as AdditionalFieldLike;
    if (!isDebitDateRow(field)) continue;
    const date = parseIsoDueDate(field.value);
    if (!date) continue;
    if (issueDay !== null && date.getTime() < issueDay) continue;
    return date;
  }
  return null;
}

/**
 * Whether a bank booking on `txDate` is the collection a Debit Date announces.
 *
 * A SEPA collection is booked on the Debit Date or, when that is not a banking
 * day, shortly after. Never before: the Partner may not collect early. Day-level.
 */
export function isDebitDateHit(debitDate: Date, txDate: Date): boolean {
  const debitDay = utcDayOf(debitDate);
  const txDay = utcDayOf(txDate);
  if (debitDay === null || txDay === null) return false;
  const lag = Math.round((txDay - debitDay) / MS_PER_DAY);
  return lag >= 0 && lag <= DEBIT_DATE_SETTLEMENT_DAYS;
}
