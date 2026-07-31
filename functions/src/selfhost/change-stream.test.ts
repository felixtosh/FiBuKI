/**
 * The realtime path: a committed write anywhere fans out to connected browsers.
 *
 * Two halves, tested separately because they fail differently:
 *   - notifyChange emits identity-only payloads on the write's own transaction
 *   - the SSE stream authenticates, isolates by tenant, and degrades to nothing
 *     harmful when LISTEN is unavailable
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  notifyChange,
  parseChangeNotification,
  CHANGE_CHANNEL,
} from "./change-notify";
import { createChangeStream, changeStreamAuth } from "./change-stream";

describe("change-notify", () => {
  it("emits an identity-only payload on the caller's transaction", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const exec = async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return undefined;
    };

    await notifyChange(exec, {
      tenant: "t1",
      collection: "transactions",
      id: "tx1",
      op: "w",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("pg_notify");
    expect(calls[0].params?.[0]).toBe(CHANGE_CHANNEL);
    const payload = JSON.parse(calls[0].params?.[1] as string);
    expect(payload).toEqual({
      tenant: "t1",
      collection: "transactions",
      id: "tx1",
      op: "w",
    });
    // The point of identity-only: no document contents can ride along.
    expect(JSON.stringify(payload)).not.toContain("data");
  });

  it("never throws into the write that triggered it", async () => {
    const exploding = async () => {
      throw new Error("notify failed");
    };
    // A failed notification must not roll back a committed write. Realtime is an
    // optimisation over polling; polling still converges.
    await expect(
      notifyChange(exploding, { tenant: "t", collection: "c", id: "i", op: "w" }),
    ).resolves.toBeUndefined();
  });

  it("drops an oversized payload rather than blowing the 8KB NOTIFY limit", async () => {
    const calls: unknown[] = [];
    const exec = async (sql: string) => {
      calls.push(sql);
      return undefined;
    };
    await notifyChange(exec, {
      tenant: "t",
      collection: "c".repeat(8000),
      id: "i",
      op: "w",
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects malformed payloads on parse", () => {
    expect(parseChangeNotification("not json")).toBeNull();
    expect(parseChangeNotification('{"tenant":"t"}')).toBeNull();
    expect(parseChangeNotification('{"tenant":"t","collection":"c","id":"i","op":"x"}')).toBeNull();
    expect(
      parseChangeNotification('{"tenant":"t","collection":"c","id":"i","op":"d"}'),
    ).toEqual({ tenant: "t", collection: "c", id: "i", op: "d" });
  });
});

describe("change-stream over HTTP", () => {
  const GOOD = "tok-good";
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
      // No LISTEN in tests: dispatch is driven directly, which is also the
      // degradation path when the database has no notification support.
      listen: undefined,
    });
    app.use(
      "/__data",
      changeStreamAuth(async (t) => (t === GOOD ? { uid: "u1" } : null)),
      stream.router,
    );
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await stream.close();
    await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
  });

  it("refuses an unauthenticated stream", async () => {
    const res = await fetch(`${base}/__data/stream`);
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it("refuses a bad token", async () => {
    const res = await fetch(`${base}/__data/stream`, {
      headers: { authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it("delivers a change to a subscriber of the same tenant", async () => {
    const ac = new AbortController();
    const res = await fetch(`${base}/__data/stream`, {
      headers: { authorization: `Bearer ${GOOD}` },
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // The stream opens with a comment frame, so the client knows it is live.
    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain(": connected");

    await vi.waitFor(() => expect(stream.subscriberCount()).toBe(1));
    stream.dispatch({ tenant: "tenant-a", collection: "files", id: "f1", op: "w" });

    const frame = decoder.decode((await reader.read()).value);
    expect(frame).toContain("data: ");
    const payload = JSON.parse(frame.replace(/^data: /, "").trim());
    expect(payload).toEqual({ collection: "files", id: "f1", op: "w" });
    // Tenant is NOT echoed to the client: it already knows its own, and sending it
    // would be pure leakage surface.
    expect(payload.tenant).toBeUndefined();

    ac.abort();
    await reader.cancel().catch(() => undefined);
  });

  it("does NOT deliver a change belonging to another tenant", async () => {
    const ac = new AbortController();
    const res = await fetch(`${base}/__data/stream`, {
      headers: { authorization: `Bearer ${GOOD}` },
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ": connected"

    await vi.waitFor(() => expect(stream.subscriberCount()).toBeGreaterThan(0));

    // Wrong tenant first, then a matching one. If isolation leaked, the first
    // frame read would be the foreign change rather than the local one.
    stream.dispatch({ tenant: "tenant-OTHER", collection: "secret", id: "s1", op: "w" });
    stream.dispatch({ tenant: "tenant-a", collection: "mine", id: "m1", op: "w" });

    const frame = decoder.decode((await reader.read()).value);
    expect(frame).toContain("mine");
    expect(frame).not.toContain("secret");

    ac.abort();
    await reader.cancel().catch(() => undefined);
  });
});
