/**
 * Reads the body of a failed `fetch` response into something a user can act on.
 *
 * ## Why this is not inline in each client
 *
 * Every shim client (firestore, functions, storage) turned a non-OK response into
 * an error the same way: try `res.json()`, and on failure fall back to
 * `res.statusText`. Both halves of that have a hole:
 *
 *  - `res.statusText` is ALWAYS the empty string over HTTP/2 — the protocol
 *    dropped the reason phrase — so any deployment behind a modern reverse proxy
 *    threw `FirebaseError` with an empty message. The app then rendered "Failed to
 *    load transactions" with a blank line where the reason belongs, and the only
 *    way to learn the status was the browser's network tab.
 *  - A body that is not the shim's JSON error shape was discarded entirely. The
 *    host's rate limiter (express-rate-limit) answers 429 in plain text, so the
 *    one error most likely to hit a busy tab carried the least information.
 *
 * So: read the body ONCE as text, try to parse it as the JSON error shape, and
 * otherwise use the text itself. The returned message is never empty.
 *
 * Imports nothing, so firestore-client and functions-client can both depend on it
 * without creating an edge between them — they alias to different upstream modules
 * at build time and must stay independent. See poll-bus.ts for the same reasoning.
 */

/** Longest body excerpt used as a message; enough for a sentence, not a page. */
const MAX_MESSAGE = 200;

export interface HttpErrorBody {
  /** `error.status` from the shim's JSON error shape; "" when the body had none. */
  statusCode: string;
  /** Human-readable reason. Never empty. */
  message: string;
  /** `error.details` when the body carried it. */
  details?: unknown;
}

export async function readHttpError(res: Response): Promise<HttpErrorBody> {
  let raw = "";
  try {
    raw = await res.text();
  } catch {
    /* body already consumed or the connection died mid-read — status still tells us something */
  }

  let message = "";
  let statusCode = "";
  let details: unknown;

  try {
    const j = JSON.parse(raw);
    if (j?.error?.message) message = String(j.error.message);
    if (j?.error?.status) statusCode = String(j.error.status);
    if (j?.error && "details" in j.error) details = j.error.details;
  } catch {
    // Not JSON. A proxy error page is markup with no sentence worth showing, so
    // only a plain-text body becomes the message.
    const text = raw.trim();
    if (text && !text.startsWith("<")) message = text.slice(0, MAX_MESSAGE);
  }

  // statusText is empty on HTTP/2, so the status code is the last resort.
  if (!message) message = res.statusText || `HTTP ${res.status}`;

  return { statusCode, message, details };
}

/** Same fallback chain for XMLHttpRequest, which has the identical HTTP/2 hole. */
export function readXhrError(xhr: XMLHttpRequest, fallback: string): HttpErrorBody {
  let message = "";
  let statusCode = "";
  try {
    const j = JSON.parse(xhr.responseText);
    if (j?.error?.message) message = String(j.error.message);
    if (j?.error?.status) statusCode = String(j.error.status);
  } catch {
    const text = (xhr.responseText ?? "").trim();
    if (text && !text.startsWith("<")) message = text.slice(0, MAX_MESSAGE);
  }
  if (!message) message = xhr.statusText || (xhr.status ? `HTTP ${xhr.status}` : fallback);
  return { statusCode, message };
}
