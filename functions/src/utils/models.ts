/**
 * Centralized AI model registry for Cloud Functions.
 *
 * IMPORTANT: This file is mirrored at `/types/ai-usage.ts` for frontend/API-route
 * consumption. `functions/tsconfig.json` has `rootDir: "src"`, so functions cannot
 * import from `../../types/`. Keep both files in sync when adding/changing models
 * or pricing.
 *
 * To swap a model (e.g. when a Vertex AI model is retired), change the value here
 * in one place. Do NOT inline model IDs at callsites.
 */

export const MODELS = {
  /**
   * Fastest, cheapest Gemini. Use for column matching, simple extraction,
   * pattern learning, query generation, domain/email validation.
   */
  geminiLite: "gemini-2.5-flash-lite",

  /**
   * Larger Gemini. Use for company lookup (web search grounding), file-to-partner
   * matching, and other tasks needing deeper reasoning.
   */
  geminiFlash: "gemini-2.5-flash",

  /** Main chat/agent reasoning model (Anthropic). */
  chatAgent: "claude-sonnet-4-20250514",

  /** Legacy Claude Haiku — used by `claudeParser` extraction path. */
  claudeHaiku: "claude-3-haiku-20240307",
} as const;

export type KnownModel = (typeof MODELS)[keyof typeof MODELS];

/**
 * Pricing per 1M tokens in USD. Used for internal cost tracking and budget accounting.
 * Retired model IDs are kept so historical aiUsage records still cost correctly.
 */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Claude
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4.0 },
  "claude-3-haiku-20240307": { input: 0.25, output: 1.25 },
  // Gemini via Vertex AI
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  // Retired — kept for historical aiUsage record cost lookups
  "gemini-2.0-flash-001": { input: 0.1, output: 0.4 },
  "gemini-2.0-flash-lite-001": { input: 0.075, output: 0.3 },
  "gemini-2.5-flash-preview-05-20": { input: 0.15, output: 0.6 },
};

/** Fallback model used when a usage record's model isn't in the pricing table. */
export const PRICING_FALLBACK_MODEL = "claude-sonnet-4-20250514";
