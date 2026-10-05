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
import { TOP_LEVEL_POLICIES, SUBTREE_POLICIES, USER_DOC_POLICY, type CollectionPolicy } from "./data-policy";
import { startTestDataPlane, type TestServer } from "./test-helpers";

const USER = "policy-user";
const TOKEN = "tok-policy-user";

/** Read-only for the client: what each locked table still lets a browser do. */
const readOnly = (read: CollectionPolicy["read"]): CollectionPolicy => ({ read, create: "none", update: "none", delete: "none" });

const LOCKED_TOP_LEVEL = ["emailIntegrations", "agentSearchSessions", "aiUsage", "precisionSearchQueue", "imports"] as const;

describe("the policy", () => {
  it.each(LOCKED_TOP_LEVEL)("%s is read-only for the client", (name) => {
    expect(TOP_LEVEL_POLICIES[name]).toEqual(readOnly("owner"));
  });

  it("reports under users/{uid} are read-only for the client", () => {
    expect(SUBTREE_POLICIES.reports).toEqual(readOnly("authed"));
  });

  it("the users/{uid} document can be created and read, never updated or deleted", () => {
    expect(USER_DOC_POLICY).toEqual({ read: "authed", create: "authed", update: "none", delete: "none" });
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
    ["imports/im-1", { userId: USER, sourceId: "s-1", status: "completed", fieldMappings: [] }],
    [`users/${USER}/reports/r-1`, { status: "draft" }],
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

  it.each(rows.filter(([path]) => path !== `users/${USER}`))("%s refuses a client create", async (path, data) => {
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
});
