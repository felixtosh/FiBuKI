/**
 * Which Gemini client the agent builds, and why it matters.
 *
 * The chat agent runs server-side inside fibuki-web. On a non-GCP host it died on
 * every turn with
 *
 *   Could not load the default credentials
 *
 * because the Gemini branch built a ChatVertexAI, and Vertex resolves Google
 * Application Default Credentials that such a host does not have. An API key
 * selects the Generative Language API instead, which needs no gcloud identity.
 *
 * So the claim under test is not "it returns a model" but "given a key it does NOT
 * take the Vertex path, and without one it still does" — the Firebase build depends
 * on the latter and must stay untouched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const vertexCtor = vi.fn();
const genaiCtor = vi.fn();

/** Both clients answer bindTools, which is all createChatModel calls on them. */
function fakeChat(ctor: ReturnType<typeof vi.fn>, tag: string) {
  return class {
    constructor(opts: Record<string, unknown>) {
      ctor(opts);
    }
    bindTools() {
      return { __client: tag };
    }
  };
}

vi.mock("@langchain/google-vertexai", () => ({
  ChatVertexAI: fakeChat(vertexCtor, "vertex"),
}));
vi.mock("@langchain/google-genai", () => ({
  ChatGoogleGenerativeAI: fakeChat(genaiCtor, "genai"),
}));

const SAVED = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ["FIBUKI_GEMINI_API_KEY", "GOOGLE_API_KEY", "FIBUKI_CHAT_MODEL"]) {
    delete process.env[k];
  }
});

afterEach(() => {
  process.env = { ...SAVED };
});

async function build() {
  const { createChatModel } = await import("../../../lib/agent/model");
  return createChatModel({ provider: "gemini" }, []);
}

describe("chat agent Gemini client selection", () => {
  it("uses the API-key client when a key is present, never Vertex", async () => {
    process.env.FIBUKI_GEMINI_API_KEY = "test-key";

    const model = (await build()) as unknown as { __client: string };

    expect(model.__client).toBe("genai");
    // The regression itself: constructing Vertex at all is what triggered the ADC
    // lookup, whether or not the call later succeeded.
    expect(vertexCtor).not.toHaveBeenCalled();
    expect(genaiCtor).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "test-key" }));
  });

  it("honours GOOGLE_API_KEY too, the name the Google SDKs read by convention", async () => {
    process.env.GOOGLE_API_KEY = "conventional-key";
    await build();
    expect(genaiCtor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "conventional-key" }),
    );
    expect(vertexCtor).not.toHaveBeenCalled();
  });

  it("overrides the model id from env, since the registry id is retired for API keys", async () => {
    // types/ai-usage.ts pins "gemini-2.5-flash", which answers 404 for new API-key
    // consumers while still working on Vertex — so the override is the whole reason
    // the key path is usable at all.
    process.env.FIBUKI_GEMINI_API_KEY = "k";
    process.env.FIBUKI_CHAT_MODEL = "gemini-flash-latest";
    await build();
    expect(genaiCtor).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gemini-flash-latest" }),
    );
  });

  it("falls back to the registry id when no override is set", async () => {
    process.env.FIBUKI_GEMINI_API_KEY = "k";
    await build();
    const { model } = genaiCtor.mock.calls[0][0] as { model: string };
    expect(model).toBe("gemini-2.5-flash");
  });

  it("still builds Vertex with no API key — the Firebase build must not change", async () => {
    const model = (await build()) as unknown as { __client: string };

    expect(model.__client).toBe("vertex");
    expect(genaiCtor).not.toHaveBeenCalled();
    expect(vertexCtor).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gemini-2.5-flash" }),
    );
  });
});
