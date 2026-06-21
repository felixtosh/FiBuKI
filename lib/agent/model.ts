/**
 * LLM Model Factory
 *
 * Provides flexible model selection between:
 * - Anthropic Claude (claude-sonnet-4)
 * - Google Gemini via Vertex AI (gemini-2.5-flash)
 *
 * NOTE: Uses dynamic imports to avoid loading API clients at build time.
 * This prevents "API key not found" errors during static site generation.
 */

import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { StructuredToolInterface } from "@langchain/core/tools";
import { MODELS } from "@/types/ai-usage";

export type ModelProvider = "anthropic" | "gemini";

export interface ModelConfig {
  provider: ModelProvider;
  temperature?: number;
}

// Model identifiers
const MODEL_IDS = {
  anthropic: MODELS.chatAgent,
  gemini: MODELS.geminiFlash,
} as const;

// Vertex AI config - uses same region as Cloud Functions
// Project is determined from ADC/service account credentials
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || "europe-west1";

// Cost per 1M tokens (input/output) for usage tracking
export const MODEL_COSTS = {
  anthropic: { input: 3, output: 15 }, // $3/$15 per 1M
  gemini: { input: 0.30, output: 2.50 }, // $0.30/$2.50 per 1M (Gemini 2.5 Flash pricing)
} as const;

/**
 * Create a chat model with tool support
 *
 * Uses dynamic imports to avoid loading API clients at build time.
 */
export async function createChatModel(
  config: ModelConfig,
  tools: StructuredToolInterface[]
): Promise<BaseChatModel> {
  const { provider, temperature = 0 } = config;

  if (provider === "gemini") {
    const { ChatVertexAI } = await import("@langchain/google-vertexai");
    const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "taxstudio-f12fb";
    const model = new ChatVertexAI({
      model: MODEL_IDS.gemini,
      temperature,
      location: VERTEX_LOCATION,
      authOptions: {
        projectId,
      },
    });
    return model.bindTools(tools) as unknown as BaseChatModel;
  }

  // Default to Anthropic
  const { ChatAnthropic } = await import("@langchain/anthropic");
  const model = new ChatAnthropic({
    model: MODEL_IDS.anthropic,
    temperature,
  });
  return model.bindTools(tools) as unknown as BaseChatModel;
}

/**
 * Get the model ID string for logging
 */
export function getModelId(provider: ModelProvider): string {
  return MODEL_IDS[provider];
}

/**
 * Calculate estimated cost based on tokens
 */
export function calculateCost(
  provider: ModelProvider,
  inputTokens: number,
  outputTokens: number
): number {
  const costs = MODEL_COSTS[provider];
  return (inputTokens * costs.input + outputTokens * costs.output) / 1_000_000;
}
