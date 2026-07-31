/**
 * Gemini via the Generative Language API — API key, no GCP service account.
 *
 * This is the whole reason a self-host box can still use Gemini: Vertex AI needs
 * ambient Google Cloud credentials, but generativelanguage.googleapis.com takes a
 * plain API key from aistudio.google.com/apikey. The request and response JSON
 * are the same shape Vertex uses, so this provider is close to a pass-through:
 * `contents` / `parts` / `inlineData` go out unchanged and
 * `candidates` / `usageMetadata` come back unchanged.
 */

import { requireKey } from "./config";
import type {
  AiProvider,
  GenerateContentRequest,
  GenerateContentResponse,
} from "./types";
import { toVertexResponse } from "./types";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiApiResponse {
  candidates?: Array<{
    content?: { role?: string; parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

export class GeminiApiProvider implements AiProvider {
  readonly name = "gemini";

  async generateContent(
    model: string,
    request: GenerateContentRequest
  ): Promise<GenerateContentResponse> {
    const key = requireKey("FIBUKI_GEMINI_API_KEY", "gemini");

    // Key travels as a header, not a query parameter, so it cannot end up in an
    // intermediary's request log.
    const res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify({
        contents: request.contents,
        ...(request.generationConfig
          ? { generationConfig: request.generationConfig }
          : {}),
      }),
    });

    const body = (await res.json().catch(() => ({}))) as GeminiApiResponse;

    if (!res.ok) {
      // Surface status and the API's own message, never the request body — that
      // contains customer invoice content.
      const detail = body.error?.message || body.error?.status || "no detail";
      throw new Error(
        `selfhost ai (gemini): ${model} returned HTTP ${res.status}: ${detail}`,
      );
    }

    // A safety block yields 200 with no candidates. Vertex behaves the same way,
    // and callers already treat empty text as "no result", so mirror it rather
        // than throwing — but say so in the log, since it is not the same as an
    // empty answer.
    if (body.promptFeedback?.blockReason) {
      console.warn(
        `selfhost ai (gemini): ${model} blocked the prompt ` +
          `(${body.promptFeedback.blockReason})`,
      );
    }

    const text = body.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    return toVertexResponse(text, {
      promptTokenCount: body.usageMetadata?.promptTokenCount ?? 0,
      candidatesTokenCount: body.usageMetadata?.candidatesTokenCount ?? 0,
    });
  }
}
