/**
 * Cloud Function: calculate the UVA report server-side (fork #64, D4).
 *
 * Replaces the browser-side calculateUVAReport: fetches the period's
 * transactions, their connected files (batch, chunked), and the no-receipt
 * categories, adapts them to plain data and runs the pure calculation
 * module. The web UI calls this endpoint instead of computing locally.
 */

import { Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { calculateUva, RECONCILE_TOLERANCE_CENTS } from "../uva/calculateUva";
import { periodBoundaries } from "../uva/rateSet";
import { dayStartUtc, dayEndExclusiveUtc } from "../uva/dateWindow";
import {
  buildUvaTransactions,
  type CategoryRecord,
  type FileRecord,
  type TransactionRecord,
} from "../uva/adapter";
import {
  toLegacyReportData,
  type LegacyUvaReportData,
  type TransactionStats,
} from "../uva/legacyProjection";
import type { UvaPeriod, UvaReportResult } from "../uva/types";

interface CalculateUvaRequest {
  period: UvaPeriod;
}

interface CalculateUvaResponse {
  success: boolean;
  result: UvaReportResult;
  /** Corrected figures projected onto the legacy shape the preview/PDF render. */
  legacy: LegacyUvaReportData;
}

/** Firestore getAll takes at most this many refs per call comfortably. */
const FETCH_CHUNK = 100;

export const calculateUvaCallable = createCallable<
  CalculateUvaRequest,
  CalculateUvaResponse
>(
  { name: "calculateUva", memory: "512MiB", timeoutSeconds: 120 },
  async (ctx, request) => {
    const { period } = request;
    if (
      !period ||
      typeof period.year !== "number" ||
      typeof period.period !== "number" ||
      !["monthly", "quarterly"].includes(period.type)
    ) {
      throw new HttpsError("invalid-argument", "A valid period is required");
    }

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

    const txSnapshot = await ctx.db
      .collection("transactions")
      .where("userId", "==", ctx.userId)
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

    const filesById = new Map<string, FileRecord>();
    for (const chunk of chunked([...fileIds], FETCH_CHUNK)) {
      const refs = chunk.map((id) => ctx.db.collection("files").doc(id));
      const docs = await ctx.db.getAll(...refs);
      for (const doc of docs) {
        const data = doc.data();
        if (doc.exists && data?.userId === ctx.userId) {
          filesById.set(doc.id, { ...data, id: doc.id } as FileRecord);
        }
      }
    }

    const categoriesById = new Map<string, CategoryRecord>();
    for (const chunk of chunked([...categoryIds], FETCH_CHUNK)) {
      const refs = chunk.map((id) =>
        ctx.db.collection("noReceiptCategories").doc(id)
      );
      const docs = await ctx.db.getAll(...refs);
      for (const doc of docs) {
        const data = doc.data();
        if (doc.exists && data?.userId === ctx.userId) {
          categoriesById.set(doc.id, { ...data, id: doc.id } as CategoryRecord);
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
        const total = filesById.get(fid)?.extractedAmount;
        if (
          total &&
          Math.abs(tx.amount) + RECONCILE_TOLERANCE_CENTS < total
        ) {
          partialFileIds.add(fid);
        }
      }
    }
    for (const fid of partialFileIds) {
      const total = filesById.get(fid)?.extractedAmount;
      if (!total) continue;
      const priorSnapshot = await ctx.db
        .collection("transactions")
        .where("userId", "==", ctx.userId)
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

    const result = calculateUva({
      period,
      transactions: buildUvaTransactions(txRecords, {
        filesById,
        categoriesById,
        priorClaimedFractionByFileId,
      }),
    });

    const stats: TransactionStats = {
      total: txRecords.length,
      income,
      expense,
      complete,
      incomplete: txRecords.length - complete,
    };

    return {
      success: true,
      result,
      legacy: toLegacyReportData(result, stats),
    };
  }
);

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
