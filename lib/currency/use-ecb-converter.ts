"use client";

import { useEffect, useState } from "react";
import {
  convertAtEcbRate,
  subscribeToEcbRates,
  type EcbConversion,
} from "./ecb-rate-source";

/** The synchronous conversion the display components call. */
export type EcbConverter = (
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  date: Date
) => EcbConversion | null;

/**
 * A converter that re-renders its component when the shared ECB rate table
 * widens (#120).
 *
 * The returned function has the same shape the old `convertCurrency` had — call
 * it in render, get a figure or null — so a component that reads it needs no
 * other change. What differs is that the first call for an unseen day or
 * currency answers null and triggers one background fetch; this hook is what
 * turns the arrival of that fetch into a second render.
 *
 * Components that hand the converter to something rendered outside React's
 * component tree (TanStack column definitions, for instance) can pass this
 * function straight through: it is stable across renders and reads the shared
 * table at call time.
 */
export function useEcbConverter(): EcbConverter {
  const [, setVersion] = useState(0);

  useEffect(() => subscribeToEcbRates(() => setVersion((v) => v + 1)), []);

  // Module-level and stateless, so it is already stable across renders — a
  // useCallback would add nothing. That stability is what lets FileTable pass
  // it into a memoized column definition.
  return convertAtEcbRate;
}
