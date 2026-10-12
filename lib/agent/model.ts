/**
 * LLM Model Factory for the chat agent and its workers.
 *
 * The deployment picks the provider, never the browser:
 * - FIBUKI_CHAT_PROVIDER=anthropic | gemini | openai, or unset for the default:
 *   Gemini when a Gemini API key is set, else Anthropic when its key is set,
 *   else Gemini on Vertex AI.
 * - "openai" is any OpenAI-compatible endpoint: OpenAI itself, OpenRouter, or a
 *   self-hosted open model behind vLLM, Ollama or LM Studio. It needs
 *   FIBUKI_CHAT_MODEL, and takes FIBUKI_CHAT_BASE_URL and FIBUKI_CHAT_API_KEY
 *   (or OPENAI_API_KEY).
 * - FIBUKI_CHAT_MODEL overrides the model id for Gemini (API key) and OpenAI.
 *
 * NOTE: Uses dynamic imports to avoid loading API clients at build time.
 * This prevents "API key not found" errors during static site generation.
 */

import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { StructuredToolInterface } from "@langchain/core/tools";
import { estimateModelCost, MODELS } from "@/functions/src/utils/models";

export type ModelProvider = "anthropic" | "gemini" | "openai";

export interface ModelConfig {
  provider: ModelProvider;
  temperature?: number;
  /**
   * "none": the tools are bound but may not be called, so the model can only
   * answer in text. A history with tool calls still needs the tools defined
   * (Anthropic refuses it otherwise), so this, not an unbound model, is how
   * the graph's wrap-up stops the tool loop.
   */
  toolChoice?: "none";
}

// Model identifiers
const MODEL_IDS = {
  anthropic: MODELS.chatAgent,
  gemini: MODELS.geminiFlash,
} as const;

// Vertex AI config - uses same region as Cloud Functions
// Project is determined from ADC/service account credentials
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || "europe-west1";
/** The Gemini API key, when there is one: it selects the Generative Language API. */
function geminiApiKey(): string | undefined {
  return process.env.FIBUKI_GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
}

/** The provider this deployment's chat runs on (see the header). */
export function resolveChatProvider(env: NodeJS.ProcessEnv = process.env): ModelProvider {
  const chosen = env.FIBUKI_CHAT_PROVIDER?.trim().toLowerCase();
  if (chosen === "anthropic" || chosen === "gemini" || chosen === "openai") return chosen;
  if (env.FIBUKI_GEMINI_API_KEY || env.GOOGLE_API_KEY) return "gemini";
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  return "gemini";
}

/**
 * The Gemini model the chat actually runs. With an API key, FIBUKI_CHAT_MODEL
 * overrides the registry id (some registry ids are retired for API-key users);
 * Vertex keeps the registry id.
 */
function geminiChatModelId(): string {
  return geminiApiKey() ? process.env.FIBUKI_CHAT_MODEL || MODEL_IDS.gemini : MODEL_IDS.gemini;
}

function openAiChatModelId(): string {
  return process.env.FIBUKI_CHAT_MODEL?.trim() || "";
}

/**
 * Create a chat model with the tools bound.
 *
 * Uses dynamic imports to avoid loading API clients at build time.
 */
export async function createChatModel(
  config: ModelConfig,
  tools: StructuredToolInterface[]
): Promise<BaseChatModel> {
  const { provider, temperature = 0, toolChoice } = config;
  const bind = (model: BaseChatModel) =>
    model.bindTools!(tools, toolChoice ? { tool_choice: toolChoice } : undefined) as unknown as BaseChatModel;

  if (provider === "openai") {
    const model = openAiChatModelId();
    if (!model) throw new Error("FIBUKI_CHAT_PROVIDER=openai needs FIBUKI_CHAT_MODEL");
    const { ChatOpenAI } = await import("@langchain/openai");
    const baseURL = process.env.FIBUKI_CHAT_BASE_URL?.trim().replace(/\/+$/, "");
    return bind(
      new ChatOpenAI({
        model,
        temperature,
        // A local server usually takes any key; the client library insists on one.
        apiKey: process.env.FIBUKI_CHAT_API_KEY || process.env.OPENAI_API_KEY || "not-needed",
        ...(baseURL ? { configuration: { baseURL } } : {}),
      })
    );
  }

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
      // The registry ids are Vertex-era and some are retired for new API-key
      // consumers (the API answers 404 "no longer available to new users"), so
      // allow an override without touching the shared registry, which the
      // Firebase build still uses against Vertex.
      return bind(new ChatGoogleGenerativeAI({ model: geminiChatModelId(), temperature, apiKey }));
    }

    const { ChatVertexAI } = await import("@langchain/google-vertexai");
    const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "taxstudio-f12fb";
    return bind(
      new ChatVertexAI({
        model: MODEL_IDS.gemini,
        temperature,
        location: VERTEX_LOCATION,
        authOptions: {
          projectId,
        },
      })
    );
  }

  // Anthropic
  const { ChatAnthropic } = await import("@langchain/anthropic");
  // The sidebar chat runs in the web container, so a self-hoster pointing the
  // API container at a gateway would otherwise still dial api.anthropic.com from
  // here. Same variables, same precedence as functions/src/selfhost/ai/anthropic.ts.
  const anthropicApiUrl =
    process.env.FIBUKI_ANTHROPIC_BASE_URL?.trim() ||
    process.env.ANTHROPIC_BASE_URL?.trim();
  return bind(
    new ChatAnthropic({
      model: MODEL_IDS.anthropic,
      temperature,
      ...(anthropicApiUrl
        ? { anthropicApiUrl: anthropicApiUrl.replace(/\/+$/, "") }
        : {}),
    })
  );
}

/**
 * Get the model ID string for logging
 */
export function getModelId(provider: ModelProvider): string {
  if (provider === "gemini") return geminiChatModelId();
  if (provider === "openai") return openAiChatModelId();
  return MODEL_IDS.anthropic;
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
  return estimateModelCost(getModelId(provider), inputTokens, outputTokens);
}
