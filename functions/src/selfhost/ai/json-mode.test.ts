/**
 * #377: the Extraction asks for JSON mode through `responseMimeType`, and each
 * provider with a JSON mode must forward it in its own dialect. A provider that
 * drops it silently puts the Extraction back on the repair path.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAiCompatibleProvider } from "./openai-compatible";
import { GeminiApiProvider } from "./gemini-api";

const REQUEST = {
  contents: [{ role: "user", parts: [{ text: "extract" }] }],
  generationConfig: { responseMimeType: "application/json" as const },
};

function stubFetch(responseBody: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(responseBody), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return () => JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FIBUKI_AI_BASE_URL;
  delete process.env.FIBUKI_GEMINI_API_KEY;
});

describe("JSON mode", () => {
  it("openai-compatible sends response_format json_object", async () => {
    process.env.FIBUKI_AI_BASE_URL = "http://ollama:11434/v1";
    const sentBody = stubFetch({ choices: [{ message: { content: "{}" } }] });

    await new OpenAiCompatibleProvider().generateContent("llama", REQUEST);

    expect(sentBody().response_format).toEqual({ type: "json_object" });
  });

  it("openai-compatible sends no response_format when JSON mode is not asked for", async () => {
    process.env.FIBUKI_AI_BASE_URL = "http://ollama:11434/v1";
    const sentBody = stubFetch({ choices: [{ message: { content: "hi" } }] });

    await new OpenAiCompatibleProvider().generateContent("llama", { contents: REQUEST.contents });

    expect(sentBody().response_format).toBeUndefined();
  });

  it("gemini forwards responseMimeType in generationConfig", async () => {
    process.env.FIBUKI_GEMINI_API_KEY = "k";
    const sentBody = stubFetch({ candidates: [{ content: { parts: [{ text: "{}" }] } }] });

    await new GeminiApiProvider().generateContent("gemini-3.1-flash-lite", REQUEST);

    expect(sentBody().generationConfig.responseMimeType).toBe("application/json");
  });
});
