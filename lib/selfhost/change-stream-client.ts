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
 *
 * ## Why there is a watchdog
 *
 * A reconnect loop only runs when the previous attempt FINISHES. Two states finish
 * neither way:
 *
 *  - `await reader.read()` on a connection that died without closing — a half-open
 *    TCP, a proxy that dropped the upstream while holding the downstream. The read
 *    never resolves and never rejects, so `connectOnce()` never returns, the loop
 *    never reaches its backoff, and the client sits there indefinitely.
 *  - a `fetch` whose response headers never arrive.
 *
 * Both are silent: no error, no state change, no request in any access log. On the
 * self-host deployment this showed as gaps of 3 to 24 minutes with no stream and no
 * reconnect attempt, during which every `onSnapshot` fell back to full-speed
 * polling — which is how a realtime feature became a request-volume problem.
 *
 * So both waits are bounded. The server heartbeats every 25s (change-stream.ts), so
 * silence past SILENCE_MS means the connection is gone whatever the transport
 * believes; abort it and let the existing backoff ladder do its job.
 */

import { pokePollers, setStreamHealthy } from "./poll-bus";

/** Reconnect backoff, capped. Jittered to avoid a thundering herd after an outage. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** Two missed heartbeats (the server sends one every 25s). */
const SILENCE_MS = 60_000;

/** Headers should arrive in well under this; a longer wait is a dead attempt. */
const CONNECT_TIMEOUT_MS = 15_000;

export interface ChangeStreamClientOptions {
  /** Base URL of fibuki-api, no trailing slash. */
  apiUrl: string;
  getToken: () => Promise<string | null> | string | null;
  /** Test seam. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam so reconnect behaviour is assertable without real delays. */
  onStateChange?: (state: "open" | "closed" | "retrying") => void;
  /**
   * Longest silence tolerated on an open stream before it is treated as dead.
   * The server sends `: ping` every 25s, so the default allows two missed beats.
   * Lowered in tests; there is no reason to change it in an app.
   */
  silenceMs?: number;
  /** Longest wait for response headers before the attempt is abandoned. */
  connectTimeoutMs?: number;
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
    const silenceMs = options.silenceMs ?? SILENCE_MS;
    const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;

    const token = await options.getToken();
    if (!token) throw new Error("no token");

    controller = new AbortController();
    const ac = controller;

    // Bound the wait for headers. Abort rather than race a rejection, so a fetch
    // that would otherwise hang forever also releases its socket.
    let connectTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      connectTimer = null;
      ac.abort();
    }, connectTimeoutMs);

    let res: Response;
    try {
      res = await doFetch(`${options.apiUrl}/__data/stream`, {
        headers: { authorization: `Bearer ${token}` },
        signal: ac.signal,
      });
    } finally {
      if (connectTimer) clearTimeout(connectTimer);
    }
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

    // Anything at all — a change frame, a `: ping`, a partial chunk — is proof the
    // connection is alive. Silence past the threshold is not.
    let lastActivity = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity <= silenceMs) return;
      // Both, deliberately. abort() releases the socket, and cancel() is what
      // actually settles the parked `reader.read()` — a body whose transport has
      // stopped feeding it does not necessarily notice the abort.
      ac.abort();
      void reader.cancel().catch(() => undefined);
    }, Math.max(1_000, Math.round(silenceMs / 4)));

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped) break;
        lastActivity = Date.now();
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
    } finally {
      clearInterval(watchdog);
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
