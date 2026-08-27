/**
 * The two ways a change stream stops without ever failing.
 *
 * A reconnect loop only runs when the previous attempt finishes. A read on a
 * half-open connection, and a fetch whose headers never arrive, finish neither
 * way — no error, no state change, no request in any access log. On the self-host
 * deployment this produced gaps of 3 to 24 minutes with no stream and no attempt
 * to make one, during which every listener polled at full speed.
 *
 * Both waits are bounded now, and both bounds are asserted here by observing that
 * a SECOND connect happens — which is the only thing that actually matters.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { startChangeStream } from "../../../lib/selfhost/change-stream-client";
import { registerPoller, __resetPokeWindow } from "../../../lib/selfhost/poll-bus";

const stops: Array<() => void> = [];
afterEach(() => {
  while (stops.length) stops.pop()!();
  __resetPokeWindow();
});

/**
 * A stream that emits `chunks` and then stays open forever, saying nothing —
 * the half-open connection, reproduced. `onCancel` fires when the client aborts.
 */
function silentFetch(chunks: string[], onCancel?: () => void) {
  const calls: number[] = [];
  const impl = vi.fn(async (_url: string, init?: RequestInit) => {
    calls.push(Date.now());
    const encoder = new TextEncoder();
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
        // Past the chunks: never enqueue, never close. The read parks.
      },
      cancel() {
        onCancel?.();
      },
    });
    init?.signal?.addEventListener("abort", () => onCancel?.());
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls, raw: impl };
}

describe("change stream watchdog", () => {
  it("reconnects when an open stream goes silent", async () => {
    const { impl, raw } = silentFetch([": connected\n\n"]);

    const client = startChangeStream({
      apiUrl: "http://api.test",
      getToken: () => "tok",
      fetchImpl: impl,
      silenceMs: 120,
      connectTimeoutMs: 5_000,
    });
    stops.push(client.stop);

    // Without the watchdog this stays at 1 forever: the read never resolves, so
    // connectOnce never returns and the backoff ladder is never reached.
    await vi.waitFor(() => expect(raw.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 5000,
    });
  });

  it("treats a heartbeat as proof of life and does NOT reconnect", async () => {
    const encoder = new TextEncoder();
    const impl = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(": connected\n\n"));
          const t = setInterval(() => controller.enqueue(encoder.encode(": ping\n\n")), 40);
          (t as unknown as { unref?: () => void }).unref?.();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const client = startChangeStream({
      apiUrl: "http://api.test",
      getToken: () => "tok",
      fetchImpl: impl as unknown as typeof fetch,
      silenceMs: 150,
      connectTimeoutMs: 5_000,
    });
    stops.push(client.stop);

    await new Promise((r) => setTimeout(r, 600)); // four silence windows' worth
    expect(impl.mock.calls.length).toBe(1);
    expect(client.isOpen()).toBe(true);
  });

  it("abandons a connect whose headers never arrive", async () => {
    let aborted = 0;
    const impl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted++;
            reject(new Error("aborted"));
          });
        }),
    );

    const client = startChangeStream({
      apiUrl: "http://api.test",
      getToken: () => "tok",
      fetchImpl: impl as unknown as typeof fetch,
      silenceMs: 5_000,
      connectTimeoutMs: 100,
    });
    stops.push(client.stop);

    // The hung attempt is abandoned and the ladder runs, so a second one starts.
    await vi.waitFor(() => expect(impl.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 5000,
    });
    expect(aborted).toBeGreaterThanOrEqual(1);
  });

  it("still delivers changes after a watchdog-driven reconnect", async () => {
    const encoder = new TextEncoder();
    let attempt = 0;
    const impl = vi.fn(async () => {
      attempt++;
      const mine = attempt;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(": connected\n\n"));
          // The first stream goes silent; the second one carries a real change.
          if (mine > 1) {
            controller.enqueue(
              encoder.encode('data: {"collection":"transactions","id":"t1","op":"w"}\n\n'),
            );
          }
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const poked = vi.fn();
    const off = registerPoller(poked);
    const client = startChangeStream({
      apiUrl: "http://api.test",
      getToken: () => "tok",
      fetchImpl: impl as unknown as typeof fetch,
      silenceMs: 120,
      connectTimeoutMs: 5_000,
    });
    stops.push(client.stop);

    await vi.waitFor(() => expect(poked).toHaveBeenCalled(), { timeout: 5000 });
    off();
  });
});
