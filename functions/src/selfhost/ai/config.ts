/**
 * AI provider routing for the self-host stack.
 *
 * The Firebase build talks to Gemini through Vertex AI, which authenticates with
 * the ambient GCP service account. A self-host box has no service account and
 * should not be given one, so `@google-cloud/vertexai` is aliased to
 * ../vertexai-adapter.ts (see vitest.selfhost.config.ts) and calls are routed
 * here instead.
 *
 * Gemini itself does NOT require gcloud: the Generative Language API accepts a
 * plain API key and speaks the same request/response JSON as Vertex AI. So the
 * default route is Gemini-by-API-key, and other providers are opt-in.
 *
 * ## Routing
 *
 * Call sites never inline model ids — they use the central registry in
 * utils/models.ts (`MODELS.geminiLite` for column matching, extraction, pattern
 * learning; `MODELS.geminiFlash` for company lookup and partner matching). Those
 * roles already split by task, so routing on the requested model id gives
 * per-task provider choice without touching a single call site.
 *
 *   FIBUKI_AI_PROVIDER              default provider for every model
 *                                   gemini | anthropic | openai-compatible
 *   FIBUKI_AI_MODEL                 which model that provider should serve with.
 *                                   REQUIRED whenever FIBUKI_AI_PROVIDER is not
 *                                   "gemini", because call sites ask for Gemini
 *                                   model ids and no other provider knows them.
 *   FIBUKI_AI_ROUTE_<model>         per-model override, "provider" or
 *                                   "provider:model". Dots and dashes in the
 *                                   model id become underscores.
 *
 * Example — extraction on Gemini, the heavier reasoning tasks on Claude:
 *
 *   FIBUKI_AI_PROVIDER=gemini
 *   FIBUKI_AI_ROUTE_gemini_2_5_flash=anthropic:claude-haiku-4-5-20251001
 *
 * ## Keys
 *
 *   FIBUKI_GEMINI_API_KEY           aistudio.google.com/apikey
 *   FIBUKI_ANTHROPIC_API_KEY        falls back to ANTHROPIC_API_KEY
 *   FIBUKI_ANTHROPIC_BASE_URL       anthropic only, falls back to
 *                                   ANTHROPIC_BASE_URL. An ORIGIN to front the
 *                                   API with a gateway; "/v1/messages" is
 *                                   appended. Defaults to api.anthropic.com.
 *   FIBUKI_AI_BASE_URL              openai-compatible only (Ollama, LM Studio,
 *                                   OpenRouter, vLLM). No key needed locally.
 *   FIBUKI_AI_API_KEY               openai-compatible bearer token, if required
 *
 * Keys are read at call time, never logged, and never written to disk.
 *
 * ## Privacy
 *
 * Routing a call to a hosted provider sends document content — invoices, bank
 * narratives — off the box. For an Austrian tax product that is a data-processing
 * decision, not just a config one: you need a DPA with whichever provider you
 * point this at. `openai-compatible` against a local Ollama keeps everything on
 * the machine and is the reason that provider exists.
 */

export type ProviderName = "gemini" | "anthropic" | "openai-compatible";

export interface Route {
  provider: ProviderName;
  /** Model to actually request, which may differ from what the call site asked for. */
  model: string;
  /** True when a FIBUKI_AI_ROUTE_* override redirected this call. */
  overridden: boolean;
}

const PROVIDERS: readonly ProviderName[] = [
  "gemini",
  "anthropic",
  "openai-compatible",
];

function isProvider(v: string): v is ProviderName {
  return (PROVIDERS as readonly string[]).includes(v);
}

/** `gemini-2.5-flash-lite` -> `gemini_2_5_flash_lite`, for env-var naming. */
export function envKeyFor(model: string): string {
  return `FIBUKI_AI_ROUTE_${model.replace(/[.\-]/g, "_")}`;
}

export function defaultProvider(): ProviderName {
  const raw = process.env.FIBUKI_AI_PROVIDER?.trim();
  if (!raw) return "gemini";
  if (!isProvider(raw)) {
    throw new Error(
      `selfhost ai: FIBUKI_AI_PROVIDER="${raw}" is not one of ${PROVIDERS.join(", ")}`,
    );
  }
  return raw;
}

/**
 * Resolve which provider and model should serve a request for `requestedModel`.
 *
 * A per-model override wins over the default provider. `provider:model` retargets
 * the model too; a bare `provider` keeps the requested model id, which is only
 * sensible when the target provider recognises it.
 */
export function resolveRoute(requestedModel: string): Route {
  const override = process.env[envKeyFor(requestedModel)]?.trim();
  if (!override) {
    const provider = defaultProvider();

    // Model ids are provider-specific. Call sites ask for Gemini ids (they come
    // from utils/models.ts), so pointing FIBUKI_AI_PROVIDER at a different
    // provider without also saying which model to use would forward
    // "gemini-2.5-flash-lite" to Anthropic, which 404s on an unknown model — or
    // worse, is accepted and silently mis-billed. Require the mapping.
    if (provider !== "gemini") {
      const fallback = process.env.FIBUKI_AI_MODEL?.trim();
      if (!fallback) {
        throw new Error(
          `selfhost ai: FIBUKI_AI_PROVIDER="${provider}" needs FIBUKI_AI_MODEL ` +
            `to say which of its models serves requests, because call sites ask ` +
            `for Gemini model ids like "${requestedModel}". Set FIBUKI_AI_MODEL, ` +
            `or route per model with ${envKeyFor(requestedModel)}=${provider}:<model>.`,
        );
      }
      return { provider, model: fallback, overridden: true };
    }

    return { provider, model: requestedModel, overridden: false };
  }

  const [rawProvider, ...rest] = override.split(":");
  const provider = rawProvider.trim();
  if (!isProvider(provider)) {
    throw new Error(
      `selfhost ai: ${envKeyFor(requestedModel)}="${override}" names provider ` +
        `"${provider}", which is not one of ${PROVIDERS.join(", ")}`,
    );
  }
  const model = rest.join(":").trim();
  return { provider, model: model || requestedModel, overridden: true };
}

/**
 * Read a required key, failing with a message that names the variable.
 *
 * Deliberately throws rather than degrading. The stub this replaces returned an
 * empty JSON object, so a misconfigured deployment looked exactly like "the AI
 * found nothing" — extraction silently produced no fields and nobody could tell
 * the difference. A loud failure is the correct trade for a core feature.
 */
export function requireKey(name: string, provider: ProviderName): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `selfhost ai: ${name} is required for provider "${provider}" but is not set`,
    );
  }
  return value;
}
