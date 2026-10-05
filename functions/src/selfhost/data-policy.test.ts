/**
 * The browser reads domain data; only the server writes it (ADR-0016, #624).
 *
 * The tables that have no browser writer left are read-only for the client:
 * the policy says so, and the real data plane refuses a write to each of them
 * while still serving its reads. A table joins LOCKED in the change that
 * removes its last browser writer (browser-writes.test.ts holds the writers).
 *
 *   npx vitest run --config vitest.selfhost.config.ts src/selfhost/data-policy.test.ts --pool=forks --maxWorkers=1
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { __resetFirestoreShim, __whenShimIdle, getFirestore } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";
import { TOP_LEVEL_POLICIES, SUBTREE_POLICIES, SUBTREE_DOC_POLICIES, USER_DOC_POLICY, type CollectionPolicy } from "./data-policy";
import { startTestDataPlane, type TestServer } from "./test-helpers";

const USER = "policy-user";
const TOKEN = "tok-policy-user";

/** Read-only for the client: what each locked table still lets a browser do. */
const readOnly = (read: CollectionPolicy["read"]): CollectionPolicy => ({ read, create: "none", update: "none", delete: "none" });

const LOCKED_TOP_LEVEL = ["emailIntegrations", "agentSearchSessions", "aiUsage", "precisionSearchQueue"] as const;

describe("the policy", () => {
  it.each(LOCKED_TOP_LEVEL)("%s is read-only for the client", (name) => {
    expect(TOP_LEVEL_POLICIES[name]).toEqual(readOnly("owner"));
  });

  it("reports under users/{uid} are read-only for the client", () => {
    expect(SUBTREE_POLICIES.reports).toEqual(readOnly("authed"));
  });

  it("the business identity under users/{uid}/settings is read-only for the client (#632)", () => {
    expect(SUBTREE_DOC_POLICIES["settings/userData"]).toEqual(readOnly("authed"));
  });

  it("the users/{uid} document is read-only for the client", () => {
    expect(USER_DOC_POLICY).toEqual(readOnly("authed"));
  });

  it("notifications can only be read and marked read by the client", () => {
    expect(SUBTREE_POLICIES.notifications).toEqual({
      read: "authed",
      create: "none",
      update: "authed",
      delete: "none",
      updateFields: ["readAt"],
    });
  });
});

