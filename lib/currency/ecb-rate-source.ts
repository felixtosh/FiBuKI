/**
 * The display side's ECB rate table: one shared, lazily-widened cache in front
 * of `/api/fx/rates` (#120).
 *
 * ## Why a cache and not a fetch per conversion
 *
 * The five components that convert for display do it inside render — a table
 * cell renderer, a row, a tooltip — and there is no request boundary to hang an
 * await on. So the conversion stays SYNCHRONOUS and this module answers from
 * whatever it has: it returns null for a day it cannot price yet, records what
 * was asked for, fetches the missing window once, and notifies subscribers so
 * the same render runs again with a figure. Null is not an error state; it is
 * the same conversion-failed path those components already show for a date the
 * old hardcoded table could not reach.
 *
 * ## Why it widens instead of paging
 *
 * The needed dates are whatever documents the user is looking at, which is not
 * knowable up front and is usually one tight cluster. Tracking the min and max
 * needed date and the set of needed currencies collapses that to one request,
 * and the response is proportional to the currencies actually on screen rather
 * than to the ~30 the ECB publishes. A wider need re-fetches the wider window
 * once; a narrower one is already covered and fetches nothing.
 *
 * ## Deploy gap
 *
 * `fxReferenceRates` is filled by `scheduledRefreshEcbRates`. Until that job
 * has run once in the target project the store is empty, the route answers with
 * no days, and every conversion returns null. That is deliberate: an empty
 * store must never become a zero or a stale figure.
 */

import {
  EMPTY_ECB_RATE_TABLE,
  buildEcbRateTable,
  ecbCrossRate,
  type EcbDay,
  type EcbRateTable,
} from "@/functions/src/fx/ecbRates";
import { normalizeCurrencyForDisplay } from "@/functions/src/fx/currencyNormalization";
import { fetchWithAuth } from "@/lib/api/fetch-with-auth";

/** Shape returned by GET /api/fx/rates. */
interface RatesResponse {
  days?: EcbDay[];
}

export interface EcbConversion {
  /** Converted amount, in the same minor units as the input. */
  amount: number;
  currency: string;
  rate: number;
  /**
   * ECB publication day the rate came from (YYYY-MM-DD), or "n/a" for a
   * same-currency conversion. Not always the requested date: the ECB does not
   * publish at weekends, so a Saturday payment reads the preceding Friday.
   */
  rateDate: string;
}

/** What the current table covers. Null means nothing has been loaded yet. */
interface Coverage {
  start: string;
  end: string;
  currencies: Set<string>;
}

/**
 * How long to wait after a transient failure before asking again.
 *
 * Without it a 5xx is a per-render request loop: a failed load leaves the
 * window uncovered, the next render finds the same day missing and schedules
 * another flush, and nothing ever breaks the cycle.
 */
const RETRY_COOLDOWN_MS = 30_000;

let table: EcbRateTable = EMPTY_ECB_RATE_TABLE;
let coverage: Coverage | null = null;
let inFlight: Promise<void> | null = null;
let flushScheduled = false;
let cooldownUntil = 0;

/** Dates and currencies asked for since the last successful load. */
const neededDates = new Set<string>();
const neededCurrencies = new Set<string>();

const subscribers = new Set<() => void>();

