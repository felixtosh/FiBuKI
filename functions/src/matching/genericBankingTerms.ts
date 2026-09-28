/**
 * Generic banking terms — the boilerplate a bank line prints around a name
 * (#235/#271): `Rechnung`, `SEPA`, `Lastschrift`, `payment`, ...
 *
 * One shared module on purpose. The lists used to be module-private consts in
 * patternEngine.ts, reachable only by the pattern-verification prompt, while
 * the partner name scorer compared exactly these words as though they were
 * part of a Partner's name. Both consumers now read the same lists, so the
 * prompt and the scorer cannot drift (the same reason CLAUDE.md documents for
 * models.ts).
 *
 * How the scorer uses them (`stripGenericBankingTerms`, decision on #235):
 * - stripped from the BANK-LINE side only; a Partner name is never modified
 * - word-boundary matching only: `SEPA` in `SEPA-Lastschrift` goes, the
 *   letters inside `Rechnungshof` do not
 * - a term the Partner name itself contains (as a bounded word) is never
 *   removed — the terms are noise in a bank line's surroundings, not
 *   forbidden strings
 * - a line that is empty after stripping scores 0 (the caller checks; an
 *   empty string must never reach a substring comparison)
 */

export const GENERIC_BANKING_TERMS_DE = [
  "rechnung", "rechner", "rechn", "ueberweisung", "überweisung",
  "lastschrift", "gutschrift", "zahlung", "bezahlung", "abbuchung",
  "einzahlung", "auszahlung", "konto", "sepa", "mandat",
  "referenz", "verwendung", "betrag", "iban", "bic", "nr",
];

export const GENERIC_BANKING_TERMS_EN = [
  "transfer", "payment", "card", "direct", "debit", "credit",
  "deposit", "withdrawal", "refund", "purchase", "transaction",
  "topup", "top-up", "top up", "payout", "cashback", "fee",
  "interest", "exchange",
];

/** Both lists, longest term first so no term shadows a longer one mid-strip. */
const ALL_TERMS = [...GENERIC_BANKING_TERMS_DE, ...GENERIC_BANKING_TERMS_EN].sort(
  (a, b) => b.length - a.length
);

/** Unicode-aware: `ü` is a letter, so `\b`-style ASCII boundaries would lie. */
const ALPHANUMERIC = /[\p{L}\p{N}]/u;

function boundedAt(text: string, at: number, length: number): boolean {
  const before = at > 0 ? text[at - 1] : "";
  const after = text[at + length] ?? "";
  return !ALPHANUMERIC.test(before) && !ALPHANUMERIC.test(after);
}

/** Is `term` in `text` as a whole word (both lowercased by the caller)? */
function containsBoundedTerm(text: string, term: string): boolean {
  for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + 1)) {
    if (boundedAt(text, at, term.length)) return true;
  }
  return false;
}

/** Remove every bounded occurrence of `term`, leaving a space in its place. */
function removeBoundedOccurrences(text: string, term: string): string {
  let result = "";
  let from = 0;
  for (;;) {
    const at = text.indexOf(term, from);
    if (at === -1) {
      result += text.slice(from);
      return result;
    }
    if (boundedAt(text, at, term.length)) {
      result += text.slice(from, at) + " ";
      from = at + term.length;
    } else {
      result += text.slice(from, at + 1);
      from = at + 1;
    }
  }
}

/**
 * Strip generic banking terms from a bank line before it is compared with a
 * Partner name. Returns the lowercased, whitespace-collapsed remainder — an
 * empty string when the line was nothing but boilerplate, which the caller
 * must score as 0 rather than compare.
 *
 * `partnerName` is the name the line will be compared against: any term that
 * name itself contains as a bounded word is kept, so a Partner legitimately
 * called by such a word still matches its own lines.
 */
export function stripGenericBankingTerms(
  bankLine: string,
  partnerName?: string | null
): string {
  let line = bankLine.toLowerCase();
  const partner = (partnerName ?? "").toLowerCase();
  for (const term of ALL_TERMS) {
    if (!line.includes(term)) continue;
    if (partner && containsBoundedTerm(partner, term)) continue;
    line = removeBoundedOccurrences(line, term);
  }
  // Drop tokens stripping left without a letter or digit: the "-" out of
  // "SEPA-Lastschrift" would otherwise substring-match any hyphenated name.
  return line
    .split(/\s+/)
    .filter((token) => ALPHANUMERIC.test(token))
    .join(" ");
}
