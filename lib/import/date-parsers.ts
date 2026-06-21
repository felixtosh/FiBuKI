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
    pattern: /^\d{2}\.\d{2}\.\d{4}$/,
    format: "dd.MM.yyyy",
  },
  {
    id: "de-short",
    name: "German Short (DD.MM.YY)",
    pattern: /^\d{2}\.\d{2}\.\d{2}$/,
    format: "dd.MM.yy",
  },
  // US formats
  {
    id: "us",
    name: "US (MM/DD/YYYY)",
    pattern: /^\d{2}\/\d{2}\/\d{4}$/,
    format: "MM/dd/yyyy",
  },
  {
    id: "us-short",
    name: "US Short (MM/DD/YY)",
    pattern: /^\d{2}\/\d{2}\/\d{2}$/,
    format: "MM/dd/yy",
  },
  // European with slashes
  {
    id: "eu-slash",
    name: "European (DD/MM/YYYY)",
    pattern: /^\d{2}\/\d{2}\/\d{4}$/,
    format: "dd/MM/yyyy",
  },
  // Dash separated
  {
    id: "dash-dmy",
    name: "Dashed (DD-MM-YYYY)",
    pattern: /^\d{2}-\d{2}-\d{4}$/,
    format: "dd-MM-yyyy",
  },
  // Text month formats
  {
    id: "text-short",
    name: "Text Month Short (DD-MMM-YYYY)",
    pattern: /^\d{2}-[A-Za-z]{3}-\d{4}$/,
    format: "dd-MMM-yyyy",
  },
  {
    id: "text-long",
    name: "Text Month Long (DD MMMM YYYY)",
    pattern: /^\d{2}\s+[A-Za-z]+\s+\d{4}$/,
    format: "dd MMMM yyyy",
  },
];

/**
 * Parse a date string using a specific parser
 */
export function parseDate(value: string, parserId: string): Date | null {
  const parser = DATE_PARSERS.find((p) => p.id === parserId);
  if (!parser) return null;

  const trimmed = value.trim();
  const parsed = parse(trimmed, parser.format, new Date());

  if (!isValid(parsed)) return null;

  // Sanity check: year should be reasonable (1990-2100)
  const year = parsed.getFullYear();
  if (year < 1990 || year > 2100) return null;

  // Normalize to UTC midnight — date-fns parse() creates dates in the browser's
  // local timezone, so extract the local date components (which are correct) and
  // reconstruct as UTC to avoid off-by-one errors in non-UTC timezones.
  return new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()));
}

/**
 * Auto-detect the date format from sample values
 * Returns the parser ID that successfully parses the most samples
 */
export function detectDateFormat(samples: string[]): string | null {
  const validSamples = samples.filter((s) => s && s.trim().length > 0);
  if (validSamples.length === 0) return null;

  let bestParser: string | null = null;
  let bestScore = 0;

  for (const parser of DATE_PARSERS) {
    let score = 0;
    for (const sample of validSamples) {
      const trimmed = sample.trim();

      // First check pattern match
      if (!parser.pattern.test(trimmed)) continue;

      // Then try to parse
      const parsed = parse(trimmed, parser.format, new Date());
      if (isValid(parsed)) {
        const year = parsed.getFullYear();
        if (year >= 1990 && year <= 2100) {
          score++;
        }
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestParser = parser.id;
    }
  }

  // Require at least 50% match rate
  if (bestScore >= validSamples.length * 0.5) {
    return bestParser;
  }

  return null;
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