/** Subscribe to table changes. Returns the unsubscribe. */
export function subscribeToEcbRates(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

function notify(): void {
  for (const cb of [...subscribers]) cb();
}

function isoDay(date: Date): string | null {
  if (Number.isNaN(date.getTime())) return null;
  // Local calendar day: the payment date the user sees is the one to price.
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** True when the loaded table already answers for this date and currency. */
function covers(date: string, currency: string): boolean {
  if (!coverage) return false;
  return (
    date >= coverage.start && date <= coverage.end && coverage.currencies.has(currency)
  );
}

function scheduleFlush(): void {
  if (flushScheduled || typeof window === "undefined") return;
  flushScheduled = true;
  // Batch every need recorded during this render pass into one request.
  queueMicrotask(() => {
    flushScheduled = false;
    void loadMissing();
  });
}

/**
 * Fetch the window the recorded needs imply, if the current table does not
 * already cover it. One request at a time; needs recorded while a request is in
 * flight are picked up by the next flush.
 */
async function loadMissing(): Promise<void> {
  if (inFlight) return;
  if (Date.now() < cooldownUntil) return;
  if (neededDates.size === 0 || neededCurrencies.size === 0) return;

  const dates = [...neededDates].sort();
  const start = dates[0];
  const end = dates[dates.length - 1];
  const currencies = [...neededCurrencies].sort();

  const alreadyCovered =
    coverage !== null &&
    start >= coverage.start &&
    end <= coverage.end &&
    currencies.every((c) => coverage!.currencies.has(c));
  if (alreadyCovered) return;

  const widened: Coverage = {
    start: coverage && coverage.start < start ? coverage.start : start,
    end: coverage && coverage.end > end ? coverage.end : end,
    currencies: new Set([...(coverage?.currencies ?? []), ...currencies]),
  };

  inFlight = (async () => {
    try {
      const query = new URLSearchParams({
        start: widened.start,
        end: widened.end,
        currencies: [...widened.currencies].join(","),
      });
      const response = await fetchWithAuth(`/api/fx/rates?${query.toString()}`);
      if (!response.ok) {
        // A 4xx is about the request itself — a window the route refuses to
        // serve — so asking again with the same window would only repeat it.
        // Mark it covered and render the missing conversion. Anything else is
        // transient; hold off rather than retry once per render.
        if (response.status >= 400 && response.status < 500) coverage = widened;
        else cooldownUntil = Date.now() + RETRY_COOLDOWN_MS;
        return;
      }
      const body = (await response.json()) as RatesResponse;
      table = buildEcbRateTable(body.days ?? []);
      // Coverage is what was ASKED for, not what came back. An empty store
      // answers with no days, and re-asking for the same window on every
      // render would be a request loop; the next refresh of the page picks up
      // a store that has since been filled.
      coverage = widened;
      notify();
    } catch {
      // Offline, or a body that would not parse. Keep whatever table we have —
      // callers already render a missing conversion — and hold off before the
      // next attempt so a persistent failure is not one request per render.
      cooldownUntil = Date.now() + RETRY_COOLDOWN_MS;
    } finally {
      inFlight = null;
    }
  })();

  await inFlight;
}

/**
 * Convert `amount` (in minor units) between currencies at the ECB rate for
 * `date`, or null when this table cannot price that day yet.
 *
 * Records the need either way, so the first render of a page misses and the
 * one after the fetch hits.
 */
export function convertAtEcbRate(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  date: Date
): EcbConversion | null {
  const from = normalizeCurrencyForDisplay(fromCurrency);
  const to = normalizeCurrencyForDisplay(toCurrency);
  if (from === to) return { amount, currency: to, rate: 1, rateDate: "n/a" };

  const day = isoDay(date);
  if (!day) return null;

  let missing = false;
  for (const code of [from, to]) {
    if (code === "EUR") continue; // the quote unit is never in the feed
    if (!covers(day, code)) missing = true;
    if (!neededCurrencies.has(code)) {
      neededCurrencies.add(code);
      missing = true;
    }
  }
  neededDates.add(day);
  if (missing) scheduleFlush();

  const hit = ecbCrossRate(table, from, to, day);
  if (!hit) return null;

  return {
    amount: Math.round(amount * hit.rate),
    currency: to,
    rate: hit.rate,
    rateDate: hit.rateDate,
  };
}

/** Test seam: forget the loaded table and everything asked for. */
export function __resetEcbRateSource(): void {
  table = EMPTY_ECB_RATE_TABLE;
  coverage = null;
  inFlight = null;
  flushScheduled = false;
  cooldownUntil = 0;
  neededDates.clear();
  neededCurrencies.clear();
  subscribers.clear();
}
