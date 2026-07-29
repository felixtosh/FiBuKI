/**
 * Stub for `@google-cloud/vertexai` in the self-host spike. Gemini paths are
 * out of scope for Gate 3 (production self-host repoints extraction to the
 * Claude parser / local models). Calls return an empty JSON object so
 * AI-optional code paths degrade to "no AI result" instead of crashing.
 */

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

class GenerativeModelStub {
  async generateContent(_req: unknown): Promise<{ response: unknown }> {
    return {
      response: {
        candidates: [{ content: { role: "model", parts: [{ text: "{}" }] } }],
        usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 },
      },
    };
  }
  startChat(): { sendMessage: (m: unknown) => Promise<{ response: unknown }> } {
    return { sendMessage: async () => (await this.generateContent({})) };
  }
}

export class VertexAI {
  constructor(_opts: unknown) {}
  getGenerativeModel(_opts: unknown): GenerativeModelStub {
    return new GenerativeModelStub();
  }
  preview = { getGenerativeModel: (_opts: unknown) => new GenerativeModelStub() };
}
