import { parse, isValid } from "date-fns";
import { DateParser } from "@/types/import";

/**
 * Available date format parsers.
 * Order matters - more specific patterns should come first.
 */
export const DATE_PARSERS: DateParser[] = [
  // ISO datetime with time (most specific - must come before date-only)
  {
    id: "iso-datetime",
    name: "ISO DateTime (YYYY-MM-DD HH:mm:ss)",
    pattern: /^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}$/,
    format: "yyyy-MM-dd HH:mm:ss",
  },
  {
    id: "iso-datetime-t",
    name: "ISO DateTime (YYYY-MM-DDTHH:mm:ss)",
    pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/,
    format: "yyyy-MM-dd'T'HH:mm:ss",
  },
  // ISO date-only format
  {
    id: "iso",
    name: "ISO (YYYY-MM-DD)",
    pattern: /^\d{4}-\d{2}-\d{2}$/,
    format: "yyyy-MM-dd",
  },
  // German formats
  {
    id: "de",
    name: "German (DD.MM.YYYY)",
    pattern: /^\d{1,2}\.\d{1,2}\.\d{4}$/,
    format: "dd.MM.yyyy",
  },
  {
    id: "de-short",
    name: "German Short (DD.MM.YY)",
    pattern: /^\d{1,2}\.\d{1,2}\.\d{2}$/,
    format: "dd.MM.yy",
  },
  // US formats
  {
    id: "us",
    name: "US (MM/DD/YYYY)",
    pattern: /^\d{1,2}\/\d{1,2}\/\d{4}$/,
    format: "MM/dd/yyyy",
  },
  {
    id: "us-short",
    name: "US Short (MM/DD/YY)",
    pattern: /^\d{1,2}\/\d{1,2}\/\d{2}$/,
    format: "MM/dd/yy",
  },
  // European with slashes
  {
    id: "eu-slash",
    name: "European (DD/MM/YYYY)",
    pattern: /^\d{1,2}\/\d{1,2}\/\d{4}$/,
    format: "dd/MM/yyyy",
  },
  {
    id: "eu-slash-short",
    name: "European Short (DD/MM/YY)",
    pattern: /^\d{1,2}\/\d{1,2}\/\d{2}$/,
    format: "dd/MM/yy",
  },
  // Dash separated
  {
    id: "dash-dmy",
    name: "Dashed (DD-MM-YYYY)",
    pattern: /^\d{1,2}-\d{1,2}-\d{4}$/,
    format: "dd-MM-yyyy",
  },
  // Text month formats
  {
    id: "text-short",
    name: "Text Month Short (DD-MMM-YYYY)",
    pattern: /^\d{1,2}-[A-Za-z]{3}-\d{4}$/,
    format: "dd-MMM-yyyy",
  },
  {
    id: "text-long",
    name: "Text Month Long (DD MMMM YYYY)",
    pattern: /^\d{1,2}\s+[A-Za-z]+\s+\d{4}$/,
    format: "dd MMMM yyyy",
  },
];

/**
 * A trailing time-of-day. Banks append one to a date column routinely
 * (Revolut writes "2/1/26 3:18"), and every parser here reduces its value to a
 * calendar day, so the time is read only to be thrown away.
 */
const TRAILING_TIME = /[\sT]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*(?:[AaPp]\.?[Mm]\.?)?$/;

/** The value with a trailing time-of-day removed, unchanged when it has none. */
function withoutTrailingTime(value: string): string {
  return value.replace(TRAILING_TIME, "").trim();
}

/**
 * How a value can be read, most literal first: as written, then with a trailing
 * time removed. A parser that spells the time out itself (the ISO datetime
 * formats) matches the first reading; a date-only parser facing a timestamped
 * column matches the second. date-fns rejects a value with trailing text it was
 * not told to expect, so without the second reading every row of a timestamped
 * column fails to parse.
 */
function dateReadings(value: string): string[] {
  const trimmed = value.trim();
  const dateOnly = withoutTrailingTime(trimmed);

  return dateOnly === trimmed ? [trimmed] : [trimmed, dateOnly];
}

/**
 * Parse a date string using a specific parser
 */
export function parseDate(value: string, parserId: string): Date | null {
  const parser = DATE_PARSERS.find((p) => p.id === parserId);
  if (!parser) return null;

  for (const reading of dateReadings(value)) {
    const parsed = parse(reading, parser.format, new Date());
    if (!isValid(parsed)) continue;

    // Sanity check: year should be reasonable (1990-2100)
    const year = parsed.getFullYear();
    if (year < 1990 || year > 2100) continue;

    // Normalize to UTC midnight — date-fns parse() creates dates in the browser's
    // local timezone, so extract the local date components (which are correct) and
    // reconstruct as UTC to avoid off-by-one errors in non-UTC timezones.
    return new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()));
  }

  return null;
}

