/**
 * Cross-user isolation, client data plane: /__data/query, /__data/get and
 * /__data/write over a real socket, as the attacker, aimed at the victim.
 *
 * The data plane is the one surface where the browser names collections,
 * paths, filters and field paths itself, so this suite throws shapes at it
 * rather than ids: filters on userId, __name__ and `ids` with victim ids and
 * path-shaped values, traversal and malformed paths, direct reads of victim
 * documents and the victim's users/ subtree, every way a write could take,
 * plant, gift, change or delete a document, a batch mixing one own op with
 * one victim op, prototype-polluting field paths, and oversized ids.
 *
 * Passing means: no response carries the victim's CANARY, every victim row
 * is unchanged afterwards, and no row was created in the victim's name.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { __resetFirestoreShim, getFirestore, Timestamp, __rawSqlForTest } from "../firestore-shim";
import { drainTriggers, __resetTriggerShim } from "../trigger-shim";
import { createDataPlane } from "../data-plane";
import { TOP_LEVEL_POLICIES, SUBTREE_POLICIES } from "../data-policy";
import {
  ATTACKER,
  VICTIM,
  A,
  V,
  CANARY,
  ALL_VICTIM_IDS,
  seedAccounts,
  victimRows,
  assertVictimUntouched,
  assertNoLeak,
} from "./victim";

const ATTACKER_TOKEN = "tok-attacker";
const VICTIM_TOKEN = "tok-victim";

let server: http.Server;
let base: string;
let before: Map<string, string>;

beforeAll(async () => {
  const app = express();
  app.use(
    "/__data",
    createDataPlane(async (token) => {
      if (token === ATTACKER_TOKEN) return { uid: ATTACKER, token: {} };
      if (token === VICTIM_TOKEN) return { uid: VICTIM, token: {} };
      return null;
    }),
  );
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

/** Rows outside victimRows' net that are still the victim's: their Transaction's history. */
async function victimHistory(): Promise<string> {
  const r = await __rawSqlForTest(
    `SELECT path, data::text AS data FROM docs WHERE path LIKE $1 ORDER BY path`,
    [`transactions/${V.transaction}/history/%`],
  );
  return JSON.stringify(r.rows);
}
let historyBefore: string;

beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 20));
  await __resetFirestoreShim();
  __resetTriggerShim();
  await seedAccounts();
  const db = getFirestore();
  // Edit history lives under the Transaction and carries no userId.
  await db.doc(`transactions/${V.transaction}/history/v-hist-1`).set({
    changedAt: Timestamp.now(),
    changedBy: VICTIM,
    previousValues: { description: CANARY },
    newValues: { description: "now" },
  });
  await db.doc(`transactions/${A.transaction}/history/a-hist-1`).set({
    changedAt: Timestamp.now(),
    changedBy: ATTACKER,
    previousValues: { description: "mine before" },
    newValues: { description: "mine" },
  });
  await drainTriggers();
  before = await victimRows();
  historyBefore = await victimHistory();
});

