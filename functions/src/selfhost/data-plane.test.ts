/**
 * Work item 6, slice A — client data plane over a real socket.
 *
 * Covers: auth requirement, owner-filter injection on queries (rules
 * trusted the client's where; we don't), where/orderBy/limit/dotted
 * fields/__name__ translation, uidKey + users-subtree + serverOnly +
 * unlisted policy enforcement, wire Timestamp round-trip, sentinel writes
 * (serverTimestamp/increment/arrayUnion/arrayRemove/deleteField), batch
 * atomicity surface, ifUnchanged preconditions (the client runTransaction
 * seam), delete idempotency, and that client-style writes fire the SAME
 * trigger bus the backend chains run on.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim, onDocumentCreated } from "./trigger-shim";
import { createDataPlane } from "./data-plane";

const db = getFirestore();
const USER = "stefan-test";
const OTHER = "someone-else";
const GOOD_TOKEN = "tok-stefan";
const ADMIN_TOKEN = "tok-admin";

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(
    "/__data",
    createDataPlane(async (token) => {
      if (token === GOOD_TOKEN) return { uid: USER, token: {} };
      if (token === ADMIN_TOKEN) return { uid: "admin-user", token: { admin: true } };
      return null;
    }),
  );
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 20));
  await __resetFirestoreShim();
  __resetTriggerShim();
});

// token: null = send no Authorization header (an explicit undefined argument
// would fall back to the default parameter and silently authenticate).
async function call(route: string, body: unknown, token: string | null = GOOD_TOKEN) {
  const res = await fetch(`${base}/__data/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("data plane: auth", () => {
  it("rejects missing and invalid tokens", async () => {
    const missing = await call("query", { path: "transactions" }, null);
    expect(missing.status).toBe(401);
    const invalid = await call("query", { path: "transactions" }, "nope");
    expect(invalid.status).toBe(401);
    expect(invalid.body.error.status).toBe("UNAUTHENTICATED");
  });
});

describe("data plane: query", () => {
  beforeEach(async () => {
    await db.collection("transactions").doc("t-mine-1").set({
      userId: USER, name: "REWE", amount: -1200, date: new Timestamp(1750000000, 0),
      period: { year: 2026, type: "monthly" },
    });
    await db.collection("transactions").doc("t-mine-2").set({
      userId: USER, name: "Migadu", amount: -1900, date: new Timestamp(1760000000, 0),
      period: { year: 2025, type: "monthly" },
    });
    await db.collection("transactions").doc("t-other").set({
      userId: OTHER, name: "Foreign", amount: -1, date: new Timestamp(1770000000, 0),
    });
    await drainTriggers();
  });

  it("injects the owner filter even when the client sends none", async () => {
    const r = await call("query", { path: "transactions" });
    expect(r.status).toBe(200);
    expect(r.body.docs.map((d: any) => d.id).sort()).toEqual(["t-mine-1", "t-mine-2"]);
  });

  it("translates where/orderBy/limit and dotted fields, round-trips Timestamps", async () => {
    const r = await call("query", {
      path: "transactions",
      wheres: [{ field: "period.year", op: ">=", value: 2026 }],
      orderBys: [{ field: "date", dir: "desc" }],
      limit: 5,
    });
    expect(r.body.docs.map((d: any) => d.id)).toEqual(["t-mine-1"]);
    expect(r.body.docs[0].data.date).toEqual({ __ts: [1750000000, 0] });
  });

  it("supports __name__ in-filters (documentId batching)", async () => {
    const r = await call("query", {
      path: "transactions",
      wheres: [{ field: "__name__", op: "in", value: ["t-mine-2", "t-other", "nope"] }],
    });
    // t-other is filtered by the injected owner clause, not just the id list
    expect(r.body.docs.map((d: any) => d.id)).toEqual(["t-mine-2"]);
  });

  it("cannot query another user's rows by spoofing the userId where", async () => {
    const r = await call("query", {
      path: "transactions",
      wheres: [{ field: "userId", op: "==", value: OTHER }],
    });
    expect(r.body.docs).toEqual([]); // both filters apply — empty, never foreign rows
  });

  it("enforces subtree ownership and unlisted collections", async () => {
    const foreign = await call("query", { path: `users/${OTHER}/notifications` });
    expect(foreign.status).toBe(403);
    const unlisted = await call("query", { path: "countryExpansion" });
    expect(unlisted.status).toBe(403);
    const serverOnlySub = await call("query", { path: `users/${USER}/system` });
    expect(serverOnlySub.status).toBe(403);
  });

  it("admin collections require the admin claim", async () => {
    const denied = await call("query", { path: "allowedEmails" });
    expect(denied.status).toBe(403);
    const allowed = await call("query", { path: "allowedEmails" }, ADMIN_TOKEN);
    expect(allowed.status).toBe(200);
  });
});

describe("data plane: get", () => {
  it("owner doc reads work; foreign docs come back permission-denied", async () => {
    await db.collection("files").doc("f-1").set({ userId: USER, fileName: "a.pdf" });
    await db.collection("files").doc("f-2").set({ userId: OTHER, fileName: "b.pdf" });
    await drainTriggers();

    const mine = await call("get", { path: "files/f-1" });
    expect(mine.body).toMatchObject({ exists: true, id: "f-1", data: { fileName: "a.pdf" } });

    const foreign = await call("get", { path: "files/f-2" });
    expect(foreign.status).toBe(403);

    const missing = await call("get", { path: "files/f-none" });
    expect(missing.body).toMatchObject({ exists: false, data: null });
  });

  it("uidKey: subscriptions readable only under your own uid", async () => {
    await db.collection("subscriptions").doc(USER).set({ plan: "selfhost" });
    await db.collection("subscriptions").doc(OTHER).set({ plan: "pro" });
    await drainTriggers();

    const mine = await call("get", { path: `subscriptions/${USER}` });
    expect(mine.body.data.plan).toBe("selfhost");
    const foreign = await call("get", { path: `subscriptions/${OTHER}` });
    expect(foreign.status).toBe(403);
  });
});

describe("data plane: write", () => {
  it("add: stamps a new id, decodes sentinels, fires the trigger bus", async () => {
    const fired: string[] = [];
    onDocumentCreated({ document: "partners/{id}" }, async (e) => {
      fired.push(e.params.id);
    });

    const r = await call("write", {
      ops: [{
        type: "add",
        path: "partners",
        data: {
          userId: USER,
          name: "Hetzner",
          createdAt: { __sv: "serverTimestamp" },
          tags: { __sv: "arrayUnion", v: ["hosting"] },
        },
      }],
    });
    expect(r.status).toBe(200);
    const id = r.body.ids[0];

    await drainTriggers();
    expect(fired).toEqual([id]);

    const doc = (await db.collection("partners").doc(id).get()).data()!;
    expect(doc.name).toBe("Hetzner");
    expect(doc.createdAt).toBeInstanceOf(Timestamp);
    expect(doc.tags).toEqual(["hosting"]);
  });

  it("add: rejects foreign or missing userId on owner collections", async () => {
    const foreign = await call("write", {
      ops: [{ type: "add", path: "partners", data: { userId: OTHER, name: "X" } }],
    });
    expect(foreign.status).toBe(403);
    const missing = await call("write", {
      ops: [{ type: "add", path: "partners", data: { name: "X" } }],
    });
    expect(missing.status).toBe(403);
  });

  it("update: increment/arrayRemove/deleteField sentinels against the real store", async () => {
    await db.collection("noReceiptCategories").doc("c-1").set({
      userId: USER, name: "Fees", useCount: 2, examples: ["a", "b"], stale: true,
    });
    await drainTriggers();

    const r = await call("write", {
      ops: [{
        type: "update",
        path: "noReceiptCategories/c-1",
        data: {
          useCount: { __sv: "increment", n: 1 },
          examples: { __sv: "arrayRemove", v: ["a"] },
          stale: { __sv: "deleteField" },
        },
      }],
    });
    expect(r.status).toBe(200);

    const doc = (await db.collection("noReceiptCategories").doc("c-1").get()).data()!;
    expect(doc.useCount).toBe(3);
    expect(doc.examples).toEqual(["b"]);
    expect("stale" in doc).toBe(false);
  });

  it("update/delete: ownership enforced on the EXISTING row", async () => {
    await db.collection("files").doc("f-x").set({ userId: OTHER, fileName: "x.pdf" });
    await drainTriggers();

    const upd = await call("write", {
      ops: [{ type: "update", path: "files/f-x", data: { fileName: "mine-now.pdf" } }],
    });
    expect(upd.status).toBe(403);
    const del = await call("write", { ops: [{ type: "delete", path: "files/f-x" }] });
    expect(del.status).toBe(403);
  });

  it("serverOnly writes are denied; delete of a missing doc is a no-op", async () => {
    const inv = await call("write", {
      ops: [{ type: "update", path: "invoices/i-1", data: { status: "paid" } }],
    });
    expect(inv.status).toBe(403);

    const del = await call("write", { ops: [{ type: "delete", path: "sources/never-existed" }] });
    expect(del.status).toBe(200);
    expect(del.body.ids).toEqual(["never-existed"]);
  });

  it("a multi-op request validates everything before writing anything", async () => {
    await db.collection("sources").doc("s-1").set({ userId: USER, name: "N26" });
    await drainTriggers();

    const r = await call("write", {
      ops: [
        { type: "update", path: "sources/s-1", data: { name: "N26 Business" } },
        { type: "update", path: "invoices/i-1", data: { status: "paid" } }, // denied
      ],
    });
    expect(r.status).toBe(403);
    // First op must NOT have landed.
    expect((await db.collection("sources").doc("s-1").get()).data()!.name).toBe("N26");
  });

  it("ifUnchanged precondition: succeeds when field matches, 409 aborted when raced", async () => {
    await db.collection(`users/${USER}/workerRequests`).doc("wr-1").set({
      status: "pending", task: "sync",
    });
    await drainTriggers();

    const claim = await call("write", {
      ops: [{
        type: "update",
        path: `users/${USER}/workerRequests/wr-1`,
        data: { status: "claimed" },
        ifUnchanged: { status: "pending" },
      }],
    });
    expect(claim.status).toBe(200);

    const second = await call("write", {
      ops: [{
        type: "update",
        path: `users/${USER}/workerRequests/wr-1`,
        data: { status: "claimed" },
        ifUnchanged: { status: "pending" },
      }],
    });
    expect(second.status).toBe(409);
    expect(second.body.error.status).toBe("ABORTED");
  });

  it("set with merge patches instead of replacing", async () => {
    await db.collection("sources").doc("s-m").set({ userId: USER, name: "N26", isActive: true });
    await drainTriggers();

    const r = await call("write", {
      ops: [{ type: "set", path: "sources/s-m", data: { name: "N26 v2" }, merge: true }],
    });
    expect(r.status).toBe(200);
    const doc = (await db.collection("sources").doc("s-m").get()).data()!;
    expect(doc.name).toBe("N26 v2");
    expect(doc.isActive).toBe(true);
  });

  it("rejects unknown wire tags loudly instead of storing them", async () => {
    const r = await call("write", {
      ops: [{ type: "add", path: "partners", data: { userId: USER, weird: { __blob: "x" } } }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("__blob");
  });

  it("rejects dotted __proto__ field paths (no prototype pollution)", async () => {
    await db.collection(`users/${USER}/settings`).doc("s-1").set({ theme: "dark" });
    await drainTriggers();

    const r = await call("write", {
      ops: [{
        type: "update",
        path: `users/${USER}/settings/s-1`,
        data: { "a.__proto__.polluted": "PWNED" },
      }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("unsafe field path");
    // Global prototype must be untouched.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("honors ifUnchanged on set and delete, not just update", async () => {
    await db.collection(`users/${USER}/workerRequests`).doc("wr-2").set({
      status: "pending", task: "sync",
    });
    await drainTriggers();

    const staleSet = await call("write", {
      ops: [{
        type: "set",
        path: `users/${USER}/workerRequests/wr-2`,
        data: { status: "claimed", task: "sync" },
        merge: true,
        ifUnchanged: { status: "done" },
      }],
    });
    expect(staleSet.status).toBe(409);

    const staleDelete = await call("write", {
      ops: [{
        type: "delete",
        path: `users/${USER}/workerRequests/wr-2`,
        ifUnchanged: { status: "done" },
      }],
    });
    expect(staleDelete.status).toBe(409);
    // Doc still there — neither stale op applied.
    expect((await db.collection(`users/${USER}/workerRequests`).doc("wr-2").get()).exists).toBe(true);
  });

  it("rejects a malformed __ts value as 400, not 500", async () => {
    const r = await call("write", {
      ops: [{ type: "add", path: "partners", data: { userId: USER, at: { __ts: [1, 9_999_999_999] } } }],
    });
    expect(r.status).toBe(400);
  });
});

describe("data plane: uidKeyed query with limit", () => {
  it("returns the caller's own subscription even when foreign rows sort ahead", async () => {
    // Seed a foreign row that sorts first, then the caller's — a query-level
    // limit(1) would slice the caller's row off before the uid post-filter.
    await db.collection("subscriptions").doc("aaa-other").set({ userId: OTHER, plan: "pro" });
    await db.collection("subscriptions").doc(USER).set({ userId: USER, plan: "selfhost" });
    await drainTriggers();

    const r = await call("query", { path: "subscriptions", orderBys: [{ field: "plan", dir: "asc" }], limit: 1 });
    expect(r.status).toBe(200);
    expect(r.body.docs.map((d: any) => d.id)).toEqual([USER]);
  });
});
