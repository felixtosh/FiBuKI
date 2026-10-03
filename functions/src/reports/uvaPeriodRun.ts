/**
 * Running one UVA period against the corpus (fork #64, D4; lifted for #85).
 *
 * This is the fetch half of `calculateUva`: the period's transactions, their
 * connected files, the no-receipt categories and the instalment history, in
 * the plain shapes the pure module takes. It was inline in
 * calculateUvaCallable until the filing record (#85) needed the same run —
 * and a second copy of the ladder's INPUT is the same defect as a second copy
 * of the ladder: the trace would be tracing a different run than the figures.
 */

import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "../utils/createCallable";
import { calculateUva, RECONCILE_TOLERANCE_CENTS } from "../uva/calculateUva";
import { periodBoundaries } from "../uva/rateSet";
import { dayStartUtc, dayEndExclusiveUtc } from "../uva/dateWindow";
import {
  buildUvaTransactions,
  payableTotalOf,
  type CategoryRecord,
  type FileRecord,
  type PartnerRecord,
  type TransactionRecord,
} from "../uva/adapter";
import { loadEcbRateTable } from "../fx/ecbRateStore";
import { loadCorrections } from "../corrections/loadCorrections";
import type { TransactionStats } from "../uva/legacyProjection";
import type { UvaPeriod, UvaReportResult } from "../uva/types";

/** Firestore getAll takes at most this many refs per call comfortably. */
const FETCH_CHUNK = 100;

/**
 * How far either side of the period a sale's payment is looked for, in months
 * (#565). The ZM counts an EU service by when it was performed, so a service
 * performed in the period and paid outside it still owes a ZM line. A payment
 * further away than this from its service is not looked for.
 */
const ZM_PAYMENT_WINDOW_MONTHS = 12;

function shiftMonths(d: Date, months: number): Date {
  const out = new Date(d.getTime());
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}

export interface UvaPeriodRun {
  result: UvaReportResult;
  stats: TransactionStats;
}

/** Reject a period the boundary math cannot express, before it reaches the DB. */
export function assertValidPeriod(
  period: UvaPeriod | undefined
): asserts period is UvaPeriod {
  if (
    !period ||
    typeof period.year !== "number" ||
    typeof period.period !== "number" ||
    !["monthly", "quarterly"].includes(period.type)
  ) {
    throw new HttpsError("invalid-argument", "A valid period is required");
  }
}

