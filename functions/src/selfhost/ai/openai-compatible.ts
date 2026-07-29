/**
 * Any OpenAI-compatible /chat/completions endpoint: Ollama, LM Studio, vLLM,
 * OpenRouter, Groq, Together.
 *
 * This is the provider that makes the self-host story honest. Both other
 * providers send invoice content to a third party, which for Austrian tax data is
 * a data-processing decision a self-hoster may simply not be allowed to make.
 * Pointed at a local Ollama, nothing leaves the machine and no API key exists to
 * leak.
 *
 *   FIBUKI_AI_BASE_URL=http://ollama:11434/v1
 *   FIBUKI_AI_PROVIDER=openai-compatible
 *   FIBUKI_AI_API_KEY=            # omit entirely for a local server
 *
 * Caveat worth stating: vision support varies. A text-only local model cannot do
 * document extraction from a PDF, so image and document parts are rejected with a
 * clear error rather than being silently dropped, which would look like a model
 * that read the invoice and found nothing.
 */

import type {
  AiProvider,
  Content,
  GenerateContentRequest,
  GenerateContentResponse,
  Part,
} from "./types";
import { isInlineData, toVertexResponse } from "./types";

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string };
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

function toParts(parts: Part[], model: string): ContentPart[] {
  return parts.map((part) => {
    if (!isInlineData(part)) return { type: "text", text: part.text };

    const { mimeType, data } = part.inlineData;
    if (mimeType === "application/pdf") {
      throw new Error(
        `selfhost ai (openai-compatible): ${model} was sent a PDF, which this ` +
          `API has no equivalent for. Route document extraction at gemini or ` +
          `anthropic — both read PDFs natively — via ` +
          `FIBUKI_AI_ROUTE_<model>, or pre-convert to images.`,
      );
    }
    // Images travel as a data: URI, which is what vision-capable OpenAI-shaped
    // servers accept.
    return {
      type: "image_url",
      image_url: { url: `data:${mimeType};base64,${data}` },
    };
  });
}

function toMessages(
  contents: Content[],
  model: string
): Array<{ role: string; content: ContentPart[] }> {
  const out: Array<{ role: string; content: ContentPart[] }> = [];
  for (const entry of contents) {
    const role = entry.role === "model" ? "assistant" : "user";
    const parts = toParts(entry.parts, model);
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content.push(...parts);
    } else {
      out.push({ role, content: parts });
    }
  }
  return out;
}

export class OpenAiCompatibleProvider implements AiProvider {
  readonly name = "openai-compatible";

  async generateContent(
    model: string,
    request: GenerateContentRequest
  ): Promise<GenerateContentResponse> {
    const base = process.env.FIBUKI_AI_BASE_URL?.trim().replace(/\/+$/, "");
    if (!base) {
      throw new Error(
        `selfhost ai: FIBUKI_AI_BASE_URL is required for provider ` +
          `"openai-compatible" (e.g. http://ollama:11434/v1)`,
      );
    }

    // No key required — a local server typically has none.
    const key = process.env.FIBUKI_AI_API_KEY?.trim();

    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: toMessages(request.contents, model),
        ...(request.generationConfig?.temperature !== undefined
          ? { temperature: request.generationConfig.temperature }
          : {}),
        ...(request.generationConfig?.maxOutputTokens !== undefined
          ? { max_tokens: request.generationConfig.maxOutputTokens }
          : {}),
      }),
    });

    const body = (await res.json().catch(() => ({}))) as ChatCompletionResponse;

    if (!res.ok) {
      const detail = body.error?.message || body.error?.type || "no detail";
      throw new Error(
        `selfhost ai (openai-compatible): ${model} at ${base} returned ` +
          `HTTP ${res.status}: ${detail}`,
      );
    }

    return toVertexResponse(body.choices?.[0]?.message?.content ?? "", {
      promptTokenCount: body.usage?.prompt_tokens ?? 0,
      candidatesTokenCount: body.usage?.completion_tokens ?? 0,
    });
  }
}
