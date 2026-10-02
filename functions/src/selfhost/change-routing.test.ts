/**
 * Realtime routing (multi-tenant scale): a change is announced to the browsers
 * that may read the document, not to every open stream on the host.
 *
 * Three layers, each pinned here:
 *   - readAudience: the audience is a projection of the read policy, nothing more
 *   - the write path: every write addresses its notification, and a document no
 *     client can read is not announced at all
 *   - the stream: delivery by uid, admins or everyone, tenant isolation intact,
 *     and a notification without an audience (an older process) still reaches all
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

const sent: Array<Record<string, unknown>> = [];
vi.mock("./change-notify", async (importOriginal) => {
  const real = await importOriginal<typeof import("./change-notify")>();
  return {
    ...real,
    notifyChange: async (_exec: unknown, change: Record<string, unknown>) => {
      sent.push(change);
    },
  };
});

import { readAudience } from "./data-policy";
import { audienceWire, parseChangeNotification } from "./change-notify";
import { getFirestore, __resetFirestoreShim } from "./firestore-shim";
import { createChangeStream, changeStreamAuth } from "./change-stream";

describe("readAudience follows the read policy", () => {
  it("owner collections go to the owner, before and after", () => {
    expect(readAudience("files", "f1", [{ userId: "u1" }, undefined])).toEqual({ kind: "users", uids: ["u1"] });
    expect(readAudience("transactions", "t1", [{ userId: "u2" }, { userId: "u1" }])).toEqual({
      kind: "users",
      uids: ["u2", "u1"],
    });
    // No owner anywhere: the owner filter hides it from every client.
    expect(readAudience("files", "f1", [{ name: "x" }, undefined])).toEqual({ kind: "nobody" });
  });

  it("users/{uid} and its subtree go to that uid", () => {
    expect(readAudience("users", "u7", [{}])).toEqual({ kind: "users", uids: ["u7"] });
    expect(readAudience("users/u7/settings", "preferences", [{}])).toEqual({ kind: "users", uids: ["u7"] });
  });

  it("uidKey, admin, authed and denied collections", () => {
    expect(readAudience("subscriptions", "u3", [{}])).toEqual({ kind: "users", uids: ["u3"] });
    expect(readAudience("promotionCandidates", "p", [{}])).toEqual({ kind: "admins" });
    expect(readAudience("globalPartners", "g", [{}])).toEqual({ kind: "everyone" });
    expect(readAudience("emailTokens", "e", [{ userId: "u1" }])).toEqual({ kind: "nobody" });
    expect(readAudience("notAListedCollection", "x", [{ userId: "u1" }])).toEqual({ kind: "nobody" });
  });

  it("round-trips through the wire form", () => {
    expect(audienceWire({ kind: "users", uids: ["u1"] })).toEqual({ u: ["u1"] });
    expect(audienceWire({ kind: "admins" })).toEqual({ a: 1 });
    expect(audienceWire({ kind: "everyone" })).toBeUndefined();
    expect(audienceWire({ kind: "nobody" })).toBeNull();
    const parsed = parseChangeNotification(
      JSON.stringify({ tenant: "t", collection: "files", id: "f", op: "w", to: { u: ["u1"] } }),
    );
    expect(parsed?.to).toEqual({ u: ["u1"] });
    // A malformed audience falls back to everyone, never to nobody.
    const bad = parseChangeNotification(
      JSON.stringify({ tenant: "t", collection: "files", id: "f", op: "w", to: { u: [1] } }),
    );
    expect(bad?.to).toBeUndefined();
  });
});

describe("the write path addresses every notification", () => {
  beforeEach(async () => {
    await __resetFirestoreShim();
    sent.length = 0;
  });

  it("an owned document is announced to its owner, and to the old owner when it changes hands", async () => {
    const db = getFirestore();
    await db.doc("files/f1").set({ userId: "u1", name: "a" });
    expect(sent.at(-1)).toMatchObject({ collection: "files", id: "f1", op: "w", to: { u: ["u1"] } });

    await db.doc("files/f1").set({ userId: "u2", name: "a" });
    expect(sent.at(-1)).toMatchObject({ to: { u: ["u2", "u1"] } });

    await db.doc("files/f1").delete();
    expect(sent.at(-1)).toMatchObject({ op: "d", to: { u: ["u2"] } });
  });

  it("a document no client can read is not announced", async () => {
    await getFirestore().doc("emailTokens/e1").set({ userId: "u1", token: "secret" });
    expect(sent).toHaveLength(0);
  });

  it("a tenant-wide document carries no audience, which means everyone", async () => {
    await getFirestore().doc("globalPartners/g1").set({ name: "REWE" });
    expect(sent.at(-1)).toMatchObject({ collection: "globalPartners", id: "g1" });
    expect(sent.at(-1)?.to).toBeUndefined();
  });
});

describe("the stream delivers by audience", () => {
  let server: http.Server;
  let base: string;
  let stream: ReturnType<typeof createChangeStream>;
  const TOKENS: Record<string, { uid: string; token?: Record<string, unknown> }> = {
    "tok-u1": { uid: "u1" },
    "tok-u2": { uid: "u2" },
    "tok-admin": { uid: "a1", token: { admin: true } },
  };

  beforeAll(async () => {
    const app = express();
    stream = createChangeStream({
      authOf: (req) => {
        const a = (req as express.Request & { fibukiAuth?: { uid: string; token?: Record<string, unknown> } })
          .fibukiAuth;
        return a ? { uid: a.uid, tenant: "tenant-a", admin: a.token?.admin === true } : null;
      },
      listen: undefined,
    });
    app.use("/__data", changeStreamAuth(async (t) => TOKENS[t] ?? null), stream.router);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await stream.close();
    await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
  });

  async function open(token: string) {
    const ac = new AbortController();
    const res = await fetch(`${base}/__data/stream`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ": connected"
    let buffer = "";
    return {
      /** The ids of every data frame received until `until` arrives. */
      async idsUntil(until: string): Promise<string[]> {
        const ids: string[] = [];
        for (;;) {
          while (!buffer.includes("\n\n")) buffer += decoder.decode((await reader.read()).value);
          const cut = buffer.indexOf("\n\n");
          const frame = buffer.slice(0, cut).trim();
          buffer = buffer.slice(cut + 2);
          if (!frame.startsWith("data:")) continue;
          const id = JSON.parse(frame.slice(5)).id as string;
          if (id === until) return ids;
          ids.push(id);
        }
      },
      close() {
        ac.abort();
        void reader.cancel().catch(() => undefined);
      },
    };
  }

  it("routes to the owner, to admins, or to everyone, and never across tenants", async () => {
    const u1 = await open("tok-u1");
    const u2 = await open("tok-u2");
    const admin = await open("tok-admin");
    await vi.waitFor(() => expect(stream.subscriberCount()).toBe(3));

    stream.dispatch({ tenant: "tenant-a", collection: "files", id: "for-u1", op: "w", to: { u: ["u1"] } });
    stream.dispatch({ tenant: "tenant-a", collection: "files", id: "for-both", op: "w", to: { u: ["u1", "u2"] } });
    stream.dispatch({ tenant: "tenant-a", collection: "promotionCandidates", id: "for-admins", op: "w", to: { a: 1 } });
    stream.dispatch({ tenant: "tenant-b", collection: "files", id: "other-tenant", op: "w", to: { u: ["u1"] } });
    // No audience: an older process. Everyone in the tenant, as before routing.
    stream.dispatch({ tenant: "tenant-a", collection: "globalPartners", id: "end", op: "w" });

    expect(await u1.idsUntil("end")).toEqual(["for-u1", "for-both"]);
    expect(await u2.idsUntil("end")).toEqual(["for-both"]);
    expect(await admin.idsUntil("end")).toEqual(["for-admins"]);

    u1.close();
    u2.close();
    admin.close();
    await vi.waitFor(() => expect(stream.subscriberCount()).toBe(0));
  });
});