async function call(route: "query" | "get" | "write", body: unknown, token = ATTACKER_TOKEN) {
  const res = await fetch(`${base}/__data/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, any> };
}

/** The attack ran: nothing came back, nothing of the victim's moved. */
async function expectHarmless(route: "query" | "get" | "write", body: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const label = `${route} ${JSON.stringify(body).slice(0, 160)}`;
  const r = await call(route, body);
  assertNoLeak(r.text, label);
  expect(r.status, `${label} -> ${r.text.slice(0, 200)}`).toBeLessThan(500);
  await drainTriggers();
  await assertVictimUntouched(before, label);
  expect(await victimHistory(), `${label}: victim history changed`).toBe(historyBefore);
  return r;
}

const ownerCollections = Object.entries(TOP_LEVEL_POLICIES)
  .filter(([, p]) => p.read === "owner")
  .map(([name]) => name);

describe("data plane: positive controls", () => {
  it("the attacker reads and writes their own data", async () => {
    const q = await call("query", { path: "transactions" });
    expect(q.body.docs.map((d: { id: string }) => d.id)).toEqual([A.transaction]);
    const g = await call("get", { path: `users/${ATTACKER}/notifications/${A.notification}` });
    expect(g.body.exists).toBe(true);
    const w = await call("write", { ops: [{ type: "update", path: `transactions/${A.transaction}`, data: { description: "mine, edited" } }] });
    expect(w.status).toBe(200);
    const h = await call("query", { path: `transactions/${A.transaction}/history` });
    expect(h.status).toBe(200);
    expect(h.body.docs.map((d: { id: string }) => d.id)).toEqual(["a-hist-1"]);
  });

  it("the victim's history and searches are part of what must stay untouched", async () => {
    const keys = [...before.keys()];
    expect(keys).toContain(`docs:transactions/${V.transaction}/history/v-hist-1`);
    expect(keys).toContain(`docs:transactions/${V.transaction}/searches/v-search-1`);
  });

  it("the victim still reads their own history", async () => {
    const h = await call("query", { path: `transactions/${V.transaction}/history` }, VICTIM_TOKEN);
    expect(h.status).toBe(200);
    expect(h.text).toContain(CANARY);
  });
});

describe("data plane: queries never return another user's rows", () => {
  const filterAttacks = (path: string) => [
    { path },
    { path, wheres: [{ field: "userId", op: "==", value: VICTIM }] },
    { path, wheres: [{ field: "userId", op: "in", value: [ATTACKER, VICTIM] }] },
    { path, wheres: [{ field: "userId", op: "!=", value: ATTACKER }] },
    { path, wheres: [{ field: "userId", op: "not-in", value: [ATTACKER] }] },
    { path, wheres: [{ field: "__name__", op: "==", value: V.transaction }] },
    { path, wheres: [{ field: "__name__", op: "in", value: ALL_VICTIM_IDS }] },
    { path, wheres: [{ field: "__name__", op: "in", value: [`users/${VICTIM}/settings/userData`, `../users/${VICTIM}`, `${path}/${V.file}`] }] },
    { path, ids: ALL_VICTIM_IDS },
    { path, ids: [`users/${VICTIM}/settings/userData`, `transactions/${V.transaction}`, `../${V.file}`] },
    { path, orderBys: [{ field: "userId", dir: "desc" }], limit: 50 },
  ];

  for (const coll of ownerCollections) {
    it(`${coll}: userId, __name__ and ids filters`, async () => {
      for (const body of filterAttacks(coll)) {
        const r = await expectHarmless("query", body);
        for (const d of r.body.docs ?? []) expect(d.id, coll).not.toMatch(/^v-/);
      }
    });
  }

  it("subscriptions (uid-keyed) do not list the victim", async () => {
    await expectHarmless("query", { path: "subscriptions" });
    await expectHarmless("query", { path: "subscriptions", wheres: [{ field: "__name__", op: "==", value: VICTIM }] });
    await expectHarmless("query", { path: "subscriptions", ids: [VICTIM] });
  });

  it("the users collection and every victim subtree are refused", async () => {
    await expectHarmless("query", { path: "users" });
    for (const sub of Object.keys(SUBTREE_POLICIES)) {
      const r = await expectHarmless("query", { path: `users/${VICTIM}/${sub}` });
      expect(r.status, sub).toBe(403);
    }
  });

  it("another user's Transaction history is not readable", async () => {
    await expectHarmless("query", { path: `transactions/${V.transaction}/history` });
    await expectHarmless("query", { path: `transactions/${V.transaction}/history`, ids: ["v-hist-1"] });
  });

  it("traversal, encoded separators and empty segments are refused", async () => {
    const paths = [
      `users/${ATTACKER}/../${VICTIM}/settings`,
      `users/${ATTACKER}/settings/../../${VICTIM}/settings`,
      `users/${VICTIM}%2Fsettings`,
      `users/${ATTACKER}%2F..%2F${VICTIM}/settings`,
      `users//${VICTIM}/settings`,
      `/users/${VICTIM}/settings`,
      `users/${VICTIM}/settings/`,
      `files/../users/${VICTIM}/settings`,
      `transactions/${V.transaction}/history/../../files`,
      `users/${ATTACKER}/notifications/../../../files`,
      "..",
      ".",
      "",
    ];
    for (const path of paths) {
      const r = await expectHarmless("query", { path });
      expect(r.status, path).toBeGreaterThanOrEqual(400);
    }
  });

  it("oversized ids and id lists are bounded", async () => {
    await expectHarmless("query", { path: "files", ids: Array.from({ length: 201 }, (_, i) => `x${i}`) });
    await expectHarmless("query", { path: "files", ids: ["x".repeat(100_000)] });
    await expectHarmless("query", { path: "files", wheres: [{ field: "__name__", op: "==", value: "x".repeat(100_000) }] });
  });
});

