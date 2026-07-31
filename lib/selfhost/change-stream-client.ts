/**
 * Subscribes to the host's SSE change stream and pokes the matching pollers.
 *
 * This is the half of realtime the write-poke cannot do. poll-bus.ts covers changes
 * THIS tab made; this covers everything else — extraction finishing, a queue worker
 * completing, another session, another replica — because those are notified by
 * Postgres from whichever process actually did the write.
 *
 * ## Why fetch + ReadableStream rather than EventSource
 *
 * EventSource cannot send an `Authorization` header, which would force the token
 * into the query string, where it leaks through `Referer`, proxy logs and browser
 * history. `fetch` streams the same `text/event-stream` body with a proper header,
 * at the cost of parsing frames ourselves — which is a few lines, since the framing
 * is `data: <json>\n\n` and comments start with `:`.
 *
 * ## Failure is not a failure
 *
 * Polling remains the fallback and is still correct on its own, so every error path
 * here degrades to "keep polling" rather than surfacing anything. The stream
 * reconnects with backoff; if it never comes back, the app behaves exactly as it did
 * before this file existed.
 */

import { pokePollers, setStreamHealthy } from "./poll-bus";

/** Reconnect backoff, capped. Jittered to avoid a thundering herd after an outage. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export interface ChangeStreamClientOptions {
  /** Base URL of fibuki-api, no trailing slash. */
  apiUrl: string;
  getToken: () => Promise<string | null> | string | null;
  /** Test seam. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam so reconnect behaviour is assertable without real delays. */
  onStateChange?: (state: "open" | "closed" | "retrying") => void;
}

export interface ChangeStreamClient {
  /** Stop the stream and cancel any pending reconnect. */
  stop(): void;
  /** True while a stream is currently open. */
  isOpen(): boolean;
}

function backoffFor(attempt: number): number {
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  // ±25% jitter: without it, every client that dropped during a restart reconnects
  // in lockstep and rebuilds the same stampede that took the host down.
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

export function startChangeStream(
  options: ChangeStreamClientOptions,
): ChangeStreamClient {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  let stopped = false;
  let open = false;
  let controller: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  function setState(s: "open" | "closed" | "retrying"): void {
    options.onStateChange?.(s);
  }

  async function connectOnce(): Promise<void> {
    const token = await options.getToken();
    if (!token) throw new Error("no token");

    controller = new AbortController();
    const res = await doFetch(`${options.apiUrl}/__data/stream`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);

    open = true;
    attempt = 0; // a successful connect resets the backoff ladder
    // Tell the pollers push is live so they drop to a slow safety net. The moment
    // this flips back the next poll cycle returns to the configured interval.
    setStreamHealthy(true);
    setState("open");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done || stopped) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line. Keep the trailing partial.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const line = frame.trim();
        // ": connected" / ": ping" keepalives — proof of life, nothing to do.
        if (!line || line.startsWith(":")) continue;
        if (!line.startsWith("data:")) continue;
        try {
          const change = JSON.parse(line.slice(5).trim()) as { collection?: string };
          // Poke everything rather than only listeners on `change.collection`.
          // A write frequently cascades (a file connection updates the transaction,
          // a trigger writes a partner), and each poller drops a poke that lands
          // while its own request is in flight, so the cost of over-poking is a
          // bounded refetch and the cost of under-poking is a stale screen.
          if (change) pokePollers();
        } catch {
          /* malformed frame — ignore, the next one will do */
        }
      }
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        await connectOnce();
      } catch {
        /* fall through to backoff; polling is still carrying the app */
      }
      open = false;
      // Back to responsive polling immediately — a dropped stream must not leave
      // the app on a 60s safety net.
      setStreamHealthy(false);
      if (stopped) break;
      setState("retrying");
      const wait = backoffFor(attempt++);
      await new Promise<void>((resolve) => {
        retryTimer = setTimeout(resolve, wait);
      });
    }
    setState("closed");
  }

  void loop();

  return {
    stop() {
      stopped = true;
      setStreamHealthy(false);
      if (retryTimer) clearTimeout(retryTimer);
      controller?.abort();
      open = false;
    },
    isOpen: () => open,
  };
}
