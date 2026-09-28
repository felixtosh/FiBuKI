/**
 * The Connect dialog's search predicate (#183): text OR amount.
 *
 * The search box says "Search by name or amount (e.g. 123,45)". This module is
 * the only implementation of that promise, and it is called by BOTH halves of
 * the search: the server candidate gate in findTransactionMatches.ts and the
 * overlay's client filter (connect-transaction-overlay.tsx). The overlay
 * shows the union of the two, so a predicate on only one side would make
 * results appear and then disappear as the debounce resolves. Same reason the scorer is single-source.
 *
 * This is a search filter, not a Match Source: an amount hit never contributes
 * to match confidence.
 *
 * Known limit: the server's search path reads the 1000 newest transactions
 * with no date filter, so an amount older than that window cannot be found
 * however this predicate is written.
 */

export interface SearchableTransaction {
  name?: string | null;
  partner?: string | null;
  reference?: string | null;
  /** Integer cents, signed. */
  amount?: number | null;
}

/**
 * The query as an amount needle, or null when it is not a numeric query.
 *
 * Strips the euro sign, whitespace and a leading sign, and accepts both `,` and
 * `.` as the decimal mark (left as typed: the needle is matched against every
 * rendering, so which mark was meant does not have to be decided here).
 */
export function parseAmountQuery(query: string): string | null {
  const needle = query.replace(/€/g, "").replace(/\s+/g, "").replace(/^[+-]/, "");
  if (!/^\d[\d.,]*$/.test(needle)) return null;
  return needle;
}

/** Math.abs(amount) as the texts a person would type it as. */
function amountRenderings(cents: number): string[] {
  const abs = Math.abs(Math.round(cents));
  const euros = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, "0");
  const grouped = String(euros).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return [
    `${grouped},${rest}`, // de-AT: 2.140,00
    `${euros},${rest}`, // de-AT without grouping: 2140,00
    `${euros}.${rest}`, // plain: 2140.00
    String(abs), // raw cents: 214000
  ];
}

/**
 * Whether a numeric query matches the transaction amount, compared on absolute
 * values: a File's extracted amount is positive, the transaction that paid it
 * negative. A substring match keeps a partial query useful and predictable:
 * `214` finds 214,20 and 2.140,00.
 */
export function matchesAmountQuery(amount: number | null | undefined, query: string): boolean {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return false;
  const needle = parseAmountQuery(query);
  if (!needle) return false;
  return amountRenderings(amount).some((text) => text.includes(needle));
}

/** Case-insensitive substring over name, partner and reference. */
function matchesTextQuery(tx: SearchableTransaction, lowerQuery: string): boolean {
  return (
    (tx.name || "").toLowerCase().includes(lowerQuery) ||
    (tx.partner || "").toLowerCase().includes(lowerQuery) ||
    (tx.reference || "").toLowerCase().includes(lowerQuery)
  );
}

/**
 * Text search unchanged, with the amount predicate as an OR beside it. An
 * empty query matches everything.
 */
export function matchesTransactionSearch(tx: SearchableTransaction, query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return true;
  return matchesTextQuery(tx, trimmed.toLowerCase()) || matchesAmountQuery(tx.amount, trimmed);
}
