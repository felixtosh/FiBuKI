/**
 * The change stream as the HOST actually assembles it.
 *
 * change-stream.test.ts mounts the stream router on a bare express app. Production
 * mounts the data plane at /__data first and the stream at the SAME prefix after
 * (host.ts), so a stream request has to fall through the data plane's json parser,
 * rate limiter, auth middleware and route table before it reaches the handler. That
 * composition had no coverage, which made it the first suspect when the deployment
 * stopped receiving pushes — wrongly, as it turns out, so it is pinned here.
 *
 * Also pins the lifecycle logging: a stream that drops and never comes back looks
 * exactly like a stream with nothing to say, and the gap between a close and the
 * next open is the window where every listener falls back to full-speed polling.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createChangeStream, changeStreamAuth } from "./change-stream";
import { createDataPlane } from "./data-plane";

const GOOD = "tok-good";
const verify = async (t: string) => (t === GOOD ? { uid: "u1", token: {} } : null);

describe("change stream behind the data plane (production mount order)", () => {
  let server: http.Server;
  let base: string;
  let stream: ReturnType<typeof createChangeStream>;

  beforeAll(async () => {
    const app = express();
    stream = createChangeStream({
      authOf: (req) => {
        const a = (req as express.Request & { fibukiAuth?: { uid: string } }).fibukiAuth;
        return a ? { uid: a.uid, tenant: "tenant-a" } : null;
      },
      listen: undefined,
    });
    app.use("/__data", createDataPlane(verify));
    app.use("/__data", changeStreamAuth(verify), stream.router);

    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await stream.close();
    await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
  });

  it("opens for an authenticated client even with the data plane in front", async () => {
    const ac = new AbortController();
    const res = await fetch(`${base}/__data/stream`, {
      headers: { authorization: `Bearer ${GOOD}` },
      signal: ac.signal,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(stream.subscriberCount()).toBe(1);
    ac.abort();
    await vi.waitFor(() => expect(stream.subscriberCount()).toBe(0), { timeout: 2000 });
  });

  it("still refuses an unauthenticated client through the same chain", async () => {
    const res = await fetch(`${base}/__data/stream`);
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it("logs an open and a close, with how long the stream lasted", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const ac = new AbortController();

    await fetch(`${base}/__data/stream`, {
      headers: { authorization: `Bearer ${GOOD}` },
      signal: ac.signal,
    });
    await vi.waitFor(() => expect(stream.subscriberCount()).toBe(1), { timeout: 2000 });
    expect(log.mock.calls.some(([l]) => String(l).includes("subscriber opened"))).toBe(true);

    ac.abort();
    await vi.waitFor(
      () => expect(log.mock.calls.some(([l]) => String(l).includes("subscriber closed"))).toBe(true),
      { timeout: 2000 },
    );
    const closeLine = log.mock.calls.map(([l]) => String(l)).find((l) => l.includes("closed"))!;
    expect(closeLine).toMatch(/after \d+s/);
    expect(closeLine).toContain("subscribers=0");

    log.mockRestore();
  });

  it("logs one close per stream, not one per socket event", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const ac = new AbortController();

    await fetch(`${base}/__data/stream`, {
      headers: { authorization: `Bearer ${GOOD}` },
      signal: ac.signal,
    });
    await vi.waitFor(() => expect(stream.subscriberCount()).toBe(1), { timeout: 2000 });
    ac.abort();
    await vi.waitFor(() => expect(stream.subscriberCount()).toBe(0), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 100)); // room for a second event to land

    // An aborted request fires both "close" and "error"; a per-event log would
    // double-count every drop and make the record useless for counting them.
    const closes = log.mock.calls.map(([l]) => String(l)).filter((l) => l.includes("closed"));
    expect(closes).toHaveLength(1);

    log.mockRestore();
  });
});
