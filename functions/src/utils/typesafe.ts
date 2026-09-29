/**
 * Minimal client for TypeSafe's System One API (Jev).
 *
 * Jev is not a chat model: a request carries `state` (the content) plus a map of
 * typed questions, and the response is a map of typed answers with calibrated
 * confidence. Because the request shape is question-map, not prompt-in/text-out,
 * Jev canNOT be reached through the selfhost prompt-routing layer
 * (selfhost/ai/config.ts) — callsites that want it branch explicitly, switched
 * by their own env var (e.g. FIBUKI_COLUMN_MATCH_PROVIDER).
 *
 * Env:
 *   FIBUKI_TYPESAFE_API_KEY   required to call the hosted API
 *   FIBUKI_TYPESAFE_BASE_URL  optional; full endpoint URL. Lets self-host point
 *                             at an API-compatible local model (e.g. "jeff")
 *                             instead of sending document text to TypeSafe.
 *                             Defaults to the hosted endpoint.
 *
 * Calibration caveat: confidence thresholds tuned against hosted Jev do NOT
 * transfer to a clone behind FIBUKI_TYPESAFE_BASE_URL; thresholds are therefore
 * config at the callsite, never constants.
 */

const DEFAULT_BASE_URL = "https://api.typesafe.ai/v1/systemone";

export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "score"; instructions: string; criteria: string[] };

export type JevAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number };

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function typesafeConfigured(): boolean {
  return Boolean(process.env.FIBUKI_TYPESAFE_API_KEY?.trim());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One System One call. Retries on 429/529 with exponential backoff; any other
 * failure throws so the callsite can fall back or surface it — a silent empty
 * result must never look like "the AI found nothing" (see selfhost/ai/config.ts).
 */
export async function callJev(
  state: unknown,
  questions: Record<string, JevQuestion>,
  opts: { model: string; retries?: number },
): Promise<JevResponse> {
  const apiKey = process.env.FIBUKI_TYPESAFE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("typesafe: FIBUKI_TYPESAFE_API_KEY is required but not set");
  }
  const baseUrl = process.env.FIBUKI_TYPESAFE_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const retries = opts.retries ?? 3;
  const body = JSON.stringify({ state, model: opts.model, questions });

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(baseUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
      });
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.status === 429 || res.status === 529) {
      if (attempt >= retries) {
        throw new Error(`typesafe: throttled (${res.status}) after ${retries} retries`);
      }
      await sleep(500 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`typesafe: HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return JSON.parse(text) as JevResponse;
  }
}
