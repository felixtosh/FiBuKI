"use client";

import { useMemo } from "react";
import {
  Timestamp,
  collection,
  limit,
  orderBy,
  query,
  where,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import {
  FunctionCallRecord,
  FunctionCallSummary,
  FunctionCallDailyStats,
} from "@/types/function-call";
import { useFirestoreCollection } from "@/lib/firebase/use-firestore-collection";
import { useAuth } from "@/components/auth";

const MAX_RECORDS = 500;

function mapFunctionCall(doc: QueryDocumentSnapshot): FunctionCallRecord {
  return { id: doc.id, ...doc.data() } as FunctionCallRecord;
}

export interface FunctionCallStats {
  calls: number;
  successCount: number;
  errorCount: number;
  avgDurationMs: number;
}

export interface FunctionBreakdownItem {
  functionName: string;
  displayName: string;
  calls: number;
  successCount: number;
  errorCount: number;
  avgDurationMs: number;
  errorRate: number;
}

/**
 * Hook to fetch and aggregate function call metrics from the functionCalls collection.
 * Used for both admin (all users) and user (own data) dashboards.
 */
export function useFunctionCalls(options?: {
  dateRange?: "7d" | "30d" | "all";
  allUsers?: boolean;
}) {
  const { userId } = useAuth();
  const allUsers = options?.allUsers ?? false;
  const dateRange = options?.dateRange || "30d";

  const dateFrom = useMemo(() => {
    if (dateRange === "all") return undefined;
    const days = dateRange === "7d" ? 7 : 30;
    const d = new Date();
    d.setDate(d.getDate() - days);
    d.setHours(0, 0, 0, 0);
    return d;
  }, [dateRange]);

  const q = useMemo(() => {
    if (!allUsers && !userId) return null;
    const fromTimestamp = dateFrom ? Timestamp.fromDate(dateFrom) : undefined;

    if (allUsers) {
      return fromTimestamp
        ? query(
            collection(db, "functionCalls"),
            where("createdAt", ">=", fromTimestamp),
            orderBy("createdAt", "desc"),
            limit(MAX_RECORDS),
          )
        : query(
            collection(db, "functionCalls"),
            orderBy("createdAt", "desc"),
            limit(MAX_RECORDS),
          );
    }

    return fromTimestamp
      ? query(
          collection(db, "functionCalls"),
          where("userId", "==", userId),
          where("createdAt", ">=", fromTimestamp),
          orderBy("createdAt", "desc"),
          limit(MAX_RECORDS),
        )
      : query(
          collection(db, "functionCalls"),
          where("userId", "==", userId),
          orderBy("createdAt", "desc"),
          limit(MAX_RECORDS),
        );
  }, [allUsers, userId, dateFrom]);

  const { data: records, loading, error } = useFirestoreCollection(
    q,
    mapFunctionCall,
  );

  // Calculate summary from records
  const summary: FunctionCallSummary = useMemo(() => {
    const result: FunctionCallSummary = {
      totalCalls: 0,
      successCount: 0,
      errorCount: 0,
      avgDurationMs: 0,
      byFunction: {},
    };

    if (records.length === 0) return result;

    let totalDuration = 0;

    for (const record of records) {
      result.totalCalls++;
      totalDuration += record.durationMs;

      if (record.status === "success") {
        result.successCount++;
      } else {
        result.errorCount++;
      }

      // By function
      const fn = record.functionName;
      if (!result.byFunction[fn]) {
        result.byFunction[fn] = {
          calls: 0,
          successCount: 0,
          errorCount: 0,
          avgDurationMs: 0,
        };
      }

      result.byFunction[fn].calls++;
      if (record.status === "success") {
        result.byFunction[fn].successCount++;
      } else {
        result.byFunction[fn].errorCount++;
      }
      result.byFunction[fn].avgDurationMs += record.durationMs;
    }

    // Calculate averages
    result.avgDurationMs = totalDuration / records.length;

    for (const fn of Object.keys(result.byFunction)) {
      const stats = result.byFunction[fn];
      stats.avgDurationMs = stats.avgDurationMs / stats.calls;
    }

    return result;
  }, [records]);

  // Calculate daily stats for charts
  const dailyStats: FunctionCallDailyStats[] = useMemo(() => {
    const days = dateRange === "7d" ? 7 : 30;
    const dailyMap = new Map<string, FunctionCallDailyStats>();

    // Initialize all days
    for (let i = 0; i <= days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - (days - i));
      const dateStr = d.toISOString().split("T")[0];
      dailyMap.set(dateStr, {
        date: dateStr,
        calls: 0,
        successCount: 0,
        errorCount: 0,
        avgDurationMs: 0,
      });
    }

    // Aggregate records
    const dailyDurations = new Map<string, number[]>();

    for (const record of records) {
      const dateStr = record.createdAt.toDate().toISOString().split("T")[0];
      const day = dailyMap.get(dateStr);
      if (day) {
        day.calls++;
        if (record.status === "success") {
          day.successCount++;
        } else {
          day.errorCount++;
        }

        if (!dailyDurations.has(dateStr)) {
          dailyDurations.set(dateStr, []);
        }
        dailyDurations.get(dateStr)!.push(record.durationMs);
      }
    }

    // Calculate average durations
    for (const [dateStr, durations] of dailyDurations) {
      const day = dailyMap.get(dateStr);
      if (day && durations.length > 0) {
        day.avgDurationMs = durations.reduce((a, b) => a + b, 0) / durations.length;
      }
    }

    return Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [records, dateRange]);

  // Get function breakdown for charts
  const functionBreakdown: FunctionBreakdownItem[] = useMemo(() => {
    return Object.entries(summary.byFunction)
      .map(([fn, stats]) => ({
        functionName: fn,
        displayName: formatFunctionDisplayName(fn),
        calls: stats.calls,
        successCount: stats.successCount,
        errorCount: stats.errorCount,
        avgDurationMs: stats.avgDurationMs,
        errorRate: stats.calls > 0 ? (stats.errorCount / stats.calls) * 100 : 0,
      }))
      .filter((item) => item.calls > 0)
      .sort((a, b) => b.calls - a.calls);
  }, [summary]);

  // Error rate
  const errorRate = useMemo(() => {
    if (summary.totalCalls === 0) return 0;
    return (summary.errorCount / summary.totalCalls) * 100;
  }, [summary]);

  return {
    records,
    summary,
    dailyStats,
    functionBreakdown,
    errorRate,
    loading,
    error,
  };
}

/**
 * Format function name for display
 */
export function formatFunctionDisplayName(functionName: string): string {
  // Map Cloud Function names to human-readable names
  const displayNames: Record<string, string> = {
    // Transaction operations
    updateTransaction: "Update Transaction",
    bulkUpdateTransactions: "Bulk Update Transactions",
    deleteTransactionsBySource: "Delete Transactions by Source",
    // File operations
    createFile: "Create File",
    updateFile: "Update File",
    deleteFile: "Delete File",
    restoreFile: "Restore File",
    markFileAsNotInvoice: "Mark as Not Invoice",
    unmarkFileAsNotInvoice: "Unmark as Not Invoice",
    connectFileToTransaction: "Connect File",
    disconnectFileFromTransaction: "Disconnect File",
    dismissTransactionSuggestion: "Dismiss Suggestion",
    unrejectFileFromTransaction: "Unreject File",
    // Partner operations
    createUserPartner: "Create Partner",
    updateUserPartner: "Update Partner",
    deleteUserPartner: "Delete Partner",
    assignPartnerToTransaction: "Assign Partner",
    removePartnerFromTransaction: "Remove Partner",
    // Source operations
    createSource: "Create Source",
    updateSource: "Update Source",
    deleteSource: "Delete Source",
    // Import operations
    bulkCreateTransactions: "Import Transactions",
    createImportRecord: "Create Import Record",
    // AI/Search operations
    matchColumns: "Match Columns",
    matchPartners: "Match Partners",
    searchGmailCallable: "Search Gmail",
    generateSearchQueriesCallable: "Generate Queries",
    scoreAttachmentMatchCallable: "Score Attachment",
    findTransactionMatchesForFile: "Find Transaction Matches",
    lookupCompany: "Lookup Company",
    retryFileExtraction: "Retry Extraction",
  };

  return displayNames[functionName] || functionName
    .replace(/Callable$/, "")
    .replace(/([A-Z])/g, " $1")
    .trim();
}

/**
 * Format duration for display
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}
