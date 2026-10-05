import {
  collection,
  query,
  orderBy,
  where,
  getDocs,
  Timestamp,
  limit,
} from "firebase/firestore";
import {
  AIUsageRecord,
  AIUsageSummary,
  AIUsageDailyStats,
  AIFunction,
} from "@/types/ai-usage";
import { MODEL_PRICING, PRICING_FALLBACK_MODEL } from "@/functions/src/utils/models";
import { OperationsContext } from "./types";

const AI_USAGE_COLLECTION = "aiUsage";

export interface LogAIUsageParams {
  function: AIFunction;
  model: string;
  inputTokens: number;
  outputTokens: number;
  metadata?: AIUsageRecord["metadata"];
}

/**
 * Calculate estimated cost based on model pricing
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING[PRICING_FALLBACK_MODEL];
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

/**
 * List AI usage records with optional date range filter
 */
export async function listAIUsage(
  ctx: OperationsContext,
  options?: {
    dateFrom?: Date;
    dateTo?: Date;
    functionFilter?: AIFunction;
    maxResults?: number;
  }
): Promise<AIUsageRecord[]> {
  let q = query(
    collection(ctx.db, AI_USAGE_COLLECTION),
    where("userId", "==", ctx.userId),
    orderBy("createdAt", "desc")
  );

  if (options?.dateFrom) {
    q = query(q, where("createdAt", ">=", Timestamp.fromDate(options.dateFrom)));
  }

  if (options?.dateTo) {
    q = query(q, where("createdAt", "<=", Timestamp.fromDate(options.dateTo)));
  }

  if (options?.functionFilter) {
    q = query(q, where("function", "==", options.functionFilter));
  }

  if (options?.maxResults) {
    q = query(q, limit(options.maxResults));
  }

  const snapshot = await getDocs(q);
  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as AIUsageRecord[];
}

/**
 * Get usage summary statistics
 */
export async function getAIUsageSummary(
  ctx: OperationsContext,
  options?: {
    dateFrom?: Date;
    dateTo?: Date;
  }
): Promise<AIUsageSummary> {
  const records = await listAIUsage(ctx, { ...options, maxResults: 10000 });

  const summary: AIUsageSummary = {
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
    summary.totalCalls++;
    summary.totalInputTokens += record.inputTokens;
    summary.totalOutputTokens += record.outputTokens;
    summary.totalCost += record.estimatedCost;

    // By function
    const fn = record.function;
    summary.byFunction[fn].calls++;
    summary.byFunction[fn].inputTokens += record.inputTokens;
    summary.byFunction[fn].outputTokens += record.outputTokens;
    summary.byFunction[fn].cost += record.estimatedCost;

    // By model
    if (!summary.byModel[record.model]) {
      summary.byModel[record.model] = { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
    }
    summary.byModel[record.model].calls++;
    summary.byModel[record.model].inputTokens += record.inputTokens;
    summary.byModel[record.model].outputTokens += record.outputTokens;
    summary.byModel[record.model].cost += record.estimatedCost;
  }

  return summary;
}

/**
 * Get daily usage stats for charts
 */
export async function getAIUsageDailyStats(
  ctx: OperationsContext,
  days: number = 30
): Promise<AIUsageDailyStats[]> {
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - days);
  dateFrom.setHours(0, 0, 0, 0);

  const records = await listAIUsage(ctx, { dateFrom, maxResults: 10000 });

  // Group by date
  const dailyMap = new Map<string, AIUsageDailyStats>();

  // Initialize all days (so we have zeros for days with no usage)
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

  // Aggregate records
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

  return Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Get usage by function for pie/bar chart
 */
export async function getAIUsageByFunction(
  ctx: OperationsContext,
  options?: {
    dateFrom?: Date;
    dateTo?: Date;
  }
): Promise<Array<{ function: AIFunction; calls: number; cost: number }>> {
  const summary = await getAIUsageSummary(ctx, options);

  return (Object.entries(summary.byFunction) as [AIFunction, typeof summary.byFunction.chat][])
    .map(([fn, stats]) => ({
      function: fn,
      calls: stats.calls,
      cost: stats.cost,
    }))
    .filter((item) => item.calls > 0)
    .sort((a, b) => b.calls - a.calls);
}
