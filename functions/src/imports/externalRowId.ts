/**
 * The External Row Id rules (#796, #804), one copy for every Import path.
 *
 * An External Row Id is an importer's own id for one bank line, unique per Bank
 * Account. FiBuKI derives none: the bank connectors pass the provider's
 * transaction id, `import_transactions` the caller's, and the CSV Import the
 * column mapped as Reference / Transaction ID when that column is one.
 *
 * No runtime imports: the browser's CSV Import and remap read this module too.
 */

/** The longest External Row Id an Import takes. */
export const MAX_EXTERNAL_ROW_ID = 256;

/**
 * One row's External Row Id as sent: trimmed and case-sensitive, an empty or
 * blank one is none. Throws on a non-string or one longer than the limit.
 */
export function readExternalRowId(value: unknown, row: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`externalRowId must be a string (row ${row})`);
  const id = value.trim();
  if (id.length > MAX_EXTERNAL_ROW_ID) {
    throw new Error(`externalRowId must be at most ${MAX_EXTERNAL_ROW_ID} characters (row ${row})`);
  }
  return id || null;
}

/**
 * The External Row Ids of a CSV file, from the values of its Reference /
 * Transaction ID column (one per row, null where the row has none).
 *
 * The field also takes references that are no per-line id: a mandate
 * reference repeats every month, SEPA writes NOTPROVIDED, an end-to-end
 * reference is missing on card payments. Used as ids, those would skip real
 * lines. So the column counts as ids only when every row has a value, no value
 * repeats and none is over the limit; otherwise the file carries no ids and
 * keeps the date, amount and reference check. Ids go on all lines or on none.
 * The server asks the same rule of each call it is sent. A column unique
 * within one file can still repeat across files (a monthly contract
 * reference), so a CSV id finds a stored line only on the same day and amount
 * (dedupe.ts).
 */
export function externalRowIdsFromReferences(references: Array<string | null | undefined>): Array<string | null> {
  const ids = references.map((r) => (typeof r === "string" ? r.trim() : ""));
  const isId = (id: string) => id.length > 0 && id.length <= MAX_EXTERNAL_ROW_ID;
  if (!ids.every(isId) || new Set(ids).size !== ids.length) return references.map(() => null);
  return ids;
}
