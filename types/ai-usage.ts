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

/**
 * Centralized AI model registry for frontend / API routes.
 *
 * IMPORTANT: Mirrored at `/functions/src/utils/models.ts`. Functions cannot import
 * from `types/` because `functions/tsconfig.json` has `rootDir: "src"`. Keep both
 * files in sync when adding/changing models or pricing.
 *
 * To swap a model (e.g. when a Vertex AI model is retired), change the value here.
 * Do NOT inline model IDs at callsites.
 */
export const MODELS = {
  /** Fastest, cheapest Gemini. Column matching, simple extraction, query gen, validation. */
  geminiLite: "gemini-2.5-flash-lite",
  /** Larger Gemini. Company lookup, file-to-partner matching, deeper reasoning. */
  geminiFlash: "gemini-2.5-flash",
  /** Main chat/agent reasoning model. */
  chatAgent: "claude-sonnet-4-20250514",
  /** Legacy Claude Haiku — used by `claudeParser` extraction path. */
  claudeHaiku: "claude-3-haiku-20240307",
} as const;

export type KnownModel = (typeof MODELS)[keyof typeof MODELS];

// Pricing per million tokens (USD) - internal costs by model.
// Retired model IDs are kept so historical aiUsage records still cost correctly.
export const AI_MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Claude models
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4.0 },
  "claude-3-haiku-20240307": { input: 0.25, output: 1.25 },
  // Gemini models (via Vertex AI)
  "gemini-2.5-flash-lite": { input: 0.10, output: 0.40 },
  "gemini-2.5-flash": { input: 0.30, output: 2.50 },
  // Retired — kept for historical aiUsage record cost lookups
  "gemini-2.0-flash-001": { input: 0.10, output: 0.40 },
  "gemini-2.0-flash-lite-001": { input: 0.075, output: 0.30 },
  "gemini-2.5-flash-preview-05-20": { input: 0.15, output: 0.60 },
};
