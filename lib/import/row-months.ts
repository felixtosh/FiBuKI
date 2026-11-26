import { parseDate } from "@/lib/import/date-parsers";

/**
 * A CSV's rows counted per month (`YYYY-MM`) of their date column, for the
 * Import preview's question about rows before Tracked From (#805). The month
 * is the UTC date part of the parsed day, the same one the Import's writer
 * reads from the date it is sent; rows without a readable date are left out,
 * as the Import reports them as errors.
 */
export function countRowMonths(
  rows: Record<string, string>[],
  dateColumn: string,
  dateFormat: string
): Record<string, number> {
  const months: Record<string, number> = {};
  for (const row of rows) {
    const value = row[dateColumn];
    if (!value) continue;
    const date = parseDate(value, dateFormat);
    if (!date) continue;
    const month = date.toISOString().slice(0, 7);
    months[month] = (months[month] ?? 0) + 1;
  }
  return months;
}
