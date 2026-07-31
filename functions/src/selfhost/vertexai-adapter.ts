/**
 * Real replacement for `@google-cloud/vertexai` on the self-host stack.
 *
 * Supersedes vertexai-stub.ts, which returned `{}` for every call. That stub was
 * a spike artefact and it failed in the worst possible way in production: the
 * four Gemini-backed features (document extraction, CSV column matching, partner
 * matching, email query generation) silently produced no result, which is
 * indistinguishable from "the model found nothing". Nothing logged, nothing
 * threw.
 *
 * Presents the exact surface the application uses (see ai/types.ts for the
 * audited subset) and routes each call to a configured provider — Gemini by API
 * key, Anthropic, or any OpenAI-compatible endpoint. See ai/config.ts for the
 * routing and key variables.
 *
 * The Firebase build is untouched: it imports the genuine `@google-cloud/vertexai`
 * and keeps using Vertex AI with the ambient service account. This module only
 * exists behind the alias in vitest.selfhost.config.ts.
 */

import { AnthropicProvider } from "./ai/anthropic";
import { GeminiApiProvider } from "./ai/gemini-api";
import { OpenAiCompatibleProvider } from "./ai/openai-compatible";
import { resolveRoute } from "./ai/config";
import type {
  AiProvider,
  GenerateContentRequest,
  GenerateContentResponse,
} from "./ai/types";

// Re-exported constants. Vertex ships these as enums the app imports; the values
// are the wire strings, so plain objects are faithful.
export const SchemaType = {
  STRING: "STRING",
  NUMBER: "NUMBER",
  INTEGER: "INTEGER",
  BOOLEAN: "BOOLEAN",
  ARRAY: "ARRAY",
  OBJECT: "OBJECT",
} as const;

export const HarmCategory = {} as Record<string, string>;
export const HarmBlockThreshold = {} as Record<string, string>;

const providers: Record<string, AiProvider> = {
  gemini: new GeminiApiProvider(),
  anthropic: new AnthropicProvider(),
  "openai-compatible": new OpenAiCompatibleProvider(),
};

class GenerativeModel {
  constructor(private readonly requestedModel: string) {}

  async generateContent(
    request: GenerateContentRequest
  ): Promise<GenerateContentResponse> {
    const route = resolveRoute(this.requestedModel);
    const provider = providers[route.provider];

    if (route.overridden) {
      // Say so once per call. Cost accounting (utils/models.ts MODEL_PRICING) is
      // keyed on the model the call site asked for, so a cross-provider override
      // will price the call at the requested model's rate rather than the one
      // actually billed. Fine when routing like-for-like, misleading otherwise.
      console.warn(
        `selfhost ai: ${this.requestedModel} -> ${route.provider}:${route.model} ` +
          `(aiUsage will still record "${this.requestedModel}")`,
      );
    }

    return provider.generateContent(route.model, request);
  }

  /** Vertex exposes chat sessions; no call site uses one. Fail loudly if that changes. */
  startChat(): never {
    throw new Error(
      "selfhost ai: startChat() is not implemented — no call site used it when " +
        "the adapter was written. Add it to ai/types.ts and each provider.",
    );
  }
}

export class VertexAI {
  /** project/location are Vertex-only and deliberately ignored. */
  constructor(_opts?: unknown) {}

  getGenerativeModel(opts: { model: string }): GenerativeModel {
    if (!opts?.model) {
      throw new Error("selfhost ai: getGenerativeModel requires a model id");
    }
    return new GenerativeModel(opts.model);
  }

  readonly preview = {
    getGenerativeModel: (opts: { model: string }): GenerativeModel =>
      this.getGenerativeModel(opts),
  };
}
