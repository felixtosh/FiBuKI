/**
 * Lightweight currency converter with historical monthly rates.
 * Uses ECB reference rates (EUR as base) for common currencies.
 *
 * This is a static/offline converter - rates are approximate monthly averages.
 * For tax purposes, official rates from the local tax authority should be used.
 */

export interface ConversionResult {
  amount: number;      // Converted amount in cents
  currency: string;    // Target currency
  rate: number;        // Exchange rate used
  /**
   * Month the rate was taken from (e.g. "2024-01"), or "n/a" for a
   * same-currency conversion. Up to MAX_RATE_SUBSTITUTION_MONTHS earlier than
   * the requested date — show it wherever the converted figure is shown, so a
   * substituted rate is visible rather than implied.
   */
  rateDate: string;
}

// Monthly EUR exchange rates (1 EUR = X foreign currency)
// Data: approximate monthly averages from ECB reference rates
const EUR_RATES: Record<string, Record<string, number>> = {
  // 2024 rates
  "2024-01": { USD: 1.0875, GBP: 0.8570, CHF: 0.9375, JPY: 160.50 },
  "2024-02": { USD: 1.0775, GBP: 0.8545, CHF: 0.9430, JPY: 161.20 },
  "2024-03": { USD: 1.0850, GBP: 0.8555, CHF: 0.9665, JPY: 163.40 },
  "2024-04": { USD: 1.0725, GBP: 0.8565, CHF: 0.9745, JPY: 166.10 },
  "2024-05": { USD: 1.0830, GBP: 0.8530, CHF: 0.9810, JPY: 169.90 },
  "2024-06": { USD: 1.0750, GBP: 0.8455, CHF: 0.9585, JPY: 170.80 },
  "2024-07": { USD: 1.0850, GBP: 0.8430, CHF: 0.9680, JPY: 170.25 },
  "2024-08": { USD: 1.0990, GBP: 0.8535, CHF: 0.9440, JPY: 161.50 },
  "2024-09": { USD: 1.1075, GBP: 0.8420, CHF: 0.9395, JPY: 160.30 },
  "2024-10": { USD: 1.0875, GBP: 0.8370, CHF: 0.9395, JPY: 163.50 },
  "2024-11": { USD: 1.0590, GBP: 0.8345, CHF: 0.9365, JPY: 163.20 },
  "2024-12": { USD: 1.0480, GBP: 0.8290, CHF: 0.9310, JPY: 162.75 },
  // 2025 rates (projections/early data)
  "2025-01": { USD: 1.0350, GBP: 0.8385, CHF: 0.9415, JPY: 163.00 },
  // 2023 rates
  "2023-01": { USD: 1.0845, GBP: 0.8820, CHF: 0.9985, JPY: 140.75 },
  "2023-02": { USD: 1.0725, GBP: 0.8860, CHF: 0.9880, JPY: 142.50 },
  "2023-03": { USD: 1.0725, GBP: 0.8765, CHF: 0.9920, JPY: 143.80 },
  "2023-04": { USD: 1.0950, GBP: 0.8795, CHF: 0.9820, JPY: 147.40 },
  "2023-05": { USD: 1.0865, GBP: 0.8695, CHF: 0.9740, JPY: 149.90 },
  "2023-06": { USD: 1.0870, GBP: 0.8585, CHF: 0.9760, JPY: 156.65 },
  "2023-07": { USD: 1.1065, GBP: 0.8595, CHF: 0.9590, JPY: 156.35 },
  "2023-08": { USD: 1.0905, GBP: 0.8575, CHF: 0.9580, JPY: 158.10 },
  "2023-09": { USD: 1.0705, GBP: 0.8645, CHF: 0.9595, JPY: 157.90 },
  "2023-10": { USD: 1.0575, GBP: 0.8695, CHF: 0.9505, JPY: 158.60 },
  "2023-11": { USD: 1.0820, GBP: 0.8705, CHF: 0.9610, JPY: 162.10 },
  "2023-12": { USD: 1.0920, GBP: 0.8625, CHF: 0.9440, JPY: 158.25 },
  // 2022 rates
  "2022-01": { USD: 1.1315, GBP: 0.8365, CHF: 1.0365, JPY: 130.35 },
  "2022-02": { USD: 1.1355, GBP: 0.8395, CHF: 1.0450, JPY: 130.45 },
  "2022-03": { USD: 1.1025, GBP: 0.8365, CHF: 1.0245, JPY: 129.75 },
  "2022-04": { USD: 1.0815, GBP: 0.8365, CHF: 1.0225, JPY: 135.75 },
  "2022-05": { USD: 1.0595, GBP: 0.8495, CHF: 1.0305, JPY: 135.40 },
  "2022-06": { USD: 1.0575, GBP: 0.8535, CHF: 1.0175, JPY: 140.80 },
  "2022-07": { USD: 1.0175, GBP: 0.8465, CHF: 0.9835, JPY: 138.60 },
  "2022-08": { USD: 1.0135, GBP: 0.8455, CHF: 0.9670, JPY: 136.85 },
  "2022-09": { USD: 0.9955, GBP: 0.8745, CHF: 0.9680, JPY: 141.75 },
  "2022-10": { USD: 0.9845, GBP: 0.8715, CHF: 0.9845, JPY: 146.35 },
  "2022-11": { USD: 1.0195, GBP: 0.8675, CHF: 0.9805, JPY: 145.25 },
  "2022-12": { USD: 1.0565, GBP: 0.8695, CHF: 0.9875, JPY: 143.25 },
};

