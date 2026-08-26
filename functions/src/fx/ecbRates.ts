/**
 * ECB euro foreign-exchange reference rates (#92).
 *
 * § 20 Abs 6 UStG 1994 names three ways to bring a foreign-currency amount
 * into EUR, and the second one is a rate somebody else publishes:
 *
 *   "Der Unternehmer kann stattdessen auch den letzten, von der Europäischen
 *    Zentralbank veröffentlichten, Umrechnungskurs anwenden."
 *
 * That is what this module holds. It is deliberately NOT a table of monthly
 * averages: the BMF Durchschnittskurs (method 1) is published as a Findok
 * Kundmachung PDF per Stichtag with no machine-readable feed, whereas the ECB
 * publishes `eurofxref` as XML with the full daily history — so method 2 is
 * the one a program can actually get right, and the statute permits it in its
 * own right.
 *
 * Two properties the statute hands us for free:
 *
 *  - "der LETZTE veröffentlichte Kurs" means a Saturday payment legitimately
 *    uses Friday's rate. The ECB publishes on TARGET business days only, so
 *    that is the normal case, not an edge case.
 *  - the rates are quoted as foreign units per 1 EUR, so EUR is always
 *    present with the value 1 and never needs a row.
 *
 * The lookback is bounded anyway (MAX_ECB_LOOKBACK_DAYS). An unbounded "last
 * published" over a table that has stopped refreshing is the failure the web
 * converter was fixed for in #111: every later date silently priced at the
 * final row and rendered identically to a correct figure. Past the bound the
 * answer is null, which is what puts the document back on the effective bank
 * rate rather than on a rate from an unrelated month.
 *
 * Pure and dependency-free: the store (ecbRateStore.ts) and the refresh job
 * (refreshEcbRates.ts) are separate so the UVA derivation can take a table as
 * plain data.
 */

import { normalizeCurrencyForDisplay } from "./currencyNormalization";

/** One ECB publication day: foreign-currency units per 1 EUR. */
export interface EcbDay {
  /** TARGET publication date, YYYY-MM-DD. */
  date: string;
  /** ISO code → units of that currency per 1 EUR. EUR itself is implicit. */
  rates: Record<string, number>;
}

/**
 * A set of publication days. `days` is sorted ascending by date and holds one
 * entry per date — an invariant established by `buildEcbRateTable`, which is
 * the only thing that should construct one.
 */
export interface EcbRateTable {
  days: EcbDay[];
}

/**
 * How far back "the last published rate" may reach. Four days covers the
 * longest ordinary TARGET closure (Good Friday to Easter Monday); seven leaves
 * room for the Christmas/New Year cluster without letting a table that stopped
 * refreshing price a payment at a rate from another month.
 */
export const MAX_ECB_LOOKBACK_DAYS = 7;

/** A rate and the publication day it came from. */
export interface EcbRateHit {
  /** Units of the target currency per unit of the source currency. */
  rate: number;
  /** The ECB publication date the rate was read from, YYYY-MM-DD. */
  rateDate: string;
}

export const EMPTY_ECB_RATE_TABLE: EcbRateTable = { days: [] };

/**
 * Normalize, sort and deduplicate publication days into a lookup table.
 * A later entry for the same date wins, so a refresh that re-fetches an
 * overlapping window corrects a day rather than duplicating it.
 */
export function buildEcbRateTable(days: EcbDay[]): EcbRateTable {
  const byDate = new Map<string, EcbDay>();
  for (const day of days) {
    if (!isIsoDate(day.date)) continue;
    const rates: Record<string, number> = {};
    for (const [code, value] of Object.entries(day.rates ?? {})) {
      const currency = normalizeCurrencyForDisplay(code);
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        rates[currency] = value;
      }
    }
    if (Object.keys(rates).length > 0) byDate.set(day.date, { date: day.date, rates });
  }
  return { days: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

/**
 * The last day published on or before `date`, within the lookback bound.
 * Null when the table does not reach that far — never the nearest row.
 */
export function lastPublishedOnOrBefore(
  table: EcbRateTable,
  date: string
): EcbDay | null {
  if (!isIsoDate(date)) return null;
  let hit: EcbDay | null = null;
  for (const day of table.days) {
    if (day.date > date) break;
    hit = day;
  }
  if (!hit) return null;
  return daysBetween(hit.date, date) <= MAX_ECB_LOOKBACK_DAYS ? hit : null;
}

/**
 * Units of `to` per one unit of `from` on the last day published on or before
 * `date`. Both legs are read from the SAME publication day — a cross rate
 * assembled from two days is not a rate the ECB ever published.
 *
 * A missing currency is read as EUR, matching fxPlausibility: on an Austrian
 * instance an amount with no currency is EUR, and EUR is the quote unit.
 */
export function ecbCrossRate(
  table: EcbRateTable,
  from: string | null | undefined,
  to: string | null | undefined,
  date: string
): EcbRateHit | null {
  const source = normalizeCurrencyForDisplay(from);
  const target = normalizeCurrencyForDisplay(to);
  if (source === target) return null;

  const day = lastPublishedOnOrBefore(table, date);
  if (!day) return null;

  const perEur = (code: string): number | null =>
    code === "EUR" ? 1 : day.rates[code] ?? null;
  const sourcePerEur = perEur(source);
  const targetPerEur = perEur(target);
  if (!sourcePerEur || !targetPerEur) return null;

  return { rate: targetPerEur / sourcePerEur, rateDate: day.date };
}

/**
 * Parse the ECB `eurofxref` XML feed (daily, 90-day or full history).
 *
 * Shape, fixed since 2002 and identical across the three feeds:
 *
 *   <Cube><Cube time="2026-08-24"><Cube currency="USD" rate="1.1664"/>…
 *
 * Read with regexes rather than an XML parser: the feed is one flat shape from
 * one publisher, and `functions/` carries no XML dependency to spend on it.
 * Anything that does not match — an absent currency, a non-numeric rate — is
 * skipped rather than guessed, so a malformed row costs that row and not the
 * refresh.
 */
export function parseEurofxrefXml(xml: string): EcbDay[] {
  const days: EcbDay[] = [];
  const dayPattern = /<Cube\s+time=["'](\d{4}-\d{2}-\d{2})["']\s*>([\s\S]*?)<\/Cube\s*>/g;
  for (const match of xml.matchAll(dayPattern)) {
    const [, date, body] = match;
    const rates: Record<string, number> = {};
    const ratePattern =
      /<Cube\s+currency=["']([A-Za-z]{3})["']\s+rate=["']([^"']+)["']\s*\/?>/g;
    for (const rateMatch of body.matchAll(ratePattern)) {
      const rate = Number(rateMatch[2]);
      if (Number.isFinite(rate) && rate > 0) rates[rateMatch[1].toUpperCase()] = rate;
    }
    if (Object.keys(rates).length > 0) days.push({ date, rates });
  }
  return days;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Whole days from `earlier` to `later`, both YYYY-MM-DD. */
function daysBetween(earlier: string, later: string): number {
  const a = Date.parse(`${earlier}T00:00:00Z`);
  const b = Date.parse(`${later}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
  return Math.round((b - a) / 86_400_000);
}

/** YYYY-MM-DD shifted by whole days; used to widen a load window. */
export function shiftIsoDate(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) return date;
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}
