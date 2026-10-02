/**
 * Admin-only callables must decide "admin" from something the caller cannot
 * write.
 *
 * users/{uid} is the caller's own document on the client data plane
 * (USER_DOC_POLICY: create and update when the uid matches), so an admin
 * check that reads a flag from it is a check the caller answers for
 * themselves. The admin bit lives in the verified token's claims.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { __resetFirestoreShim, getFirestore, Timestamp } from "../firestore-shim";
import { drainTriggers, __resetTriggerShim } from "../trigger-shim";
import { createDataPlane } from "../data-plane";
import { ATTACKER, VICTIM, CANARY, seedAccounts, victimRows, assertVictimUntouched, assertNoLeak } from "./victim";

type Callable = { run: (req: { data: unknown; auth?: { uid: string; token: Record<string, unknown> } }) => Promise<unknown> };

const ATTACKER_AUTH = { uid: ATTACKER, token: { email: "attacker@attacker.test" } };
// A token with no email at all, against a deployment with no SUPER_ADMIN_EMAIL:
// undefined === undefined must not make anyone a super admin.
const NO_EMAIL_AUTH = { uid: ATTACKER, token: {} };
const ADMIN_AUTH = { uid: "admin-1", token: { admin: true, email: "admin@fibuki.test" } };

let barrel: Record<string, Callable>;
let base: string;

beforeAll(async () => {
  delete process.env.SUPER_ADMIN_EMAIL;
  barrel = (await import("../../index")) as unknown as Record<string, Callable>;
  const app = express();
  app.use("/__data", createDataPlane(async (t) => (t === "tok-attacker" ? { uid: ATTACKER, token: {} } : null)));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

let before: Map<string, string>;

beforeEach(async () => {
  await __resetFirestoreShim();
  __resetTriggerShim();
  await seedAccounts();
  // A leftover of a failed source deletion: exactly what cleanup deletes.
  await getFirestore().doc("transactions/v-orphan-1").set({
    userId: VICTIM, sourceId: "v-deleted-src", name: CANARY, amount: -1, date: Timestamp.now(),
  });
  await drainTriggers();
  before = await victimRows();
});

/** The attacker grants themselves every admin-looking flag, through the real data plane. */
async function selfGrantAdmin(): Promise<void> {
  const res = await fetch(`${base}/__data/write`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer tok-attacker" },
    body: JSON.stringify({
      ops: [{ type: "set", path: `users/${ATTACKER}`, data: { admin: true, isAdmin: true, role: "admin" }, merge: true }],
    }),
  });
  expect(res.status, "the data plane lets a user write their own user doc").toBe(200);
}

const ADMIN_CALLS: Array<[string, Record<string, unknown>]> = [
  ["cleanupOrphanedTransactions", { targetUserId: VICTIM, dryRun: true }],
  ["cleanupOrphanedTransactions", { targetUserId: VICTIM, dryRun: false }],
  ["aggregateGlobalInsights", {}],
  ["generatePromotionCandidates", {}],
];

describe("admin-only callables", () => {
  for (const [name, data] of ADMIN_CALLS) {
    it(`${name}(${JSON.stringify(data)}) refuses a user who wrote admin flags into their own user doc`, async () => {
      await selfGrantAdmin();
      for (const auth of [ATTACKER_AUTH, NO_EMAIL_AUTH]) {
        let code: string | undefined;
        try {
          const r = await barrel[name].run({ data, auth });
          assertNoLeak(r, name);
        } catch (err) {
          code = (err as { code?: string }).code;
          assertNoLeak((err as Error).message, name);
        }
        expect(code, `${name} as ${JSON.stringify(auth.token)}`).toBe("permission-denied");
      }
      await drainTriggers();
      await assertVictimUntouched(before, name);
    });
  }

  it("generatePromotionCandidates refuses an anonymous caller", async () => {
    await expect(barrel.generatePromotionCandidates.run({ data: {} })).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("a real admin claim still works", async () => {
    const r = (await barrel.cleanupOrphanedTransactions.run({ data: { targetUserId: VICTIM, dryRun: true }, auth: ADMIN_AUTH })) as {
      orphanedCount: number;
    };
    expect(r.orphanedCount).toBe(1);
    await expect(barrel.generatePromotionCandidates.run({ data: {}, auth: ADMIN_AUTH })).resolves.toBeDefined();
    await expect(barrel.aggregateGlobalInsights.run({ data: {}, auth: ADMIN_AUTH })).resolves.toBeDefined();
  });
});
