import { Timestamp } from "firebase/firestore";

export type AIFunction =
  | "chat"
  | "companyLookup"
  | "companyLookupSearch"
  | "patternLearning"
  | "columnMatching"
  | "extraction"
  | "classification"
  | "domainValidation";

export interface AIUsageRecord {
  id: string;
  userId: string;
  function: AIFunction;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number; // in USD
  createdAt: Timestamp;
  metadata?: {
    partnerId?: string;
    sourceId?: string;
    fileId?: string;
    webSearchUsed?: boolean;
  } | null;
}

export interface AIUsageSummary {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  byFunction: Record<
    AIFunction,
    {
      calls: number;
      inputTokens: number;
      outputTokens: number;
      cost: number;
    }
  >;
  byModel: Record<
    string,
    {
      calls: number;
      inputTokens: number;
      outputTokens: number;
      cost: number;
    }
  >;
}

export interface AIUsageDailyStats {
  date: string; // ISO date string (YYYY-MM-DD)
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

// User billing rate (for monetization display) - $0.35 per 100k tokens
export const USER_TOKEN_RATE_PER_100K = 0.35;
