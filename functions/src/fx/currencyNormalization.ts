/**
 * One currency normalizer, and one symbol map (fork #113).
 *
 * There were three, with two behaviours. Both upstream copies —
 * extraction/geminiParser and components/files/file-columns — ended in
 *
 *     return CURRENCY_MAP[currency] || "EUR";
 *
 * so anything that was neither a three-letter ISO code nor a known symbol
 * became EUR. That is upstream of everything: geminiParser writes
 * `extractedCurrency` at extraction time, so a garbled or unsupported currency
 * was already stamped EUR in the database before the scorer or the UVA saw it.
 * From there fxPlausibility saw a same-currency pair and correctly reported no
 * mismatch on a document that was never EUR, and calculateUva put the figure
 * straight into a derivation instead of routing it to the `foreign-currency`
 * worklist built for exactly that case. A coerced record is byte-identical to a
 * genuine EUR one, so nothing downstream could tell.
 *
 * This module therefore refuses to guess: an unrecognised code is preserved,
 * not replaced. Rendering still needs *something*, so display callers ask for a
 * fallback explicitly (`normalizeCurrencyForDisplay`) rather than getting one
 * silently.
 *
 * Deliberately dependency-free: it is imported both by `functions/src` and,
 * because `functions/tsconfig.json` sets `rootDir: "src"` and cannot reach
 * repo-root `lib/`, by the web components directly.
 */

/**
 * Symbols the extraction path can emit instead of an ISO code.
 *
 * Keys are uppercase because lookups uppercase first. That also fixes `Fr.`,
 * which two of the three copies matched case-sensitively against that exact
 * spelling — `FR.` and `fr.` fell through to the EUR coercion.
 */
export const CURRENCY_SYMBOLS: Record<string, string> = {
  "€": "EUR",
  $: "USD",
  "£": "GBP",
  "¥": "JPY",
  CHF: "CHF",
  "FR.": "CHF",
};

/**
 * Canonical currency for a raw extracted value, or null when there is nothing
 * to normalize.
 *
 * - trims and uppercases first, so `usd` is USD and `fr.` is CHF
 * - maps a known symbol to its ISO code
 * - **preserves anything else, uppercased** — a three-letter ISO code included.
 *   An unmappable token is information, and both losing it (null) and replacing
 *   it (EUR) throw that information away. Preserving it also keeps two
 *   different unknown currencies distinguishable, which `isSameCurrency`
 *   depends on.
 * - returns null only for empty, null or undefined input
 */
export function normalizeCurrency(currency?: string | null): string | null {
  const trimmed = (currency ?? "").trim().toUpperCase();
  if (!trimmed) return null;

  return CURRENCY_SYMBOLS[trimmed] ?? trimmed;
}

/**
 * The same normalization for a caller that must render or compare *something*.
 *
 * The fallback is only for the empty case now, not for an unrecognised code —
 * a display that shows an odd code is honest, a display that shows EUR for a
 * document in another currency is not.
 */
export function normalizeCurrencyForDisplay(
  currency?: string | null,
  fallback = "EUR"
): string {
  return normalizeCurrency(currency) ?? fallback;
}
