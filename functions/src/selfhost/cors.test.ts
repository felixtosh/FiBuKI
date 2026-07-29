/**
 * Work item 6, slice D — the host CORS layer that lets fibuki-web call
 * fibuki-api from a different origin. Auth is a Bearer token (never a cookie),
 * so the host never sets Access-Control-Allow-Credentials; `"*"` reflects any
 * origin and an allowlist reflects only listed ones. Uses an EMPTY barrel so
 * there is no 287-file boot — CORS is a plain middleware, mounted before every
 * route.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHost } from "./host";

const verifyToken = async () => ({ uid: "u", token: {} });

function listen(app: http.RequestListener): Promise<{ base: string; server: http.Server }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () =>
      resolve({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }),
    );
  });
}

describe("host CORS — allowlist", () => {
  let base: string;
  let server: http.Server;

  beforeAll(async () => {
    const host = createHost({}, { verifyToken, corsOrigins: ["https://web.example"] });
    ({ base, server } = await listen(host.app));
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("preflights an allowed origin: 204 + reflected ACAO + headers", async () => {
    const res = await fetch(`${base}/__data/query`, {
      method: "OPTIONS",
      headers: { origin: "https://web.example", "access-control-request-method": "POST", connection: "close" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://web.example");
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
    // Storage uploads with custom metadata send x-fibuki-custom; must be allowed.
    expect(res.headers.get("access-control-allow-headers")).toContain("x-fibuki-custom");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("does NOT reflect a disallowed origin (browser will block it)", async () => {
    const res = await fetch(`${base}/__data/query`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST", connection: "close" },
    });
    // Preflight is still answered 204, but with no ACAO the browser blocks it.
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    // Vary:Origin is set even when disallowed, so a shared cache can't serve
    // this headerless response to an allowed origin later.
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("reflects the allowed origin on a real (non-preflight) request", async () => {
    const res = await fetch(`${base}/healthz`, { headers: { origin: "https://web.example", connection: "close" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://web.example");
  });
});

describe("host CORS — default wildcard", () => {
  let base: string;
  let server: http.Server;
  const savedEnv = process.env.FIBUKI_WEB_ORIGIN;

  beforeAll(async () => {
    delete process.env.FIBUKI_WEB_ORIGIN; // exercise the built-in "*" default
    const host = createHost({}, { verifyToken });
    ({ base, server } = await listen(host.app));
  });
  afterAll(() => {
    if (savedEnv === undefined) delete process.env.FIBUKI_WEB_ORIGIN;
    else process.env.FIBUKI_WEB_ORIGIN = savedEnv;
    return new Promise<void>((r) => server.close(() => r()));
  });

  it("reflects any origin when unconfigured", async () => {
    const res = await fetch(`${base}/healthz`, { headers: { origin: "http://localhost:3000", connection: "close" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("emits no CORS headers for a same-origin request (no Origin header)", async () => {
    const res = await fetch(`${base}/healthz`, { headers: { connection: "close" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
