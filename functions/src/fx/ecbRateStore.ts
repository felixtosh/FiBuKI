/**
 * Where the ECB reference rates live between the refresh job and the UVA
 * derivation (#92).
 *
 * One document per CALENDAR MONTH, keyed `YYYY-MM`, holding that month's
 * publication days. A document per day would be the obvious shape and is the
 * wrong one twice over: seeding the full ECB history would write ~7 000
 * documents, and loading a quarter would read ~65. Per month it is ~320 and 4.
 *
 * The month document is rewritten whole rather than merged field-by-field.
 * Firestore's nested-map merge would do it in one write, but the semantics are
 * subtle enough that the read-modify-write is worth the extra read: a refresh
 * always overlaps the months it has already written (the 90-day feed spans
 * four), and "the day I just fetched wins, the days already there survive" is
 * the whole contract.
 *
 * Not user-scoped. A published exchange rate is the same fact for every
 * tenant, and a per-user copy would be a per-user chance to disagree about
 * what the ECB published. The collection is unlisted in firestore.rules and in
 * the self-host data policy, so it is Cloud-Functions-only for reads too — the
 * derivation runs server-side and nothing on the client needs it.
 */

import { Timestamp } from "firebase-admin/firestore";
import {
  MAX_ECB_LOOKBACK_DAYS,
  buildEcbRateTable,
  shiftIsoDate,
  type EcbDay,
  type EcbRateTable,
} from "./ecbRates";

export const ECB_RATES_COLLECTION = "fxReferenceRates";

/** Provenance stamped on every month document — one feed, named on the record. */
export const ECB_RATES_SOURCE = "ecb-eurofxref";

/** Firestore writes per batch. The limit is 500; this leaves headroom. */
const WRITE_CHUNK = 400;

/** Stored shape of one month of publication days. */
export interface EcbRateMonth {
  /** YYYY-MM — also the document id, so a month cannot be stored twice. */
  month: string;
  source: string;
  /** Publication date (YYYY-MM-DD) → currency → units per 1 EUR. */
  days: Record<string, Record<string, number>>;
  updatedAt?: Timestamp;
}

/**
 * The rate table covering a period, widened by the lookback so a payment on
 * the first day of the period can still reach the last rate published before
 * it (a 1 January payment reads the previous 30 December).
 */
export async function loadEcbRateTable(
  db: FirebaseFirestore.Firestore,
  start: string,
  end: string
): Promise<EcbRateTable> {
  const fromMonth = monthOf(shiftIsoDate(start, -MAX_ECB_LOOKBACK_DAYS));
  const toMonth = monthOf(end);

  const snapshot = await db
    .collection(ECB_RATES_COLLECTION)
    .where("month", ">=", fromMonth)
    .where("month", "<=", toMonth)
    .get();

  const days: EcbDay[] = [];
  for (const doc of snapshot.docs) {
    const data = doc.data() as EcbRateMonth | undefined;
    for (const [date, rates] of Object.entries(data?.days ?? {})) {
      days.push({ date, rates });
    }
  }
  return buildEcbRateTable(days);
}

export interface StoreEcbDaysResult {
  /** Month documents written. */
  months: number;
  /** Publication days present in those documents after the write. */
  days: number;
}

/**
 * Merge publication days into their month documents. Days already stored for a
 * month survive; a day present in both is overwritten by the incoming one, so
 * a corrected ECB row propagates on the next refresh.
 */
export async function storeEcbDays(
  db: FirebaseFirestore.Firestore,
  days: EcbDay[]
): Promise<StoreEcbDaysResult> {
  const incoming = new Map<string, Record<string, Record<string, number>>>();
  for (const day of days) {
    const month = monthOf(day.date);
    if (!month) continue;
    const bucket = incoming.get(month) ?? {};
    bucket[day.date] = day.rates;
    incoming.set(month, bucket);
  }
  if (incoming.size === 0) return { months: 0, days: 0 };

  const collection = db.collection(ECB_RATES_COLLECTION);
  const months = [...incoming.keys()].sort();

  // One range query rather than a get per month: seeding the full history
  // touches ~320 months, and the range is contiguous by construction.
  const existing = new Map<string, Record<string, Record<string, number>>>();
  const held = await collection
    .where("month", ">=", months[0])
    .where("month", "<=", months[months.length - 1])
    .get();
  for (const doc of held.docs) {
    const data = doc.data() as EcbRateMonth | undefined;
    if (data?.days) existing.set(doc.id, data.days);
  }

  let stored = 0;
  for (const chunk of chunked(months, WRITE_CHUNK)) {
    const batch = db.batch();
    for (const month of chunk) {
      const merged = { ...(existing.get(month) ?? {}), ...(incoming.get(month) ?? {}) };
      stored += Object.keys(merged).length;
      const doc: EcbRateMonth = {
        month,
        source: ECB_RATES_SOURCE,
        days: merged,
        updatedAt: Timestamp.now(),
      };
      batch.set(collection.doc(month), doc);
    }
    await batch.commit();
  }

  return { months: months.length, days: stored };
}

/** True when nothing has ever been stored — the seed-the-history signal. */
export async function ecbRateStoreIsEmpty(
  db: FirebaseFirestore.Firestore
): Promise<boolean> {
  const snapshot = await db.collection(ECB_RATES_COLLECTION).limit(1).get();
  return snapshot.empty;
}

/** YYYY-MM of a YYYY-MM-DD date; empty string when it is not one. */
function monthOf(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.slice(0, 7) : "";
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
