/**
 * The Due Date (Fälligkeitsdatum) a File states, read off its Extraction (#236).
 *
 * Extraction already transcribes it, but into the untyped additional-fields
 * bag, where the Match cannot reach it. This is the one reader of that bag for
 * the purpose: extraction calls it to write the typed `extractedDueDate`, the
 * detail editor calls it when a person edits the rows, and the scorer calls
 * it on a record written before the typed field existed, which is what
 * backfills every legacy File without re-extraction.
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
 * An ISO `YYYY-MM-DD` value as a local-midnight Date, the same construction
 * extraction uses for `extractedDate`, so the two compare day for day.
 * Anything else, including a rolled-over date like 2026-02-31, is null.
 */
export function parseIsoDueDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const match = ISO_DATE.exec(value.trim());
  if (!match) return null;

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < EARLIEST_PLAUSIBLE_YEAR) return null;

  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
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
 * real document. Day-level, because both dates are calendar days.
 */
export function dueDateFromAdditionalFields(
  fields: unknown,
  issueDate?: Date | null
): Date | null {
  if (!Array.isArray(fields)) return null;

  const issueDay =
    issueDate instanceof Date && !isNaN(issueDate.getTime())
      ? new Date(issueDate.getFullYear(), issueDate.getMonth(), issueDate.getDate()).getTime()
      : null;

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
