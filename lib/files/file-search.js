/**
 * Files search (#247): file name, extracted partner, extracted invoice number
 * and extracted amount.
 *
 * Amounts are stored in cents. The query is normalised before it is compared:
 * whitespace and thousands separators dropped, `,` and `.` both accepted as the
 * decimal separator, leading or trailing currency symbols stripped. A currency
 * symbol never constrains currency: typing `€` is a reflex, and silently
 * hiding a USD File because of it would be a trap.
 *
 * A query with decimals matches that exact cent value. A query without
 * decimals matches any File whose euro part equals it, so `42` finds 42,00 and
 * 42,99 but not 1442,00. Digits are never substring-matched against the amount.
 */

const CURRENCY_AFFIX = /^(?:[€$£¥]|eur|usd|gbp|chf)\s*|\s*(?:[€$£¥]|eur|usd|gbp|chf)$/gi;

/**
 * @param {string} query
 * @returns {{ euros: number, cents: number | null } | null}
 *   `cents` is the exact value when the query carried decimals, else null.
 */
function parseAmountQuery(query) {
  let q = (query || "").trim().replace(CURRENCY_AFFIX, "").trim();
  q = q.replace(/\s+/g, "");
  if (!/^\d[\d.,]*$/.test(q)) return null;

  // A trailing separator ("42,") carries no decimals.
  q = q.replace(/[.,]$/, "");

  const lastDot = q.lastIndexOf(".");
  const lastComma = q.lastIndexOf(",");
  let intPart = q;
  let fracPart = null;

  if (lastDot !== -1 && lastComma !== -1) {
    // Both present: the later one is the decimal separator.
    const at = Math.max(lastDot, lastComma);
    intPart = q.slice(0, at);
    fracPart = q.slice(at + 1);
    const thousands = at === lastDot ? "," : ".";
    if (intPart.includes(at === lastDot ? "." : ",")) return null;
    if (!isGrouped(intPart, thousands)) return null;
    intPart = intPart.split(thousands).join("");
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sep = lastDot !== -1 ? "." : ",";
    const parts = q.split(sep);
    const tail = parts[parts.length - 1];
    if (parts.length === 2 && tail.length <= 2) {
      // One separator with one or two digits after it is the decimal.
      intPart = parts[0];
      fracPart = tail;
    } else if (isGrouped(q, sep)) {
      // Otherwise it is a thousands separator: an amount never carries three
      // decimals, so "1.234" is 1234.
      intPart = parts.join("");
    } else {
      return null;
    }
  }

  if (!/^\d+$/.test(intPart)) return null;
  if (fracPart !== null && !/^\d{1,2}$/.test(fracPart)) return null;

  const euros = Number(intPart);
  const cents = fracPart === null ? null : euros * 100 + Number(fracPart.padEnd(2, "0"));
  return { euros, cents };
}

/** "1.234.567" is grouped by threes after the first group. */
function isGrouped(value, sep) {
  const groups = value.split(sep);
  if (groups[0].length < 1 || groups[0].length > 3) return groups.length === 1;
  return groups.slice(1).every((g) => /^\d{3}$/.test(g));
}

/**
 * @param {number} amountCents
 * @param {{ euros: number, cents: number | null }} amountQuery
 */
function matchesAmount(amountCents, amountQuery) {
  const magnitude = Math.abs(amountCents);
  if (amountQuery.cents !== null) return magnitude === amountQuery.cents;
  return Math.floor(magnitude / 100) === amountQuery.euros;
}

/**
 * @param {{
 *   fileName: string,
 *   extractedPartner?: string | null,
 *   extractedInvoiceNumber?: string | null,
 *   extractedAmount?: number | null,
 * }} file
 * @param {string} query
 * @returns {boolean}
 */
function matchesFileSearch(file, query) {
  const trimmed = (query || "").trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();

  const texts = [file.fileName, file.extractedPartner, file.extractedInvoiceNumber];
  if (texts.some((t) => (t || "").toLowerCase().includes(lower))) return true;

  if (typeof file.extractedAmount !== "number") return false;
  const amountQuery = parseAmountQuery(trimmed);
  return amountQuery !== null && matchesAmount(file.extractedAmount, amountQuery);
}

module.exports = { parseAmountQuery, matchesFileSearch };