describe("the data plane enforces it", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestDataPlane(async (token) => (token === TOKEN ? { uid: USER, token: {} } : null));
  });

  afterAll(() => server.close());

  /** One existing row per locked table, owned by USER. */
  const rows: Array<[string, Record<string, unknown>]> = [
    ["emailIntegrations/ei-1", { userId: USER, email: "me@example.test", isActive: true }],
    ["agentSearchSessions/as-1", { userId: USER, status: "active" }],
    ["aiUsage/au-1", { userId: USER, function: "chat", inputTokens: 1 }],
    ["precisionSearchQueue/ps-1", { userId: USER, status: "pending" }],
    [`users/${USER}/reports/r-1`, { status: "draft" }],
    [`users/${USER}/settings/userData`, { personalEntity: { name: "Max Muster" }, finanzonline: { isConfigured: true } }],
    [`users/${USER}`, { email: "me@example.test" }],
  ];

  beforeEach(async () => {
    await __whenShimIdle();
    await __resetFirestoreShim();
    __resetTriggerShim();
    for (const [path, data] of rows) await getFirestore().doc(path).set(data);
  });

  async function call(route: "get" | "write", body: unknown) {
    const res = await fetch(`${server.base}/__data/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  }

  it.each(rows)("%s is still readable", async (path) => {
    const r = await call("get", { path });
    expect(r.status, r.text).toBe(200);
    expect(JSON.parse(r.text).exists).toBe(true);
  });

  it.each(rows)("%s refuses a client update and delete", async (path, data) => {
    for (const op of [
      { type: "update", path, data: { changed: true } },
      { type: "set", path, data: { ...data, changed: true }, merge: true },
      { type: "delete", path },
    ]) {
      const r = await call("write", { ops: [op] });
      expect(r.status, `${op.type} ${path} -> ${r.text}`).toBe(403);
    }
    const after = await getFirestore().doc(path).get();
    expect(after.data()).toEqual(data);
  });

  // settings/ holds other documents a client may still write; the identity's own
  // create case is below.
  const created = (path: string) => path !== `users/${USER}` && !path.startsWith(`users/${USER}/settings/`);

  it.each(rows.filter(([path]) => created(path)))("%s refuses a client create", async (path, data) => {
    const collection = path.slice(0, path.lastIndexOf("/"));
    for (const op of [
      { type: "add", path: collection, data },
      { type: "set", path: `${collection}/planted`, data },
    ]) {
      const r = await call("write", { ops: [op] });
      expect(r.status, `${op.type} ${collection} -> ${r.text}`).toBe(403);
    }
    expect((await getFirestore().doc(`${collection}/planted`).get()).exists).toBe(false);
  });

  it("the business identity refuses a client create when the user has none yet (#632)", async () => {
    const path = `users/${USER}/settings/userData`;
    await getFirestore().doc(path).delete();
    const r = await call("write", { ops: [{ type: "set", path, data: { personalEntity: { name: "Planted" } } }] });
    expect(r.status, r.text).toBe(403);
    expect((await getFirestore().doc(path).get()).exists).toBe(false);
  });

  it("users/{uid} refuses a client create when the document does not exist yet", async () => {
    await getFirestore().doc(`users/${USER}`).delete();
    for (const op of [
      { type: "set", path: `users/${USER}`, data: { pendingDeletion: true, admin: true } },
      { type: "set", path: `users/${USER}`, data: { pendingDeletion: true, admin: true }, merge: true },
    ]) {
      const r = await call("write", { ops: [op] });
      expect(r.status, `${JSON.stringify(op)} -> ${r.text}`).toBe(403);
    }
    expect((await getFirestore().doc(`users/${USER}`).get()).exists).toBe(false);
  });

  describe("notifications", () => {
    const NOTIFICATIONS = `users/${USER}/notifications`;
    const unread = { title: "Done", readAt: null };

    beforeEach(async () => {
      await getFirestore().doc(`${NOTIFICATIONS}/n-1`).set(unread);
      await getFirestore().doc(`${NOTIFICATIONS}/n-2`).set(unread);
    });

    it("refuses a client create and leaves nothing behind", async () => {
      for (const op of [
        { type: "add", path: NOTIFICATIONS, data: unread },
        { type: "set", path: `${NOTIFICATIONS}/planted`, data: unread },
      ]) {
        const r = await call("write", { ops: [op] });
        expect(r.status, `${op.type} ${NOTIFICATIONS} -> ${r.text}`).toBe(403);
      }
      const all = await getFirestore().collection(NOTIFICATIONS).get();
      expect(all.docs.map((d) => d.id).sort()).toEqual(["n-1", "n-2"]);
    });

    it("refuses a client delete and leaves the notification in place", async () => {
      const r = await call("write", { ops: [{ type: "delete", path: `${NOTIFICATIONS}/n-1` }] });
      expect(r.status, r.text).toBe(403);
      expect((await getFirestore().doc(`${NOTIFICATIONS}/n-1`).get()).data()).toEqual(unread);
    });

    it("refuses a client update of any field but readAt and leaves the notification unchanged", async () => {
      const path = `${NOTIFICATIONS}/n-1`;
      for (const op of [
        { type: "update", path, data: { title: "Rewritten" } },
        { type: "update", path, data: { readAt: 1, title: "Rewritten" } },
        { type: "update", path, data: { "readAt.nested": 1 } },
        { type: "set", path, data: { type: "planted" }, merge: true },
      ]) {
        const r = await call("write", { ops: [op] });
        expect(r.status, `${JSON.stringify(op)} -> ${r.text}`).toBe(403);
      }
      expect((await getFirestore().doc(path).get()).data()).toEqual(unread);
    });

    it("refuses a client overwrite of the whole notification, even with readAt alone", async () => {
      const path = `${NOTIFICATIONS}/n-1`;
      const r = await call("write", { ops: [{ type: "set", path, data: { readAt: 1 } }] });
      expect(r.status, r.text).toBe(403);
      expect((await getFirestore().doc(path).get()).data()).toEqual(unread);
    });

    it("still lets the client mark one read", async () => {
      const r = await call("write", { ops: [{ type: "update", path: `${NOTIFICATIONS}/n-1`, data: { readAt: 1 } }] });
      expect(r.status, r.text).toBe(200);
      expect((await getFirestore().doc(`${NOTIFICATIONS}/n-1`).get()).get("readAt")).toBe(1);
    });

    it("still lets the client mark all read in one batch", async () => {
      const ops = ["n-1", "n-2"].map((id) => ({ type: "update", path: `${NOTIFICATIONS}/${id}`, data: { readAt: 1 } }));
      const r = await call("write", { ops });
      expect(r.status, r.text).toBe(200);
      for (const id of ["n-1", "n-2"]) expect((await getFirestore().doc(`${NOTIFICATIONS}/${id}`).get()).get("readAt")).toBe(1);
    });
  });
});
