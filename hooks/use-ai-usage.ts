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
  AIUsageRecord,
  AIUsageSummary,
  AIUsageDailyStats,
  AIFunction,
} from "@/types/ai-usage";
import { useFirestoreCollection } from "@/lib/firebase/use-firestore-collection";
import { useAuth } from "@/components/auth";

const MAX_RECORDS = 500;

function mapRecord(doc: QueryDocumentSnapshot): AIUsageRecord {
  return { id: doc.id, ...doc.data() } as AIUsageRecord;
}

export function useAIUsage(options?: {
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
            collection(db, "aiUsage"),
            where("createdAt", ">=", fromTimestamp),
            orderBy("createdAt", "desc"),
            limit(MAX_RECORDS),
          )
        : query(
            collection(db, "aiUsage"),
            orderBy("createdAt", "desc"),
            limit(MAX_RECORDS),
          );
    }

    return fromTimestamp
      ? query(
          collection(db, "aiUsage"),
          where("userId", "==", userId),
          where("createdAt", ">=", fromTimestamp),
          orderBy("createdAt", "desc"),
          limit(MAX_RECORDS),
        )
      : query(
          collection(db, "aiUsage"),
          where("userId", "==", userId),
          orderBy("createdAt", "desc"),
          limit(MAX_RECORDS),
        );
  }, [allUsers, userId, dateFrom]);

  const { data: records, loading, error } = useFirestoreCollection(q, mapRecord);

  const summary: AIUsageSummary = useMemo(() => {
    const result: AIUsageSummary = {
      totalCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      byFunction: {
        chat: { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
        companyLookup: { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
        companyLookupSearch: { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
        patternLearning: { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
        columnMatching: { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
        extraction: { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
        classification: { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
        domainValidation: { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
      },
      byModel: {},
    };

    for (const record of records) {
      result.totalCalls++;
      result.totalInputTokens += record.inputTokens;
      result.totalOutputTokens += record.outputTokens;
      result.totalCost += record.estimatedCost;

      const fn = record.function;
      if (result.byFunction[fn]) {
        result.byFunction[fn].calls++;
        result.byFunction[fn].inputTokens += record.inputTokens;
        result.byFunction[fn].outputTokens += record.outputTokens;
        result.byFunction[fn].cost += record.estimatedCost;
      }

      if (!result.byModel[record.model]) {
        result.byModel[record.model] = {
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
        };
      }
      result.byModel[record.model].calls++;
      result.byModel[record.model].inputTokens += record.inputTokens;
      result.byModel[record.model].outputTokens += record.outputTokens;
      result.byModel[record.model].cost += record.estimatedCost;
    }

    return result;
  }, [records]);

  const dailyStats: AIUsageDailyStats[] = useMemo(() => {
    const days = dateRange === "7d" ? 7 : 30;
    const dailyMap = new Map<string, AIUsageDailyStats>();

    for (let i = 0; i <= days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - (days - i));
      const dateStr = d.toISOString().split("T")[0];
      dailyMap.set(dateStr, {
        date: dateStr,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
      });
    }

    for (const record of records) {
      const dateStr = record.createdAt.toDate().toISOString().split("T")[0];
      const day = dailyMap.get(dateStr);
      if (day) {
        day.calls++;
        day.inputTokens += record.inputTokens;
        day.outputTokens += record.outputTokens;
        day.cost += record.estimatedCost;
      }
    }

    return Array.from(dailyMap.values()).sort((a, b) =>
      a.date.localeCompare(b.date),
    );
  }, [records, dateRange]);

  const functionBreakdown = useMemo(() => {
    return (
      Object.entries(summary.byFunction) as [
        AIFunction,
        typeof summary.byFunction.chat,
      ][]
    )
      .map(([fn, stats]) => ({
        function: fn,
        name: formatFunctionName(fn),
        calls: stats.calls,
        cost: stats.cost,
      }))
      .filter((item) => item.calls > 0)
      .sort((a, b) => b.calls - a.calls);
  }, [summary]);

  return {
    records,
    summary,
    dailyStats,
    functionBreakdown,
    loading,
    error,
  };
}

function formatFunctionName(fn: AIFunction): string {
  const names: Record<AIFunction, string> = {
    chat: "Chat",
    companyLookup: "Company Lookup",
    companyLookupSearch: "Company Search",
    patternLearning: "Pattern Learning",
    columnMatching: "Column Matching",
    extraction: "File Extraction",
    classification: "Classification",
    domainValidation: "Domain Validation",
  };
  return names[fn] || fn;
}
