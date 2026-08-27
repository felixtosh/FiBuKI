/**
 * Client half of realtime: parse SSE frames, poke the pollers, survive a drop.
 *
 * The frame parser is the part worth pinning — a change can arrive split across TCP
 * reads, and getting that wrong means events are silently lost, which looks exactly
 * like the polling behaviour this replaces.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startChangeStream } from "../../../lib/selfhost/change-stream-client";
import { registerPoller, __pollerCount, __resetPokeWindow } from "../../../lib/selfhost/poll-bus";

/** Build a fetch that streams the given chunks, then optionally stays open. */
function streamingFetch(chunks: string[], opts: { keepOpen?: boolean } = {}) {
  return vi.fn(async () => {
    const encoder = new TextEncoder();
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(encoder.encode(chunks[i++]));
          return;
        }
        if (!opts.keepOpen) controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
}

// Pokes coalesce inside a 400ms window. Clearing it between cases stops one
// case's trailing fan-out from landing on the next case's freshly registered
// poller — which would make "ignores keepalive comments" fail for the wrong reason.
beforeEach(() => __resetPokeWindow());

const stops: Array<() => void> = [];
afterEach(() => {
  while (stops.length) stops.pop()!();
});

describe("change stream client", () => {
  it("pokes pollers when a change frame arrives", async () => {
    const poked = vi.fn();
    const off = registerPoller(poked);

    const client = startChangeStream({
      apiUrl: "http://api.test",
      getToken: () => "tok",
      fetchImpl: streamingFetch([
        ": connected\n\n",
        'data: {"collection":"files","id":"f1","op":"w"}\n\n',
      ], { keepOpen: true }),
    });
    stops.push(client.stop);

    await vi.waitFor(() => expect(poked).toHaveBeenCalled(), { timeout: 2000 });
    off();
  });

  it("reassembles a frame split across reads", async () => {
    const poked = vi.fn();
    const off = registerPoller(poked);

    // The split lands mid-JSON: a naive per-chunk parser drops this event entirely.
    const client = startChangeStream({
      apiUrl: "http://api.test",
      getToken: () => "tok",
      fetchImpl: streamingFetch([
        'data: {"collection":"trans',
        'actions","id":"t1","op":"w"}\n\n',
      ], { keepOpen: true }),
    });
    stops.push(client.stop);

    await vi.waitFor(() => expect(poked).toHaveBeenCalledTimes(1), { timeout: 2000 });
    off();
  });

  it("ignores keepalive comments without poking", async () => {
    const poked = vi.fn();
    const off = registerPoller(poked);

    const client = startChangeStream({
      apiUrl: "http://api.test",
      getToken: () => "tok",
      fetchImpl: streamingFetch([": connected\n\n", ": ping\n\n", ": ping\n\n"], {
        keepOpen: true,
      }),
    });
    stops.push(client.stop);

    // Give it room to misbehave, then assert it did not.
    await new Promise((r) => setTimeout(r, 150));
    expect(poked).not.toHaveBeenCalled();
    off();
  });

  it("does not throw when there is no token, and reports a non-open state", async () => {
    const states: string[] = [];
    const client = startChangeStream({
      apiUrl: "http://api.test",
      getToken: () => null,
      fetchImpl: streamingFetch([]),
      onStateChange: (s) => states.push(s),
    });
    stops.push(client.stop);

    await vi.waitFor(() => expect(states).toContain("retrying"), { timeout: 3000 });
    expect(client.isOpen()).toBe(false);
  });

  it("retries after the stream ends, rather than giving up", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      // Always closes immediately: the client must keep trying, since polling alone
      // is a degraded state we want to climb out of.
      return new Response(new ReadableStream({ start: (c) => c.close() }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const client = startChangeStream({
      apiUrl: "http://api.test",
      getToken: () => "tok",
      fetchImpl,
    });
    stops.push(client.stop);

    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2), { timeout: 5000 });
  });

  it("stop() halts reconnection", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return new Response(new ReadableStream({ start: (c) => c.close() }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const client = startChangeStream({
      apiUrl: "http://api.test",
      getToken: () => "tok",
      fetchImpl,
    });
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(1));
    client.stop();
    const after = calls;
    await new Promise((r) => setTimeout(r, 1500));
    expect(calls).toBe(after);
  });

  it("leaves no pollers registered of its own", () => {
    // The stream pokes existing pollers; it must never register one itself, or a
    // reconnect loop would multiply them.
    const before = __pollerCount();
    const client = startChangeStream({
      apiUrl: "http://api.test",
      getToken: () => "tok",
      fetchImpl: streamingFetch([], { keepOpen: true }),
    });
    stops.push(client.stop);
    expect(__pollerCount()).toBe(before);
  });
});