/** Which component a numeric parser reads first. */
export type DayMonthOrder = "day-first" | "month-first";

/**
 * What a column of values proves about its day/month order:
 * a proven order, no proof either way, or values that prove both.
 */
export type DayMonthEvidence = DayMonthOrder | "none" | "conflict";

/** A day/month-ambiguous value: two 1-2 digit components, then a year. */
const NUMERIC_DAY_MONTH = /^(\d{1,2})[./-](\d{1,2})[./-]\d{2,4}$/;

/**
 * A format that leads with two numeric day/month components, which is the only
 * shape where the two can be confused. Year-first (ISO) cannot swap, and a
 * spelled-out month ("MMM"/"MMMM") names itself.
 */
const NUMERIC_DAY_MONTH_FORMAT = /^(dd|MM)([./-])(dd|MM)\2y{2,4}$/;

/**
 * The order a parser reads, derived from its date-fns format, or null when the
 * format cannot swap day and month.
 */
export function dayMonthOrderOfFormat(format: string): DayMonthOrder | null {
  const match = NUMERIC_DAY_MONTH_FORMAT.exec(format);
  if (!match || match[1] === match[3]) return null;

  return match[1] === "dd" ? "day-first" : "month-first";
}

/**
 * What the values prove about day/month order. Reads EVERY value it is given —
 * a leading slice that happens to hold no day above 12 is exactly the case
 * that produced silently swapped dates.
 *
 * A first component above 12 can only be a day; a second component above 12
 * can only be a month position holding a day. Values that cannot be ambiguous
 * (ISO, text months) contribute nothing either way.
 */
export function analyzeDayMonthOrder(values: string[]): DayMonthEvidence {
  return readDayMonthEvidence(values).evidence;
}

/**
 * The evidence plus one value proving each order, so a caller can name the
 * rows a reader has to look at rather than just declaring a contradiction.
 */
export function readDayMonthEvidence(values: string[]): {
  evidence: DayMonthEvidence;
  provingDayFirst: string | null;
  provingMonthFirst: string | null;
} {
  let provingDayFirst: string | null = null;
  let provingMonthFirst: string | null = null;

  for (const value of values) {
    // Past the time, or a timestamped column proves nothing and detection
    // falls back to array position — the swap #70 exists to stop.
    const trimmed = withoutTrailingTime(value?.trim() ?? "");
    const match = NUMERIC_DAY_MONTH.exec(trimmed);
    if (!match) continue;

    const first = Number(match[1]);
    const second = Number(match[2]);
    const firstIsDay = first > 12 && first <= 31;
    const secondIsDay = second > 12 && second <= 31;

    // A value where both components exceed 12 is no date in either order —
    // a footer line, a garbage row. Counting it proves both orders at once
    // and forges a conflict out of one bad row.
    if (firstIsDay && secondIsDay) continue;

    if (firstIsDay) provingDayFirst ??= trimmed;
    if (secondIsDay) provingMonthFirst ??= trimmed;
  }

  const evidence: DayMonthEvidence =
    provingDayFirst && provingMonthFirst
      ? "conflict"
      : provingDayFirst
        ? "day-first"
        : provingMonthFirst
          ? "month-first"
          : "none";

  return { evidence, provingDayFirst, provingMonthFirst };
}

/**
 * The parser that reads the same value shape in the opposite order, if the
 * set holds one — how `us` and `eu-slash` relate.
 */
function oppositeOrderParser(parser: DateParser): DateParser | null {
  const order = dayMonthOrderOfFormat(parser.format);
  if (!order) return null;

  return (
    DATE_PARSERS.find(
      (candidate) =>
        candidate.id !== parser.id &&
        candidate.pattern.source === parser.pattern.source &&
        dayMonthOrderOfFormat(candidate.format) !== null &&
        dayMonthOrderOfFormat(candidate.format) !== order
    ) ?? null
  );
}

/** Whether a parser reads one reading of a value as a plausible date. */
function readsAsDate(parser: DateParser, reading: string): boolean {
  if (!parser.pattern.test(reading)) return false;

  const parsed = parse(reading, parser.format, new Date());
  if (!isValid(parsed)) return false;

  const year = parsed.getFullYear();
  return year >= 1990 && year <= 2100;
}

/** How many of the values a parser reads as a plausible date. */
function scoreParser(parser: DateParser, values: string[]): number {
  let score = 0;

  for (const value of values) {
    if (dateReadings(value).some((reading) => readsAsDate(parser, reading))) score++;
  }

  return score;
}

