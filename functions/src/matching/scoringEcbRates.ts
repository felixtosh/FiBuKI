/**
 * The ECB rates a matching run needs (#555).
 *
 * The exchange-rate check judges a foreign-currency pair against an anchor.
 * The static table is today's rate, so a 2022 USD invoice, settled when USD
 * sat near parity, read as implausible against it. The published rate for
 * the Transaction's date is the right anchor, and the VAT return already reads
 * it from the same store.
 *
 * One read per run, and none at all when every pair shares a currency, which
 * is nearly every run on an Austrian instance. A failed read scores against
 * the static anchor rather than failing the run: the rate sharpens a band, it
 * is not what makes a Match.
 */

import { loadEcbRateTable } from "../fx/ecbRateStore";
import { EMPTY_ECB_RATE_TABLE, type EcbRateTable } from "../fx/ecbRates";
import { isSameCurrency } from "../fx/fxPlausibility";
import { toDateSafe } from "../utils/toDateSafe";

type Doc = { data(): FirebaseFirestore.DocumentData | undefined };

/**
 * The rate table covering every Transaction date that some File in the run
 * is in another currency from. `fileCurrencies` are the extracted currencies
 * of the Files being scored, one or many.
 */
export async function loadScoringEcbRates(
  db: FirebaseFirestore.Firestore,
  fileCurrencies: Array<string | null | undefined>,
  transactions: Doc[]
): Promise<EcbRateTable> {
  const dates: string[] = [];
  for (const doc of transactions) {
    const tx = doc.data() ?? {};
    if (fileCurrencies.every((c) => isSameCurrency(c, tx.currency))) continue;
    const date = toDateSafe(tx.date);
    if (date) dates.push(date.toISOString().slice(0, 10));
  }
  if (dates.length === 0) return EMPTY_ECB_RATE_TABLE;

  dates.sort();
  try {
    return await loadEcbRateTable(db, dates[0], dates[dates.length - 1]);
  } catch (error) {
    console.warn("[Scoring] ECB rates unavailable, scoring against the static anchor:", error);
    return EMPTY_ECB_RATE_TABLE;
  }
}
