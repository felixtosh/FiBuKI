/**
 * Keeping the ECB reference rates current (#92).
 *
 * The ticket asks for "a refresh path, not a committed snapshot", and the
 * reason is not tidiness: a snapshot is indistinguishable from a live table
 * right up to the day it stops covering the period being filed, and then it
 * prices that period at whatever its last row happened to be. The existing
 * web-side EUR_RATES table is exactly that shape — hand-kept monthly averages
 * that trail off into projections — which is why it is not the source here.
 *
 * The ECB publishes three `eurofxref` feeds with identical markup. Two are
 * used:
 *
 *  - the 90-day window, for the daily refresh. Ninety days of overlap means a
 *    run that fails, or a box that was off for a fortnight, self-heals on the
 *    next successful run instead of leaving a hole nobody notices.
 *  - the full history (1999→today, ~8 MB), fetched ONCE when the store is
 *    empty, so an install can derive a quarter that closed before it existed.
 *
 * Self-host needs no wiring beyond the export in index.ts: cron-host walks the
 * barrel for `onSchedule` exports.
 */

import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore } from "firebase-admin/firestore";
import { parseEurofxrefXml } from "./ecbRates";
import { ecbRateStoreIsEmpty, storeEcbDays } from "./ecbRateStore";

/** Rolling 90-day window — the daily refresh, with overlap to self-heal gaps. */
export const ECB_RECENT_FEED_URL =
  "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";

/** Full daily history since 1999. Seeds an empty store; never scheduled. */
export const ECB_HISTORY_FEED_URL =
  "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml";

export type EcbRefreshWindow = "recent" | "history";

export interface EcbRefreshResult {
  window: EcbRefreshWindow;
  /** Publication days the feed carried. */
  fetched: number;
  /** Month documents written. */
  months: number;
  /** Publication days those documents hold after the write. */
  days: number;
  /** Newest publication date the feed carried; null when it carried none. */
  latest: string | null;
}

export interface RefreshEcbRatesOptions {
  /**
   * Which feed to pull. Omitted, an empty store seeds from the full history
   * and a populated one takes the 90-day window.
   */
  window?: EcbRefreshWindow;
  /** Injection seam for tests; defaults to the platform fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Pull the ECB feed and merge it into the rate store.
 *
 * Takes `db` rather than reaching for the default app, so the scheduled
 * handler and a test exercise the same function.
 */
export async function refreshEcbReferenceRates(
  db: FirebaseFirestore.Firestore,
  options: RefreshEcbRatesOptions = {}
): Promise<EcbRefreshResult> {
  const window =
    options.window ?? ((await ecbRateStoreIsEmpty(db)) ? "history" : "recent");
  const url = window === "history" ? ECB_HISTORY_FEED_URL : ECB_RECENT_FEED_URL;
  const doFetch = options.fetchImpl ?? fetch;

  const response = await doFetch(url);
  if (!response.ok) {
    throw new Error(`[EcbRates] ${url} answered ${response.status}`);
  }

  const days = parseEurofxrefXml(await response.text());
  if (days.length === 0) {
    // A 200 that parses to nothing is a changed feed, not an empty day. Say so
    // loudly instead of writing nothing and reporting success.
    throw new Error(`[EcbRates] ${url} carried no publication days`);
  }

  const { months, days: stored } = await storeEcbDays(db, days);
  const latest = days.reduce<string | null>(
    (newest, day) => (newest === null || day.date > newest ? day.date : newest),
    null
  );

  console.log(
    `[EcbRates] ${window} refresh: ${days.length} publication day(s) from the ` +
    `feed, ${stored} day(s) across ${months} month document(s), newest ${latest}`
  );

  return { window, fetched: days.length, months, days: stored, latest };
}

export const scheduledRefreshEcbRates = onSchedule(
  {
    // The ECB publishes the day's reference rates around 16:00 CET; 17:15
    // Vienna clears that with room, and still lands the same calendar day.
    schedule: "15 17 * * *",
    timeZone: "Europe/Vienna",
    region: "europe-west1",
    memory: "512MiB",
    timeoutSeconds: 540,
  },
  async () => {
    await refreshEcbReferenceRates(getFirestore());
  }
);
