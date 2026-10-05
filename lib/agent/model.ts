/**
 * LLM Model Factory
 *
 * Provides flexible model selection between:
 * - Anthropic Claude (claude-sonnet-4)
 * - Google Gemini, via EITHER Vertex AI (ADC) or the Generative Language API
 *   (plain API key) — see createChatModel for how that is chosen
 *
 * NOTE: Uses dynamic imports to avoid loading API clients at build time.
 * This prevents "API key not found" errors during static site generation.
 */

import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { StructuredToolInterface } from "@langchain/core/tools";
import { MODEL_PRICING, MODELS } from "@/functions/src/utils/models";

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

// Fallback cost per 1M tokens (input/output), only for a model missing from
// MODEL_PRICING.
export const MODEL_COSTS = {
  anthropic: { input: 3, output: 15 },
  gemini: { input: 1.5, output: 7.5 },
} as const;

/** The Gemini API key, when there is one: it selects the Generative Language API. */
function geminiApiKey(): string | undefined {
  return process.env.FIBUKI_GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
}

/**
 * The Gemini model the chat actually runs. With an API key, FIBUKI_CHAT_MODEL
 * overrides the registry id (some registry ids are retired for API-key users);
 * Vertex keeps the registry id.
 */
function geminiChatModelId(): string {
  return geminiApiKey() ? process.env.FIBUKI_CHAT_MODEL || MODEL_IDS.gemini : MODEL_IDS.gemini;
}

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
    // An API key means the Generative Language API, which needs NO Google Cloud
    // credentials. Vertex AI resolves Application Default Credentials, which a
    // deployment outside GCP does not have — it failed here with
    // "Could not load the default credentials" and took every chat turn with it.
    // Same reasoning as functions/src/selfhost/vertexai-adapter.ts: Gemini itself
    // does not require gcloud, only Vertex does.
    const apiKey = geminiApiKey();
    if (apiKey) {
      const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai");
      const model = new ChatGoogleGenerativeAI({
        // The registry ids are Vertex-era and some are retired for new API-key
        // consumers (the API answers 404 "no longer available to new users"), so
        // allow an override without touching the shared registry, which the
        // Firebase build still uses against Vertex.
        model: geminiChatModelId(),
        temperature,
        apiKey,
      });
      return model.bindTools(tools) as unknown as BaseChatModel;
    }

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
  // The sidebar chat runs in the web container, so a self-hoster pointing the
  // API container at a gateway would otherwise still dial api.anthropic.com from
  // here. Same variables, same precedence as functions/src/selfhost/ai/anthropic.ts.
  const anthropicApiUrl =
    process.env.FIBUKI_ANTHROPIC_BASE_URL?.trim() ||
    process.env.ANTHROPIC_BASE_URL?.trim();
  const model = new ChatAnthropic({
    model: MODEL_IDS.anthropic,
    temperature,
    ...(anthropicApiUrl
      ? { anthropicApiUrl: anthropicApiUrl.replace(/\/+$/, "") }
      : {}),
  });
  return model.bindTools(tools) as unknown as BaseChatModel;
}

/**
 * Get the model ID string for logging
 */
export function getModelId(provider: ModelProvider): string {
  return provider === "gemini" ? geminiChatModelId() : MODEL_IDS[provider];
}

/**
 * Calculate estimated cost based on tokens
 */
export function calculateCost(
  provider: ModelProvider,
  inputTokens: number,
  outputTokens: number
): number {
  // Priced at the model that ran, so a FIBUKI_CHAT_MODEL change is billed right.
  const costs = MODEL_PRICING[getModelId(provider)] ?? MODEL_COSTS[provider];
  return (inputTokens * costs.input + outputTokens * costs.output) / 1_000_000;
}
