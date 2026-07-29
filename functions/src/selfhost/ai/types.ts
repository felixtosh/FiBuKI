/**
 * The slice of the `@google-cloud/vertexai` surface the application actually
 * uses, which is what the adapter has to reproduce faithfully.
 *
 * Derived by auditing all 13 call sites (extraction/geminiParser,
 * import/matchColumns, matching/*, precision-search/*, ai/*). None of them use
 * responseSchema, systemInstruction, safetySettings, function declarations or
 * chat sessions, so those are deliberately not modelled — adding them later is
 * additive, whereas guessing at them now would be untested surface.
 *
 * Keeping these shapes identical to Vertex AI is what lets every provider be
 * swapped without touching application code.
 */

export interface InlineDataPart {
  inlineData: { data: string; mimeType: string };
}

export interface TextPart {
  text: string;
}

export type Part = TextPart | InlineDataPart;

export interface Content {
  role?: string;
  parts: Part[];
}

export interface GenerateContentRequest {
  contents: Content[];
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    topK?: number;
  };
}

/** Vertex reports token counts here; the billing path reads both fields. */
export interface UsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
}

export interface GenerateContentResponse {
  response: {
    candidates: Array<{ content: { role: string; parts: TextPart[] } }>;
    usageMetadata: UsageMetadata;
  };
}

/** What every concrete provider implements. */
export interface AiProvider {
  readonly name: string;
  generateContent(
    model: string,
    request: GenerateContentRequest
  ): Promise<GenerateContentResponse>;
}

export function isInlineData(part: Part): part is InlineDataPart {
  return (part as InlineDataPart).inlineData !== undefined;
}

/** Wrap provider output back into the Vertex response envelope. */
export function toVertexResponse(
  text: string,
  usage: UsageMetadata
): GenerateContentResponse {
  return {
    response: {
      candidates: [{ content: { role: "model", parts: [{ text }] } }],
      usageMetadata: usage,
    },
  };
}