// The currency set this table covers. Any code outside it converts to null,
// which is why getAvailableCurrencies reads its keys rather than a hand-kept
// list. Not a fallback any more: a date the table cannot reach returns null.
const COVERED_CURRENCIES = EUR_RATES["2025-01"] || EUR_RATES["2024-12"];

/** How far back a missing month may borrow a neighbouring month's rate. */
export const MAX_RATE_SUBSTITUTION_MONTHS = 3;

/** The newest month this table holds, as YYYY-MM. */
export function getLatestRateMonth(): string {
  return Object.keys(EUR_RATES).sort().reverse()[0] ?? "";
}

function monthKeyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Get the EUR rate for a specific month, or null when the table does not
 * reach it.
 *
 * A missing month borrows from up to MAX_RATE_SUBSTITUTION_MONTHS earlier —
 * rates move slowly enough that a one-quarter substitution is a rounding
 * question. Past that the answer is null, not the newest row in the table.
 *
 * It used to be the newest row: every date from four months after the last
 * key onward was converted at that key's rates and rendered identically to a
 * correct figure. `rateDate` carried the substitution but no consumer read it,
 * so a table that stopped in 2025-01 quietly priced every 2026 amount at
 * January 2025. Returning null instead puts those amounts on the components'
 * existing conversion-failed path, where the user can see the tool does not
 * know rather than being told a wrong number confidently.
 */
function getEurRatesForMonth(
  date: Date
): { rates: Record<string, number>; rateDate: string } | null {
  const monthKey = monthKeyOf(date);

  if (EUR_RATES[monthKey]) {
    return { rates: EUR_RATES[monthKey], rateDate: monthKey };
  }

  for (let i = 1; i <= MAX_RATE_SUBSTITUTION_MONTHS; i++) {
    const prevDate = new Date(date);
    prevDate.setMonth(prevDate.getMonth() - i);
    const prevKey = monthKeyOf(prevDate);
    if (EUR_RATES[prevKey]) {
      return { rates: EUR_RATES[prevKey], rateDate: prevKey };
    }
  }

  return null;
}

/**
 * Convert an amount from one currency to another using historical monthly rates.
 *
 * @param amount - Amount in cents
 * @param fromCurrency - Source currency code (e.g., "USD")
 * @param toCurrency - Target currency code (e.g., "EUR")
 * @param date - Date to use for exchange rate lookup
 * @returns Conversion result or null if conversion not possible
 */
export function convertCurrency(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  date: Date
): ConversionResult | null {
  // Normalize currency codes
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();

  // Same currency - no conversion needed
  if (from === to) {
    return { amount, currency: to, rate: 1, rateDate: "n/a" };
  }

  const monthRates = getEurRatesForMonth(date);
  // No rate within reach of this date. The caller renders its conversion-failed
  // state rather than a figure priced off an unrelated month.
  if (!monthRates) return null;

  const { rates, rateDate } = monthRates;

  let rate: number;

  if (from === "EUR") {
    // Converting from EUR to foreign currency
    if (!rates[to]) return null;
    rate = rates[to];
  } else if (to === "EUR") {
    // Converting from foreign currency to EUR
    if (!rates[from]) return null;
    rate = 1 / rates[from];
  } else {
    // Cross-rate conversion via EUR
    if (!rates[from] || !rates[to]) return null;
    // from -> EUR -> to
    rate = rates[to] / rates[from];
  }

  const convertedAmount = Math.round(amount * rate);

  return {
    amount: convertedAmount,
    currency: to,
    rate,
    rateDate,
  };
}

/**
 * Get available currencies for conversion
 */
export function getAvailableCurrencies(): string[] {
  return ["EUR", ...Object.keys(COVERED_CURRENCIES)];
}
