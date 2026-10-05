/**
 * Admin-only callables must decide "admin" from something the caller cannot
 * write.
 *
 * users/{uid} is the caller's own document, and an admin check that reads a
 * flag from it trusts whoever wrote it. The client data plane refuses every
 * write to it (USER_DOC_POLICY, #711), and the admin-only callables read the
 * admin bit from the verified token's claims, never from the user doc.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { __resetFirestoreShim, getFirestore, Timestamp } from "../firestore-shim";
import { drainTriggers, __resetTriggerShim } from "../trigger-shim";
import { ATTACKER, VICTIM, CANARY, seedAccounts, victimRows, assertVictimUntouched, assertNoLeak } from "./victim";
import { startTestDataPlane, type TestServer } from "../test-helpers";

type Callable = { run: (req: { data: unknown; auth?: { uid: string; token: Record<string, unknown> } }) => Promise<unknown> };

const ATTACKER_AUTH = { uid: ATTACKER, token: { email: "attacker@attacker.test" } };
// A token with no email at all, against a deployment with no SUPER_ADMIN_EMAIL:
// undefined === undefined must not make anyone a super admin.
const NO_EMAIL_AUTH = { uid: ATTACKER, token: {} };
const ADMIN_AUTH = { uid: "admin-1", token: { admin: true, email: "admin@fibuki.test" } };

let barrel: Record<string, Callable>;
let base: string;
let server: TestServer;

beforeAll(async () => {
  delete process.env.SUPER_ADMIN_EMAIL;
  barrel = (await import("../../index")) as unknown as Record<string, Callable>;
  server = await startTestDataPlane(async (t) => (t === "tok-attacker" ? { uid: ATTACKER, token: {} } : null));
  base = server.base;
}, 120_000);

afterAll(() => server.close());

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

/**
 * The attacker tries to grant themselves every admin-looking flag through the
 * real data plane, into a user doc that does not exist yet. The data plane
 * refuses it (ADR-0016, #711), so the flags are then planted server-side: the
 * callables must refuse even a user doc that carries them.
 */
async function selfGrantAdmin(): Promise<void> {
  const flags = { admin: true, isAdmin: true, role: "admin" };
  await getFirestore().doc(`users/${ATTACKER}`).delete();
  for (const merge of [false, true]) {
    const res = await fetch(`${base}/__data/write`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-attacker" },
      body: JSON.stringify({ ops: [{ type: "set", path: `users/${ATTACKER}`, data: flags, merge }] }),
    });
    expect(res.status, "the data plane refuses a user creating their own user doc").toBe(403);
  }
  expect((await getFirestore().doc(`users/${ATTACKER}`).get()).exists).toBe(false);
  await getFirestore().doc(`users/${ATTACKER}`).set(flags);
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
