/**
 * The canonical kind of a bank line, derived at Import from the bank's own
 * wording (#136). Sources print "Lastschrift", "SEPA-Lastschrift",
 * "Einzugsermächtigung" and "Direct Debit" for the same thing; the Match needs
 * one name to treat a Debit Date on a direct debit as near-proof.
 *
 * Mirrored by `TransactionType` in types/transaction.ts (the functions build
 * cannot import from outside src); transactionType.sync.test.ts pins the two.
 */

export const TRANSACTION_TYPES = ["direct_debit", "standing_order", "transfer", "card"] as const;

export type TransactionType = (typeof TRANSACTION_TYPES)[number];

// Checked in order: a standing order is also a transfer, and "Debit Card" is
// not a direct debit, so the specific patterns come first.
const PATTERNS: ReadonlyArray<[TransactionType, RegExp]> = [
  ["standing_order", /dauerauftrag|standing\s*order/],
  ["card", /karte|kartenzahlung|bankomat|debit\s*card|credit\s*card|card\s*payment|\bpos\b|maestro|visa|mastercard/],
  ["direct_debit", /lastschrift|einzug|direct\s*debit|sepa\s*(core|b2b)\b|\bsdd\b/],
  ["transfer", /überweisung|ueberweisung|uberweisung|transfer|gutschrift|\bsct\b/],
];

/** The canonical type of a bank's raw type string, or null when unknown. */
export function normalizeTransactionType(raw: unknown): TransactionType | null {
  if (typeof raw !== "string") return null;
  // Bank APIs spell it DIRECT_DEBIT or CARD-PAYMENT.
  const text = raw.trim().toLowerCase().replace(/[_-]+/g, " ");
  if (!text) return null;
  for (const [type, pattern] of PATTERNS) {
    if (pattern.test(text)) return type;
  }
  return null;
}

/**
 * Headers that carry the bank's type wording when no Source mapping names one:
 * TrueLayer's `transaction_category`, finAPI's `type`, Revolut's `Type`, and
 * the German CSV headers the import field definitions list. Not TrueLayer's
 * `transaction_type`: it only says DEBIT or CREDIT.
 */
const KNOWN_TYPE_HEADERS = [
  "transaction_category",
  "type",
  "Type",
  "Buchungsart",
  "Umsatzart",
  "Transaktionsart",
  "Zahlungsart",
  "Transaction Type",
  "Payment Type",
];

/**
 * The canonical type of a stored raw row: the column the Source mapped to the
 * bank's type first, then the known type headers. Null when none reads.
 */
export function transactionTypeFromRawRow(
  rawRow: Record<string, unknown> | null | undefined,
  mappedColumn?: string | null
): TransactionType | null {
  if (!rawRow) return null;
  const headers = mappedColumn ? [mappedColumn, ...KNOWN_TYPE_HEADERS] : KNOWN_TYPE_HEADERS;
  for (const header of headers) {
    const type = normalizeTransactionType(rawRow[header]);
    if (type) return type;
  }
  return null;
}

/** Whether a raw row carries any column the type could be read from. */
export function hasTypeColumn(
  rawRow: Record<string, unknown> | null | undefined,
  mappedColumn?: string | null
): boolean {
  if (!rawRow) return false;
  return [mappedColumn, ...KNOWN_TYPE_HEADERS].some((h) => h && typeof rawRow[h] === "string" && rawRow[h] !== "");
}