/**
 * Auto-detect the date format from sample values.
 * Returns the parser ID that successfully parses the most samples.
 *
 * Parsers that differ only in day/month order score identically on a column
 * whose days all sit at 12 or lower, and picking one by array position writes
 * swapped dates with no error and a plausible-looking preview. Such a tie is
 * resolved from the column's own evidence, and left unresolved — null, so the
 * user picks from the dropdown — when the column proves nothing.
 */
export function detectDateFormat(samples: string[]): string | null {
  const validSamples = samples.filter((s) => s && s.trim().length > 0);
  if (validSamples.length === 0) return null;

  let bestScore = 0;
  let leaders: DateParser[] = [];

  for (const parser of DATE_PARSERS) {
    const score = scoreParser(parser, validSamples);
    if (score === 0) continue;

    if (score > bestScore) {
      bestScore = score;
      leaders = [parser];
    } else if (score === bestScore) {
      leaders.push(parser);
    }
  }

  // Require at least 50% match rate
  if (leaders.length === 0 || bestScore < validSamples.length * 0.5) return null;

  const winner = leaders[0];
  const winnerOrder = dayMonthOrderOfFormat(winner.format);

  // An unambiguous winner (ISO, spelled-out month) needs no evidence. So does
  // one the column proves right. Everything else — a tie between the two
  // orders, or a lone leader the column contradicts — is decided by the data,
  // and left to the user when the data decides nothing. A leader whose order
  // is contradicted but has no counterpart to swap to (DD/MM/YY had none
  // before eu-slash-short) is unrepresentable: say nothing rather than guess.
  if (!winnerOrder) return winner.id;

  const evidence = analyzeDayMonthOrder(validSamples);
  if (evidence === winnerOrder) return winner.id;

  const tiedOnOtherOrder = leaders.some(
    (p) => dayMonthOrderOfFormat(p.format) && dayMonthOrderOfFormat(p.format) !== winnerOrder
  );
  if (evidence === "none" && !tiedOnOtherOrder) return winner.id;
  if (evidence === "none" || evidence === "conflict") return null;

  const resolved = leaders.find((p) => dayMonthOrderOfFormat(p.format) === evidence);
  return resolved?.id ?? oppositeOrderParser(winner)?.id ?? null;
}

/**
 * Whether the values read as dates at all, independent of which parser wins.
 * A column whose day/month order cannot be settled is still a date column —
 * detection returns null for the format, not for the field (#70).
 */
export function looksLikeDateColumn(values: string[]): boolean {
  const validValues = values.filter((v) => v && v.trim().length > 0);
  if (validValues.length === 0) return false;

  return DATE_PARSERS.some(
    (parser) => scoreParser(parser, validValues) >= validValues.length * 0.5
  );
}

/**
 * Check a chosen parser against the evidence in a whole column, for the point
 * where every row is in hand rather than a 50-row analysis sample. Returns
 * null when the column agrees with the parser, cannot swap day and month, or
 * proves nothing — an explicit human choice is not second-guessed. A returned
 * conflict means importing would file dates under the wrong month.
 */
export function findDateColumnConflict(
  values: string[],
  parserId: string
): {
  evidence: DayMonthEvidence;
  expected: DayMonthOrder;
  suggestedParserId: string | null;
  /** A value the chosen parser cannot read in the order it assumes. */
  offendingValue: string | null;
} | null {
  const parser = getDateParser(parserId);
  if (!parser) return null;

  const expected = dayMonthOrderOfFormat(parser.format);
  if (!expected) return null;

  const { evidence, provingDayFirst, provingMonthFirst } = readDayMonthEvidence(values);
  if (evidence === "none" || evidence === expected) return null;

  // Whichever value contradicts the chosen order is the one to look at: with
  // a day-first parser that is the month-first proof, and the other way round.
  const offendingValue = expected === "day-first" ? provingMonthFirst : provingDayFirst;

  return {
    evidence,
    expected,
    suggestedParserId: evidence === "conflict" ? null : oppositeOrderParser(parser)?.id ?? null,
    offendingValue,
  };
}

/**
 * Get parser by ID
 */
export function getDateParser(id: string): DateParser | undefined {
  return DATE_PARSERS.find((p) => p.id === id);
}

/**
 * Get parser name for display
 */
export function getDateParserName(id: string): string {
  const parser = getDateParser(id);
  return parser?.name ?? id;
}

/**
 * Validate a date string against a specific parser
 */
export function isValidDate(value: string, parserId: string): boolean {
  return parseDate(value, parserId) !== null;
}
