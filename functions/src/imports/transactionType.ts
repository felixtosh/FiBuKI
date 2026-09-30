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
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  for (const [type, pattern] of PATTERNS) {
    if (pattern.test(text)) return type;
  }
  return null;
}
