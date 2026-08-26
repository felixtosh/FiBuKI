export {
  convertCurrency,
  getAvailableCurrencies,
  getLatestRateMonth,
  MAX_RATE_SUBSTITUTION_MONTHS,
  type ConversionResult,
} from "./converter";

// The ECB-backed display conversion (#120). `converter.ts` above is the
// hardcoded table it replaces and is retired in #121; nothing in components/
// reads it any more.
export {
  convertAtEcbRate,
  subscribeToEcbRates,
  __resetEcbRateSource,
  type EcbConversion,
} from "./ecb-rate-source";
export { useEcbConverter, type EcbConverter } from "./use-ecb-converter";
