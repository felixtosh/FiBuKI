/**
 * The Due Date (Fälligkeitsdatum) a File states, read off its Extraction (#236).
 *
 * Extraction already transcribes it, but into the untyped additional-fields
 * bag, where the Match cannot reach it. This is the one reader of that bag for
 * the purpose. The File facts module calls it to store the typed
 * `extractedDueDate` (on an Extraction, a Hand Correction and the one-time
 * backfill, #641); the scorer reads the stored date, never the rows.
 *
 * Deliberately narrow. It accepts the extraction vocabulary's `dueDate` key
 * (#252) and, on a keyless legacy row, the printed synonyms of the
 * Fälligkeitsdatum: the closed set CONTEXT.md lists, widened from the one
 * literal "Due Date" by #135. What it must never accept is a Zahlungsziel:
 * that is a period ("14 Tage"), not a date, and the payment window scores
 * anything inside it as an exact hit, so a wrong Due Date is strictly worse
 * than a missing one. The same inversion happens when a misread lands the
 * Due Date before the issue date, so a caller that knows the issue date
 * passes it and such a row is rejected rather than written (#135).
 */

/** One additional-fields row, as loosely as this module needs to read it. */
interface AdditionalFieldLike {
  key?: unknown;
  label?: unknown;
  value?: unknown;
}

/** A value that parses to a date this early is a misread, not a Due Date. */
const EARLIEST_PLAUSIBLE_YEAR = 1990;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Labels that name the payment period rather than a date. Never a Due Date. */
function isPaymentTermLabel(label: string): boolean {
  return /zahlungsziel|payment\s*terms?|zahlungsbedingung/.test(label);
}

/**
 * The printed synonyms of the Fälligkeitsdatum, from CONTEXT.md's
 * `_Also printed as_` list, plus the literal "Due Date" the legacy prompt
 * wrote (#135). A closed set that fails closed, like the key vocabulary:
 * an unlisted label is not a Due Date, however date-shaped its value.
 */
const DUE_DATE_LABELS: ReadonlySet<string> = new Set([
  "due date",
  "fälligkeitsdatum",
  "zahlungstermin",
  "fällig am",
  "zahlbar bis",
  "zahlbar ohne abzug bis",
]);

function isDueDateRow(field: AdditionalFieldLike): boolean {
  const key = typeof field.key === "string" ? field.key : undefined;
  const label =
    typeof field.label === "string"
      ? field.label.trim().replace(/:$/, "").trim().toLowerCase()
      : "";

  if (key === "paymentTerms" || isPaymentTermLabel(label)) return false;
  if (key === "dueDate") return true;
  // A keyless row predates the closed vocabulary (or was typed by hand).
  return key === undefined && DUE_DATE_LABELS.has(label);
}

/**
 * An ISO `YYYY-MM-DD` value as UTC midnight of that day, which is how a stored
 * date names a calendar day (#638). Anything else, including a rolled-over
 * date like 2026-02-31, is null.
 */
export function parseIsoDueDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const match = ISO_DATE.exec(value.trim());
  if (!match) return null;

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < EARLIEST_PLAUSIBLE_YEAR) return null;

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

/**
 * The Due Date the rows state, or null when none of them states one usably.
 * The first qualifying row wins, which is the order extraction wrote them in.
 *
 * With `issueDate` given, a date earlier than the issue day does not qualify:
 * it inverts the payment window #236 scores against, so it is a misread to
 * reject, not a value to write (#135). Equal is fine, zahlbar sofort is a
 * real document. Day-level, because both dates are calendar days, and the
 * issue day is read from the UTC date part, as stored dates require: the
 * host's local day of a UTC-midnight date is the day before west of
 * Greenwich (#638).
 */
export function dueDateFromAdditionalFields(
  fields: unknown,
  issueDate?: Date | null
): Date | null {
  if (!Array.isArray(fields)) return null;

  const issueDay = utcDayOf(issueDate);

  for (const raw of fields) {
    if (!raw || typeof raw !== "object") continue;
    const field = raw as AdditionalFieldLike;
    if (!isDueDateRow(field)) continue;
    const date = parseIsoDueDate(field.value);
    if (!date) continue;
    if (issueDay !== null && date.getTime() < issueDay) continue;
    return date;
  }
  return null;
}

/**
 * The calendar day a stored date names, as the epoch of its UTC midnight, or
 * null for no date. Shared with the Debit Date, which applies the same guard.
 */
export function utcDayOf(date: Date | null | undefined): number | null {
  if (!(date instanceof Date) || isNaN(date.getTime())) return null;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Days after a stated payment date (a Due Date or a Debit Date) its booking
 * may still land and count as that date (#136, #618). The stated day can fall
 * on a weekend or bank holiday, and the bank then books the next banking day.
 * Three covers a Friday-holiday-weekend run. Forward only, and no holiday
 * calendar: a booking before the stated day is not explained by it.
 */
export const SETTLEMENT_LAG_DAYS = 3;

/**
 * Shortest learned cycle whose expected day gets the settlement lag (#618).
 * On a monthly or longer cycle three days is weekend noise; on a weekly one
 * it is almost half a period, and would tie the real charge with a
 * same-amount neighbour booked a day or two later (the INCW9PTA shape).
 */
export const SETTLEMENT_LAG_MIN_FREQUENCY_DAYS = 28;

/**
 * The forward lag a learned cycle's expected booking day gets: the
 * settlement lag on a monthly or longer cycle, none on a shorter or unknown
 * one.
 */
export function learnedCycleSettlementLag(frequencyDays: number | undefined): number {
  return (frequencyDays ?? 0) >= SETTLEMENT_LAG_MIN_FREQUENCY_DAYS ? SETTLEMENT_LAG_DAYS : 0;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whole days from `stated` to `booked`, negative when the booking is earlier.
 * Both are calendar days stored as midnight, so rounding the difference reads
 * the day without consulting the host's zone.
 */
export function daysAfter(stated: Date, booked: Date): number {
  return Math.round((booked.getTime() - stated.getTime()) / MS_PER_DAY);
}

/**
 * Whether a booking on `txDate` is the payment a Due Date asks for (#618): on
 * the Due Date or within the settlement lag after it. Like a Debit Date hit,
 * and for the same reason: a Due Date on a Saturday is paid on the Monday.
 */
export function isDueDateHit(dueDate: Date, txDate: Date): boolean {
  const lag = daysAfter(dueDate, txDate);
  return lag >= 0 && lag <= SETTLEMENT_LAG_DAYS;
}