export async function runUvaForPeriod(
  db: FirebaseFirestore.Firestore,
  userId: string,
  period: UvaPeriod | undefined
): Promise<UvaPeriodRun> {
  assertValidPeriod(period);

  const bounds = periodBoundaries(period);
  // Dates are stored as UTC-midnight of the Vienna calendar day, so the
  // period window is a pure-UTC comparison (spec §7 — no host timezone).
  const startDate = dayStartUtc(bounds.start);
  const endExclusiveDate = dayEndExclusiveUtc(bounds.end);
  if (!startDate || !endExclusiveDate) {
    // An out-of-range period number (quarter 5, month 13) reaches this far:
    // periodBoundaries does the month arithmetic without bounding it, and
    // emits a day that does not exist. Answer invalid-argument rather than
    // throwing a TypeError out of the window math.
    throw new HttpsError("invalid-argument", "A valid period is required");
  }
  const start = Timestamp.fromDate(startDate);
  const endExclusive = Timestamp.fromDate(endExclusiveDate);

  const txSnapshot = await db
    .collection("transactions")
    .where("userId", "==", userId)
    .where("date", ">=", start)
    .where("date", "<", endExclusive)
    .orderBy("date", "asc")
    .get();

  const txRecords: TransactionRecord[] = [];
  let income = 0;
  let expense = 0;
  let complete = 0;
  const fileIds = new Set<string>();
  const categoryIds = new Set<string>();
  for (const doc of txSnapshot.docs) {
    const data = doc.data();
    txRecords.push({ ...data, id: doc.id } as TransactionRecord);
    if ((data.amount ?? 0) > 0) income++;
    else expense++;
    if (data.isComplete) complete++;
    for (const id of data.fileIds ?? []) fileIds.add(id);
    if (data.noReceiptCategoryId) categoryIds.add(data.noReceiptCategoryId);
  }

  // Sales paid outside the period, for the ZM's service-date rule (#565). They
  // reach the calculation as candidates only: it filters the UVA itself to the
  // period by bank date, and reads these for the ZM warning alone.
  const offPeriodSales: TransactionRecord[] = [];
  const windows: Array<[Date, Date]> = [
    [shiftMonths(startDate, -ZM_PAYMENT_WINDOW_MONTHS), startDate],
    [endExclusiveDate, shiftMonths(endExclusiveDate, ZM_PAYMENT_WINDOW_MONTHS)],
  ];
  for (const [from, to] of windows) {
    const snap = await db
      .collection("transactions")
      .where("userId", "==", userId)
      .where("date", ">=", Timestamp.fromDate(from))
      .where("date", "<", Timestamp.fromDate(to))
      .get();
    for (const doc of snap.docs) {
      const data = doc.data();
      if (!((data.amount ?? 0) > 0) || !(data.fileIds ?? []).length) continue;
      offPeriodSales.push({ ...data, id: doc.id } as TransactionRecord);
      for (const id of data.fileIds ?? []) fileIds.add(id);
    }
  }

  const filesById = new Map<string, FileRecord>();
  for (const chunk of chunked([...fileIds], FETCH_CHUNK)) {
    const refs = chunk.map((id) => db.collection("files").doc(id));
    const docs = await db.getAll(...refs);
    for (const doc of docs) {
      const data = doc.data();
      if (doc.exists && data?.userId === userId) {
        filesById.set(doc.id, { ...data, id: doc.id } as FileRecord);
      }
    }
  }

  const categoriesById = new Map<string, CategoryRecord>();
  for (const chunk of chunked([...categoryIds], FETCH_CHUNK)) {
    const refs = chunk.map((id) => db.collection("noReceiptCategories").doc(id));
    const docs = await db.getAll(...refs);
    for (const doc of docs) {
      const data = doc.data();
      if (doc.exists && data?.userId === userId) {
        categoriesById.set(doc.id, { ...data, id: doc.id } as CategoryRecord);
      }
    }
  }

  // The customer-country fallback for a sale (#565): the assigned Partner's.
  const partnersById = new Map<string, PartnerRecord>();
  const partnerRefs = new Map<string, "user" | "global">();
  for (const tx of [...txRecords, ...offPeriodSales]) {
    const raw = tx as TransactionRecord & { partnerType?: "user" | "global" | null };
    if (tx.amount > 0 && tx.partnerId) partnerRefs.set(tx.partnerId, raw.partnerType ?? "user");
  }
  for (const type of ["user", "global"] as const) {
    const ids = [...partnerRefs].filter(([, t]) => t === type).map(([id]) => id);
    for (const chunk of chunked(ids, FETCH_CHUNK)) {
      const collection = type === "user" ? "partners" : "globalPartners";
      const docs = await db.getAll(...chunk.map((id) => db.collection(collection).doc(id)));
      for (const doc of docs) {
        const data = doc.data();
        // A user Partner is read only when it is this user's; a global one is
        // shared by design.
        if (!doc.exists || (type === "user" && data?.userId !== userId)) continue;
        partnersById.set(doc.id, { id: doc.id, country: data?.country ?? data?.address?.country ?? null });
      }
    }
  }

  // Instalments (R2/R6): for files a period transaction only partially
  // pays, find earlier-period payments of the same file so the claim is
  // capped at the file's remaining fraction.
  const priorClaimedFractionByFileId = new Map<string, number>();
  const partialFileIds = new Set<string>();
  for (const tx of txRecords) {
    for (const fid of tx.fileIds ?? []) {
      const total = payableTotalOf(filesById.get(fid));
      if (total && Math.abs(tx.amount) + RECONCILE_TOLERANCE_CENTS < total) {
        partialFileIds.add(fid);
      }
    }
  }
  for (const fid of partialFileIds) {
    const total = payableTotalOf(filesById.get(fid));
    if (!total) continue;
    const priorSnapshot = await db
      .collection("transactions")
      .where("userId", "==", userId)
      .where("fileIds", "array-contains", fid)
      .where("date", "<", start)
      .get();
    const paid = priorSnapshot.docs.reduce(
      (s, d) => s + Math.abs(d.data().amount ?? 0),
      0
    );
    if (paid > 0) {
      priorClaimedFractionByFileId.set(fid, Math.min(paid / total, 1));
    }
  }

  // § 20 Abs 6 UStG method 2 (#92): a foreign-currency document is converted
  // at the last ECB rate published on or before its payment date, and falls
  // back to the effective bank rate where the table does not reach. Loaded per
  // run rather than per document — a quarter is four month documents.
  const ecbRates = await loadEcbRateTable(db, bounds.start, bounds.end);

  // Refunds (#564): each one's original, what it claimed, and what earlier
  // refunds already took back, resolved here so the calculation never queries.
  const correctionByTransactionId = await loadCorrections(
    db,
    userId,
    txRecords,
    filesById,
    categoriesById,
    ecbRates
  );

  const result = calculateUva({
    period,
    transactions: buildUvaTransactions([...txRecords, ...offPeriodSales], {
      filesById,
      categoriesById,
      priorClaimedFractionByFileId,
      correctionByTransactionId,
      partnersById,
    }),
    ecbRates,
  });

  return {
    result,
    stats: {
      total: txRecords.length,
      income,
      expense,
      complete,
      incomplete: txRecords.length - complete,
    },
  };
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
