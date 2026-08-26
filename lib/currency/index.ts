/**
 * Display-side currency conversion.
 *
 * There was a second implementation here until #121: `converter.ts`, with its
 * own hardcoded `EUR_RATES` table of four currencies that stopped at January
 * 2025. It is gone. The rates the components render now come from the same ECB
 * store that matching and the UVA read, so a user and the matcher can no longer
 * be looking at figures derived from two different tables.
 *
 * Currency coverage is therefore **whatever the ECB publishes**, and nothing
 * else. It is deliberately NOT the thirteen anchors in
 * `functions/src/fx/fxPlausibility.ts`: those exist to gate plausibility with
 * tolerances wide enough to swallow card FX markups and years of drift, which
 * is right for "is this a believable pair?" and wrong for "what is this receipt
 * worth in EUR?". They never convert anything, here or anywhere.
 */
export {
  convertAtEcbRate,
  subscribeToEcbRates,
  __resetEcbRateSource,
  type EcbConversion,
} from "./ecb-rate-source";
export { useEcbConverter, type EcbConverter } from "./use-ecb-converter";
