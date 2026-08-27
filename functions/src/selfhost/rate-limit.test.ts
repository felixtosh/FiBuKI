/**
 * The rate limiter's failure mode, not its arithmetic.
 *
 * When it trips, the client sees a failed request and the app renders its generic
 * error state. Two things have to hold for that to be diagnosable: the response
 * must carry the shim's JSON error shape (every client in this repo parses that
 * and otherwise falls back to `statusText`, which is empty over HTTP/2), and the
 * host must say so in its log.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { makeRateLimiter, __resetRateLimitLog } from "./rate-limit";

async function serve(handler: express.RequestHandler): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(handler);
  app.get("/thing", (_req, res) => {
    res.json({ ok: true });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/thing`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

describe("makeRateLimiter", () => {
  const envBefore = process.env.FIBUKI_RATE_LIMIT_MAX;

  beforeEach(() => {
    __resetRateLimitLog();
    delete process.env.FIBUKI_RATE_LIMIT_MAX;
  });

  afterEach(() => {
    if (envBefore === undefined) delete process.env.FIBUKI_RATE_LIMIT_MAX;
    else process.env.FIBUKI_RATE_LIMIT_MAX = envBefore;
    vi.restoreAllMocks();
  });

  it("answers in the JSON error shape the clients parse", async () => {
    const { url, close } = await serve(makeRateLimiter(2, "test"));
    try {
      await fetch(url);
      await fetch(url);
      const res = await fetch(url);

      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("60");
      const body = await res.json();
      expect(body.error.status).toBe("RESOURCE_EXHAUSTED");
      // The message must name the cap — "too many requests" alone leaves the
      // operator with nothing to change.
      expect(body.error.message).toContain("2 per minute");
    } finally {
      await close();
    }
  });

  it("logs the trip once per window, naming the plane and the cap", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { url, close } = await serve(makeRateLimiter(1, "data"));
    try {
      await fetch(url);
      await fetch(url);
      await fetch(url);
      await fetch(url);

      expect(warn).toHaveBeenCalledTimes(1); // three trips, one line
      const line = warn.mock.calls[0][0] as string;
      expect(line).toContain("data plane");
      expect(line).toContain("1/min");
      expect(line).toContain("FIBUKI_RATE_LIMIT_MAX");
    } finally {
      await close();
    }
  });

  it("still serves requests under the cap", async () => {
    const { url, close } = await serve(makeRateLimiter(5, "test"));
    try {
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(res.headers.get("ratelimit-limit")).toBe("5");
    } finally {
      await close();
    }
  });

  it("FIBUKI_RATE_LIMIT_MAX=0 disables limiting entirely", async () => {
    process.env.FIBUKI_RATE_LIMIT_MAX = "0";
    const { url, close } = await serve(makeRateLimiter(1, "test"));
    try {
      for (let i = 0; i < 5; i++) {
        expect((await fetch(url)).status).toBe(200);
      }
    } finally {
      await close();
    }
  });

  it("an unusable FIBUKI_RATE_LIMIT_MAX falls back to the plane default", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.FIBUKI_RATE_LIMIT_MAX = "lots";
    const { url, close } = await serve(makeRateLimiter(3, "test"));
    try {
      expect((await fetch(url)).headers.get("ratelimit-limit")).toBe("3");
      expect(warn).toHaveBeenCalled();
    } finally {
      await close();
    }
  });
});
