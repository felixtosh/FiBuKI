"use client";

import { useState, useEffect, useMemo } from "react";
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  where,
  limit,
} from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import {
  AIUsageRecord,
  AIFunction,
} from "@/types/ai-usage";
import { USER_TOKEN_RATE_PER_100K_EUR } from "@/types/billing";
import { useAuth } from "@/components/auth";

const MAX_RECORDS = 500; // Fetch more records for historical aggregation

export interface MonthlyUsage {
  month: string; // YYYY-MM format
  monthLabel: string; // "January 2025" format
  tokens: number;
  cost: number;
  calls: number;
}

export interface UserUsageData {
  currentMonth: MonthlyUsage | null;
  monthlyHistory: MonthlyUsage[];
  recentActivity: AIUsageRecord[];
  totalTokens: number;
  totalCost: number;
  loading: boolean;
  error: Error | null;
}

function calculateUserCost(tokens: number): number {
  return (tokens * USER_TOKEN_RATE_PER_100K_EUR) / 100_000;
}

function getMonthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function formatMonthLabel(monthKey: string): string {
  const [year, month] = monthKey.split("-");
  const date = new Date(parseInt(year), parseInt(month) - 1);
  return date.toLocaleDateString("de-DE", { month: "long", year: "numeric" });
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

export function useUserUsage(): UserUsageData {
  const { userId } = useAuth();
  const [records, setRecords] = useState<AIUsageRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Real-time listener for usage records
  useEffect(() => {
    if (!userId) {
      setRecords([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    const q = query(
      collection(db, "aiUsage"),
      where("userId", "==", userId),
      orderBy("createdAt", "desc"),
      limit(MAX_RECORDS)
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const data = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as AIUsageRecord[];

        setRecords(data);
        setLoading(false);
      },
      (err) => {
        console.error("Error fetching user usage:", err);
        setError(err);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [userId]);

  // Aggregate by month
  const { currentMonth, monthlyHistory, totalTokens, totalCost } = useMemo(() => {
    const monthMap = new Map<string, { tokens: number; calls: number }>();
    let total = 0;

    for (const record of records) {
      const tokens = record.inputTokens + record.outputTokens;
      total += tokens;

      const monthKey = getMonthKey(record.createdAt.toDate());
      const existing = monthMap.get(monthKey) || { tokens: 0, calls: 0 };
      monthMap.set(monthKey, {
        tokens: existing.tokens + tokens,
        calls: existing.calls + 1,
      });
    }

    // Convert to sorted array
    const allMonths: MonthlyUsage[] = Array.from(monthMap.entries())
      .map(([month, data]) => ({
        month,
        monthLabel: formatMonthLabel(month),
        tokens: data.tokens,
        cost: calculateUserCost(data.tokens),
        calls: data.calls,
      }))
      .sort((a, b) => b.month.localeCompare(a.month)); // Most recent first

    // Current month
    const currentMonthKey = getMonthKey(new Date());
    const current = allMonths.find((m) => m.month === currentMonthKey) || null;

    // Historical months (excluding current)
    const history = allMonths.filter((m) => m.month !== currentMonthKey);

    return {
      currentMonth: current,
      monthlyHistory: history,
      totalTokens: total,
      totalCost: calculateUserCost(total),
    };
  }, [records]);

  // Recent activity (last 20)
  const recentActivity = useMemo(() => records.slice(0, 20), [records]);

  return {
    currentMonth,
    monthlyHistory,
    recentActivity,
    totalTokens,
    totalCost,
    loading,
    error,
  };
}

export { formatFunctionName };