describe("data plane: direct reads", () => {
  const victimDocs = [
    `transactions/${V.transaction}`,
    `files/${V.file}`,
    `partners/${V.partner}`,
    `sources/${V.source}`,
    `noReceiptCategories/${V.category}`,
    `imports/${V.import}`,
    `emailIntegrations/${V.integration}`,
    `invoices/${V.invoice}`,
    `fileConnections/${V.connection}`,
    `apiKeys/${V.apiKey}`,
    `subscriptions/${VICTIM}`,
    `users/${VICTIM}`,
    `users/${VICTIM}/settings/userData`,
    `users/${VICTIM}/chatSessions/${V.chat}`,
    `users/${VICTIM}/notifications/${V.notification}`,
    `transactions/${V.transaction}/history/v-hist-1`,
    `users/${ATTACKER}/../${VICTIM}`,
    `users/${ATTACKER}/settings/../../${VICTIM}/settings/userData`,
    `files/../users/${VICTIM}`,
    `files/${"x".repeat(100_000)}`,
  ];
  it("every victim document, and path-shaped ways to name one, are refused", async () => {
    for (const path of victimDocs) {
      const r = await expectHarmless("get", { path });
      expect(r.body.data ?? null, path).toBeNull();
    }
  });
});

describe("data plane: writes", () => {
  const ts = { __ts: [1_790_000_000, 0] };

  const single: Array<[string, Record<string, unknown>]> = [
    // hijack: take the victim's doc over
    ["set victim doc as mine", { type: "set", path: `transactions/${V.transaction}`, data: { userId: ATTACKER, name: "taken" } }],
    ["merge victim doc as mine", { type: "set", path: `files/${V.file}`, data: { userId: ATTACKER }, merge: true }],
    ["update victim userId", { type: "update", path: `partners/${V.partner}`, data: { userId: ATTACKER } }],
    // plant: create in the victim's name
    ["add with victim userId", { type: "add", path: "transactions", data: { userId: VICTIM, name: "planted", date: ts } }],
    ["set new doc with victim userId", { type: "set", path: "files/planted-1", data: { userId: VICTIM, fileName: "planted" } }],
    ["add into victim subtree", { type: "add", path: `users/${VICTIM}/notifications`, data: { message: "planted" } }],
    ["set victim user doc", { type: "set", path: `users/${VICTIM}`, data: { email: "taken" }, merge: true }],
    ["set victim settings", { type: "set", path: `users/${VICTIM}/settings/userData`, data: { companyName: "taken" } }],
    ["plant victim history", { type: "add", path: `transactions/${V.transaction}/history`, data: { previousValues: { description: "planted" } } }],
    ["set victim history entry", { type: "set", path: `transactions/${V.transaction}/history/planted`, data: { previousValues: {} } }],
    // gift: hand my own doc to the victim
    ["update own doc to victim", { type: "update", path: `transactions/${A.transaction}`, data: { userId: VICTIM } }],
    ["set own doc to victim", { type: "set", path: `files/${A.file}`, data: { userId: VICTIM, fileName: "gift" } }],
    ["merge own doc to victim", { type: "set", path: `partners/${A.partner}`, data: { userId: VICTIM }, merge: true }],
    // change / delete
    ["update victim doc", { type: "update", path: `transactions/${V.transaction}`, data: { name: "changed" } }],
    ["update victim notification", { type: "update", path: `users/${VICTIM}/notifications/${V.notification}`, data: { read: true } }],
    ["delete victim doc", { type: "delete", path: `files/${V.file}` }],
    ["delete victim subtree doc", { type: "delete", path: `users/${VICTIM}/chatSessions/${V.chat}` }],
    ["delete victim subscription", { type: "delete", path: `subscriptions/${VICTIM}` }],
    ["sentinel on victim doc", { type: "update", path: `transactions/${V.transaction}`, data: { fileIds: { __sv: "arrayUnion", v: [A.file] } } }],
    // path-shaped
    ["traversal update", { type: "update", path: `users/${ATTACKER}/../${VICTIM}`, data: { email: "x" } }],
    ["traversal set", { type: "set", path: `users/${ATTACKER}/notifications/../../../${VICTIM}/notifications/x`, data: { m: 1 } }],
    ["encoded set", { type: "set", path: `users/${ATTACKER}%2F..%2F${VICTIM}/settings/userData`, data: { m: 1 } }],
    ["empty segment", { type: "set", path: `users//${VICTIM}/settings/userData`, data: { m: 1 } }],
    ["oversized id", { type: "set", path: `files/${"x".repeat(100_000)}`, data: { userId: VICTIM } }],
  ];

  for (const [label, op] of single) {
    it(label, async () => {
      const r = await expectHarmless("write", { ops: [op] });
      expect(r.status, label).toBeGreaterThanOrEqual(400);
    });
  }

  it("a batch with one own op and one victim op fails as a whole", async () => {
    const mixes = [
      { type: "delete", path: `files/${V.file}` },
      { type: "update", path: `transactions/${V.transaction}`, data: { name: "x" } },
      { type: "add", path: "partners", data: { userId: VICTIM, name: "planted" } },
      { type: "set", path: `users/${VICTIM}/settings/userData`, data: { companyName: "x" } },
    ];
    for (const victimOp of mixes) {
      for (const order of [0, 1]) {
        const own = { type: "update", path: `transactions/${A.transaction}`, data: { description: `batch ${order}` } };
        const ops = order === 0 ? [own, victimOp] : [victimOp, own];
        const r = await expectHarmless("write", { ops });
        expect(r.status).toBeGreaterThanOrEqual(400);
        const mine = await getFirestore().doc(`transactions/${A.transaction}`).get();
        expect(mine.data()?.description, "own op must not commit").toBeUndefined();
      }
    }
  });

  it("a precondition cannot be used to read another user's fields", async () => {
    // A precondition compares a stored value; evaluated before the ownership
    // check it answers "aborted" for a wrong guess and "denied" for a right
    // one, which reads the victim's fileName one guess at a time.
    const wrong = await expectHarmless("write", {
      ops: [{ type: "delete", path: `files/${V.file}`, ifUnchanged: { fileName: "wrong guess" } }],
    });
    const right = await expectHarmless("write", {
      ops: [{ type: "delete", path: `files/${V.file}`, ifUnchanged: { fileName: `${CANARY}.pdf` } }],
    });
    expect(wrong.status).toBe(right.status);
    for (const type of ["update", "set"]) {
      const w = await expectHarmless("write", {
        ops: [{ type, path: `files/${V.file}`, data: { fileName: "x" }, ifUnchanged: { fileName: "wrong guess" } }],
      });
      const r = await expectHarmless("write", {
        ops: [{ type, path: `files/${V.file}`, data: { fileName: "x" }, ifUnchanged: { fileName: `${CANARY}.pdf` } }],
      });
      expect(w.status, type).toBe(r.status);
    }
  });

  it("prototype-polluting field paths are refused", async () => {
    const paths = ["__proto__.polluted", "a.__proto__.polluted", "constructor.prototype.polluted", "prototype.polluted", "__proto__"];
    for (const key of paths) {
      for (const type of ["update", "set"]) {
        await expectHarmless("write", { ops: [{ type, path: `transactions/${A.transaction}`, data: { [key]: true }, merge: true }] });
      }
      await expectHarmless("write", { ops: [{ type: "add", path: "transactions", data: { userId: ATTACKER, [key]: true } }] });
      await expectHarmless("write", { ops: [{ type: "update", path: `transactions/${A.transaction}`, data: { x: 1 }, ifUnchanged: { [key]: 1 } }] });
      await expectHarmless("query", { path: "transactions", wheres: [{ field: key, op: "==", value: true }] });
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
});

describe("data plane: a session cannot rewrite its own second factor", () => {
  // Not cross-user, but the same failure: a stolen session (password, no
  // second factor) must not be able to switch MFA off or plant a passkey
  // challenge it holds a captured assertion for.
  it("mfaSettings is readable but never writable from the client", async () => {
    await getFirestore().doc(`users/${ATTACKER}/mfaSettings/config`).set({ totpEnabled: true, passkeysEnabled: true });
    const read = await call("get", { path: `users/${ATTACKER}/mfaSettings/config` });
    expect(read.status).toBe(200);
    for (const op of [
      { type: "set", path: `users/${ATTACKER}/mfaSettings/config`, data: { totpEnabled: false }, merge: true },
      { type: "update", path: `users/${ATTACKER}/mfaSettings/config`, data: { passkeysEnabled: false } },
      { type: "delete", path: `users/${ATTACKER}/mfaSettings/config` },
    ]) {
      const r = await call("write", { ops: [op] });
      expect(r.status, `${op.type} -> ${r.text}`).toBe(403);
    }
    const after = await getFirestore().doc(`users/${ATTACKER}/mfaSettings/config`).get();
    expect(after.data()).toMatchObject({ totpEnabled: true, passkeysEnabled: true });
  });

  it("passkeyChallenge is server-only", async () => {
    const write = await call("write", {
      ops: [{ type: "set", path: `users/${ATTACKER}/passkeyChallenge/current`, data: { challenge: "replayed" }, merge: false }],
    });
    expect(write.status).toBe(403);
    const read = await call("get", { path: `users/${ATTACKER}/passkeyChallenge/current` });
    expect(read.status).toBe(403);
  });
});
