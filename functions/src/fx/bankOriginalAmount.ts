/**
 * Bank-stated original amount (#112).
 *
 * Most bank CSV exports state, per row, what the charge actually was before
 * the bank settled it: `Original Amount`, `Original Currency`, and the
 * `Exchange Rate` they used. The importer already preserves every column in
 * `_original.rawRow`, but nothing read these three, so a USD 24.00 invoice
 * against a EUR 20.77 bank line was answered by *converting* — twice, by two
 * unrelated code paths that disagreed (the whole of #112).
 *
 * They never needed converting. Measured over this instance's 41 foreign
 * rows, `Original Amount` equals the document total exactly, in the
 * document's own currency, on every single one. The EUR figure is only the
 * settlement, and the spread against the ECB reference rate is a median 2
 * cents — noise from fixing times, not a fee to model.
 *
 * So this module answers one question for both consumers, with no rate table
 * and no tolerance: **can these two amounts be compared without converting,
 * and if so, what are the two numbers?** When the answer is no, the caller
 * keeps whatever fallback it had.
 *
 * Dependency-free on purpose: `components/` imports it through
 * `@/functions/src/fx/bankOriginalAmount`, and the app-side build cannot
 * follow anything this file pulls in.
 */

/** What the bank says it actually charged, before settling into its own currency. */
export interface BankOriginalAmount {
  /** Absolute amount in cents, in `currency`. */
  amount: number;
  /** Uppercased ISO currency code as the bank wrote it. */
  currency: string;
  /** The bank's own stated rate. Informational — nothing converts with it. */
  rate: number | null;
}

/**
 * Normalize a CSV header for matching: lowercase, letters and digits only.
 *
 * Umlauts are transliterated rather than stripped, so a German export's
 * "Originalwährung" and "Originalwaehrung" reduce to the same key. Stripping
 * would leave "originalwhrung" and quietly match neither.
 */
function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Header spellings seen across the bank exports this instance imports, plus
 * the obvious German equivalents. Matching is on the normalized key, so
 * "Original Amount", "original_amount" and "OriginalAmount" are one entry.
 */
const AMOUNT_KEYS = new Set([
  "originalamount",
  "amountoriginal",
  "originalbetrag",
  "betragoriginal",
  "originalamountincurrency",
  "foreignamount",
]);

const CURRENCY_KEYS = new Set([
  "originalcurrency",
  "currencyoriginal",
  "originalwaehrung",
  "waehrungoriginal",
  "foreigncurrency",
]);

const RATE_KEYS = new Set(["exchangerate", "wechselkurs", "umrechnungskurs", "devisenkurs"]);

/**
 * Parse a decimal written by a bank, in either the English or the German
 * convention, and return the numeric value.
 *
 * Deliberately refuses the ambiguous case rather than guessing. A single
 * separator followed by exactly three digits ("1.500") is 1500 in German and
 * 1.5 in English, and nothing else in the row disambiguates it. Returning
 * null there costs a fallback to the previous behaviour; guessing wrong would
 * attach a receipt to the wrong payment, which is the failure this module
 * exists to prevent.
 *
 * `maxDecimals` defaults to 2, which is what makes "1.23456" junk rather than
 * money. Exchange rates are published to ten places, so the rate is read with
 * a wider cap — see parseBankRate.
 */
export function parseBankDecimal(
  raw: string | null | undefined,
  maxDecimals = 2
): number | null {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[^0-9.,\-]/g, "").trim();
  if (!cleaned || !/[0-9]/.test(cleaned)) return null;

  const negative = cleaned.startsWith("-");
  const body = cleaned.replace(/-/g, "");
  const dots = (body.match(/\./g) || []).length;
  const commas = (body.match(/,/g) || []).length;

  let normalized: string;
  if (dots && commas) {
    // Both present: whichever comes last is the decimal separator.
    const decimalSep = body.lastIndexOf(".") > body.lastIndexOf(",") ? "." : ",";
    const thousandsSep = decimalSep === "." ? "," : ".";
    normalized = body.split(thousandsSep).join("").replace(decimalSep, ".");
  } else if (dots > 1 || commas > 1) {
    // A repeated single separator can only be a thousands separator.
    normalized = body.replace(/[.,]/g, "");
  } else if (dots === 1 || commas === 1) {
    const sep = dots ? "." : ",";
    const decimals = body.length - body.indexOf(sep) - 1;
    if (decimals === 3) return null; // ambiguous — see doc comment
    if (decimals > maxDecimals) return null; // more precision than this field carries
    normalized = body.replace(sep, ".");
  } else {
    normalized = body;
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/**
 * The bank's stated exchange rate. Same parsing rules as an amount, but rates
 * are published to ten decimal places, so the money cap does not apply.
 */
export function parseBankRate(raw: string | null | undefined): number | null {
  return parseBankDecimal(raw, 12);
}

/**
 * Read the bank-stated original charge out of a preserved CSV row.
 *
 * Returns null unless the row carries BOTH an original amount and an original
 * currency — a rate alone proves nothing, and an amount without a currency
 * cannot be compared to anything.
 */
export function readBankOriginalAmount(
  rawRow: Record<string, string> | null | undefined
): BankOriginalAmount | null {
  if (!rawRow) return null;

  let amountRaw: string | null = null;
  let currencyRaw: string | null = null;
  let rateRaw: string | null = null;

  for (const [key, value] of Object.entries(rawRow)) {
    if (value == null || value === "") continue;
    const k = normalizeKey(key);
    if (amountRaw === null && AMOUNT_KEYS.has(k)) amountRaw = String(value);
    else if (currencyRaw === null && CURRENCY_KEYS.has(k)) currencyRaw = String(value);
    else if (rateRaw === null && RATE_KEYS.has(k)) rateRaw = String(value);
  }

  if (amountRaw === null || currencyRaw === null) return null;

  const currency = currencyRaw.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return null;

  const parsed = parseBankDecimal(amountRaw);
  if (parsed === null || parsed === 0) return null;

  const rate = parseBankRate(rateRaw);
  return {
    amount: Math.round(Math.abs(parsed) * 100),
    currency,
    rate: rate !== null && rate > 0 ? rate : null,
  };
}

/**
 * Express `amount` (cents, in `currency`) in `targetCurrency` **without
 * converting**, using the bank's stated original when that is what bridges
 * the two. Returns null when no rate-free comparison exists.
 *
 * This is the single primitive behind #112: the matcher and the amount pill
 * both ask it, so they can no longer reach different verdicts on one pair.
 */
export function comparableAmount(
  amount: number,
  currency: string | null | undefined,
  original: BankOriginalAmount | null | undefined,
  targetCurrency: string | null | undefined
): number | null {
  const from = (currency ?? "").trim().toUpperCase();
  const to = (targetCurrency ?? "").trim().toUpperCase();
  if (!to) return null;
  if (from === to) return Math.abs(amount);
  if (original && original.currency === to) return Math.abs(original.amount);
  return null;
}
