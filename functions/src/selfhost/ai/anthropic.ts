/**
 * Anthropic Messages API, presented behind the Vertex/Gemini request shape.
 *
 * Unlike the Gemini provider this is a real translation, because the wire formats
 * differ in three ways that matter:
 *
 *  - Vertex sends base64 documents as `inlineData: { data, mimeType }`. Anthropic
 *    wants `{ type: "image", source: { type: "base64", media_type, data } }` for
 *    images and `{ type: "document", ... }` for PDFs — a different block type per
 *    media kind, not one generic blob.
 *  - `maxOutputTokens` is optional for Gemini but `max_tokens` is REQUIRED here,
 *    so a default is supplied.
 *  - Token counts come back as `input_tokens` / `output_tokens`.
 *
 * Claude reads PDFs natively, which is what makes it a genuine alternative for
 * document extraction rather than only for text tasks.
 */

import { requireKey } from "./config";
import type {
  AiProvider,
  Content,
  GenerateContentRequest,
  GenerateContentResponse,
  Part,
} from "./types";
import { isInlineData, toVertexResponse } from "./types";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

/** Anthropic requires max_tokens; Gemini treats it as optional. */
const DEFAULT_MAX_TOKENS = 8192;

type Block =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }
  | {
      type: "document";
      source: { type: "base64"; media_type: string; data: string };
    };

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string; type?: string };
  stop_reason?: string;
}

function toBlock(part: Part): Block {
  if (!isInlineData(part)) {
    return { type: "text", text: part.text };
  }
  const { data, mimeType } = part.inlineData;
  // PDFs are "document" blocks; everything else image-like is an "image" block.
  const type = mimeType === "application/pdf" ? "document" : "image";
  return { type, source: { type: "base64", media_type: mimeType, data } };
}

/**
 * Fold Vertex `contents` into Anthropic messages.
 *
 * Vertex uses role "model" where Anthropic uses "assistant", and a missing role
 * means user. Consecutive same-role turns are merged, because Anthropic rejects
 * two adjacent messages with the same role while Vertex tolerates them.
 */
function toMessages(contents: Content[]): Array<{ role: string; content: Block[] }> {
  const out: Array<{ role: string; content: Block[] }> = [];
  for (const entry of contents) {
    const role = entry.role === "model" ? "assistant" : "user";
    const blocks = entry.parts.map(toBlock);
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content.push(...blocks);
    } else {
      out.push({ role, content: blocks });
    }
  }
  return out;
}

export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";

  async generateContent(
    model: string,
    request: GenerateContentRequest
  ): Promise<GenerateContentResponse> {
    const key = process.env.FIBUKI_ANTHROPIC_API_KEY?.trim()
      ? requireKey("FIBUKI_ANTHROPIC_API_KEY", "anthropic")
      : requireKey("ANTHROPIC_API_KEY", "anthropic");

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: request.generationConfig?.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
        ...(request.generationConfig?.temperature !== undefined
          ? { temperature: request.generationConfig.temperature }
          : {}),
        ...(request.generationConfig?.topP !== undefined
          ? { top_p: request.generationConfig.topP }
          : {}),
        messages: toMessages(request.contents),
      }),
    });

    const body = (await res.json().catch(() => ({}))) as AnthropicResponse;

    if (!res.ok) {
      // Status and the API's message only — the request carries invoice content.
      const detail = body.error?.message || body.error?.type || "no detail";
      throw new Error(
        `selfhost ai (anthropic): ${model} returned HTTP ${res.status}: ${detail}`,
      );
    }

    const text = (body.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");

    return toVertexResponse(text, {
      promptTokenCount: body.usage?.input_tokens ?? 0,
      candidatesTokenCount: body.usage?.output_tokens ?? 0,
    });
  }
}
