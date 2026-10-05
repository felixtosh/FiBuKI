/**
 * The AI model registry: model roles and their pricing, the one copy (#689).
 *
 * Browser-safe and import-free, so the frontend and API routes import it as
 * `@/functions/src/utils/models` and bill against the same table the backend
 * does. Keep it free of `firebase-admin` / `firebase-functions`; the #688 guard
 * fails if browser code reaches either.
 *
 * To swap a model (e.g. when a Vertex AI model is retired), change the value here
 * in one place. Do NOT inline model IDs at callsites.
 */

export const MODELS = {
  /**
   * Fastest, cheapest Gemini. Use for column matching, simple extraction,
   * pattern learning, query generation, domain/email validation.
   *
   * Was gemini-2.5-flash-lite ($0.10/$0.40), which Google has RETIRED for new API
   * consumers — it answers 404 on a current key while Vertex still serves it. So
   * this is a forced move, and every callable successor costs more; 3.1-flash-lite
   * is the cheapest of them and emits no thinking tokens on structured prompts,
   * which is what these tasks want.
   */
  geminiLite: "gemini-3.1-flash-lite",

  /**
   * Larger Gemini. Use for company lookup (web search grounding), file-to-partner
   * matching, and other tasks needing deeper reasoning.
   *
   * Retired the same way. 3.5-flash-lite is priced EXACTLY as the old 2.5-flash
   * ($0.30/$2.50) while being two generations newer, so this swap costs nothing.
   * 3.6-flash is the escalation if matching quality proves worse — 5x input and 3x
   * output — and needs no code change: set
   *   FIBUKI_AI_ROUTE_gemini_3_5_flash_lite=gemini:gemini-3.6-flash
   */
  geminiFlash: "gemini-3.5-flash-lite",

  /** Main chat/agent reasoning model (Anthropic). */
  chatAgent: "claude-sonnet-4-20250514",

  /**
   * TypeSafe Jev, a "System One" decision model: typed Choice/Noul/Score answers
   * with calibrated confidence, text-only, non-generative. Used where the answer
   * set is enumerable (column matching). Opt-in per task via env, e.g.
   * FIBUKI_COLUMN_MATCH_PROVIDER=typesafe; needs FIBUKI_TYPESAFE_API_KEY.
   * Spike results: handoffs/2026-09-27-jev-decision-provider.md.
   */
  jevDecision: "jev-latest",
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
  // No role points here since the legacy vision-claude extraction path was
  // retired (#170); kept so historical aiUsage rows still cost correctly.
  "claude-3-haiku-20240307": { input: 0.25, output: 1.25 },
  // TypeSafe. Launch pricing 2026-09; output tokens are free by design.
  "jev-latest": { input: 0.042, output: 0 },
  // Gemini. Prices are the paid-tier Standard rates from
  // https://ai.google.dev/gemini-api/docs/pricing; output INCLUDES thinking tokens,
  // so a reasoning model bills its scratchpad at the output rate.
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  "gemini-3.5-flash": { input: 1.5, output: 9.0 },
  "gemini-3.6-flash": { input: 1.5, output: 7.5 },
  "gemini-3.8-flash": { input: 1.5, output: 7.5 },
  // Retired — kept for historical aiUsage record cost lookups
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.0-flash-001": { input: 0.1, output: 0.4 },
  "gemini-2.0-flash-lite-001": { input: 0.075, output: 0.3 },
  "gemini-2.5-flash-preview-05-20": { input: 0.15, output: 0.6 },
};

/**
 * The model an unpriced model is billed as: Claude Sonnet ($3/$15), the dearest
 * entry a role points at, so a gap overstates cost rather than hiding it.
 */
export const PRICING_FALLBACK_MODEL = "claude-sonnet-4-20250514";

/**
 * Estimated cost in USD of one model call. The one cost rule every surface uses
 * (callables, the AI usage logger, the chat, the usage summaries): a model
 * missing from MODEL_PRICING costs as PRICING_FALLBACK_MODEL.
 */
export function estimateModelCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING[PRICING_FALLBACK_MODEL];
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}
