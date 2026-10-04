/**
 * Cross-user isolation, chat agent tools: EVERY tool the chat assistant and
 * the workers can call (lib/agent/tools ALL_TOOLS), invoked as the attacker
 * with the victim's ids in every parameter the tool's schema declares.
 *
 * The tools take identity from `config.configurable` (userId for their own
 * reads, authHeader for the callables they delegate writes to). Here the
 * authHeader resolves to the attacker and callables run in-process against
 * the same database, so a tool that trusts an id and a callable that trusts
 * one are both caught.
 *
 * Passing means, for every tool and every payload:
 *   - nothing returned or thrown carries the victim's CANARY, and
 *   - the victim's account is byte-identical once triggers settle.
 */

process.env.FIBUKI_STORAGE = "memory";
process.env.FIBUKI_PLAN = "pro";

import { describe, it, expect, beforeAll, vi } from "vitest";
import { __resetFirestoreShim, getFirestore } from "../firestore-shim";
import { drainTriggers, __resetTriggerShim } from "../trigger-shim";
import {
  ATTACKER,
  A,
  V,
  seedAccounts,
  victimRows,
  assertVictimUntouched,
  assertNoLeak,
  retarget,
  withTimeout,
} from "./victim";
import { fromZod, attackPayloads, ownPayload } from "./schema-args";

type Callable = { __selfhostCallable: true; run: (req: { data: unknown; auth?: { uid: string; token: Record<string, unknown> } }) => Promise<unknown> };

const barrelPromise = import("../../index");

// Delegated writes go to the in-process callables as whoever the auth header
// names, which is exactly what the real HTTP hop does after verifying it.
vi.mock("@/lib/api/firebase-callable", () => ({
  callFirebaseFunction: async (name: string, data: unknown, authHeader?: string) => {
    const barrel = (await barrelPromise) as Record<string, unknown>;
    const fn = (barrel[name] ?? barrel[`${name}Callable`]) as Callable | undefined;
    if (!fn || !("__selfhostCallable" in fn)) throw new Error(`no callable ${name}`);
    const uid = (authHeader || "").replace(/^Bearer /, "").replace(/^uid:/, "");
    try {
      return await fn.run({ data, auth: uid ? { uid, token: {} } : undefined });
    } catch (err) {
      // The HTTP client surfaces a callable's failure as an Error message.
      throw new Error((err as Error)?.message ?? String(err));
    }
  },
  lookupCompany: async () => ({ name: "Probe GmbH" }),
  lookupByVatId: async () => ({ name: "Probe GmbH", isValid: false }),
}));

const CONFIG = { configurable: { userId: ATTACKER, authHeader: `Bearer uid:${ATTACKER}`, workerType: "receipt_search" } };
const CALL_TIMEOUT_MS = 5000;

interface AgentTool {
  name: string;
  schema: unknown;
  invoke: (args: unknown, config?: unknown) => Promise<unknown>;
}

let tools: AgentTool[] = [];

beforeAll(async () => {
  // No network: anything a tool would fetch (Gmail, the app's own routes)
  // fails fast and the tool's handling of that failure is what gets checked.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("offline", { status: 503 })));
  await barrelPromise;
  const mod = await import("@/lib/agent/tools");
  tools = (mod.ALL_TOOLS as unknown as AgentTool[]).filter(Boolean);
}, 120_000);

async function freshAccounts(): Promise<Map<string, string>> {
  await __resetFirestoreShim();
  __resetTriggerShim();
  await seedAccounts();
  await drainTriggers();
  return victimRows();
}

describe("cross-user isolation: every chat agent tool", () => {
  it("covers every tool", () => {
    expect(tools.length).toBeGreaterThan(40);
  });

  it("the harness reaches handlers: a tool changes the attacker's own data", async () => {
    await freshAccounts();
    const assign = tools.find((t) => t.name === "assignPartnerToTransaction")!;
    const res = await assign.invoke({ transactionId: A.transaction, partnerId: A.partner }, CONFIG);
    expect(JSON.stringify(res)).toContain("success");
    const mine = await getFirestore().doc(`transactions/${A.transaction}`).get();
    expect(mine.data()?.partnerId).toBe(A.partner);
  });

  it("no tool reads, changes or creates anything in another user's account", async () => {
    const failures: string[] = [];
    let attacks = 0;
    const reached: string[] = [];
    for (const t of tools) {
      const node = fromZod(t.schema);
      const before = await freshAccounts();
      // The attacker's own ids first: what that returns shows the handler is
      // reached at all (logged, so a tool that only ever fails validation is
      // visible rather than silently vacuous).
      try {
        const own = await withTimeout(t.invoke(ownPayload(node), CONFIG), CALL_TIMEOUT_MS);
        reached.push(`${t.name}: ${JSON.stringify(own)?.slice(0, 100)}`);
      } catch (err) {
        reached.push(`${t.name}: threw ${String((err as Error)?.message).slice(0, 100)}`);
      }
      const payloads = [...attackPayloads(node), retarget(ownPayload(node)) as Record<string, unknown>];
      for (const args of payloads) {
        attacks++;
        const label = `${t.name}(${JSON.stringify(args).slice(0, 160)})`;
        try {
          const r = await withTimeout(t.invoke(args, CONFIG), CALL_TIMEOUT_MS);
          assertNoLeak(r, label);
        } catch (err) {
          const msg = (err as Error)?.message ?? String(err);
          if (msg.includes("victim data reached")) failures.push(msg);
          else {
            try {
              assertNoLeak(msg, `${label} threw`);
            } catch (leak) {
              failures.push((leak as Error).message);
            }
          }
        }
      }
      try {
        await withTimeout(drainTriggers(), 10_000);
      } catch {
        /* the account check below still runs */
      }
      try {
        await assertVictimUntouched(before, t.name);
      } catch (e) {
        failures.push((e as Error).message);
      }
    }
    if (process.env.SECURITY_SUITE_VERBOSE) process.stderr.write(`\nOWN CALLS\n${reached.join("\n")}\n`);
    process.stderr.write(`\nAGENT TOOLS attacked: ${tools.length} tools, ${attacks} payloads\n`);
    if (failures.length) process.stderr.write(`\nAGENT TOOL FINDINGS (${failures.length})\n${failures.join("\n---\n")}\nEND FINDINGS\n`);
    expect(failures).toEqual([]);
  }, 1_800_000);
});

/**
 * State that carries no CANARY but is still the victim's: whether their File
 * is deleted, or has rejected a pairing. A tool must answer the same whether
 * or not the victim's File is in that state, or the answer is an oracle.
 */
describe("no oracle on another user's File state", () => {
  async function invoke(name: string, args: unknown): Promise<string> {
    const t = tools.find((x) => x.name === name)!;
    // Generated ids and seed timestamps differ run to run; nothing else may.
    // (listTransactions returns whole records since #616, seed stamps included.)
    return JSON.stringify(await t.invoke(args, CONFIG))
      .replace(/"(connectionId|date)":"[^"]+"/g, "")
      .replace(/"(createdAt|updatedAt)":("[^"]*"|\{[^}]*\})/g, "");
  }

  async function withVictimFile(state: Record<string, unknown>, run: () => Promise<string>): Promise<string> {
    await freshAccounts();
    // The attacker's own transaction naming the victim's file, as a planted
    // write (the attach-route hole) would have left it.
    await getFirestore().doc(`transactions/${A.transaction}`).update({ fileIds: [V.file] });
    if (Object.keys(state).length) await getFirestore().doc(`files/${V.file}`).update(state);
    return run();
  }

  const cases: Array<[string, Record<string, unknown>, () => Promise<string>]> = [
    ["listTransactions / deleted", { deletedAt: new Date() }, () => invoke("listTransactions", {})],
    [
      "scoreBatchMatches / dismissed",
      { dismissedTransactionIds: [A.transaction] },
      () => invoke("scoreBatchMatches", { pairs: [{ fileId: V.file, transactionId: A.transaction }] }),
    ],
    [
      "bulkConnectFiles / dismissed",
      { dismissedTransactionIds: [A.transaction] },
      () => invoke("bulkConnectFiles", { connections: [{ fileId: V.file, transactionId: A.transaction, confidence: 90 }] }),
    ],
  ];
  for (const [label, state, run] of cases) {
    it(label, async () => {
      const plain = await withVictimFile({}, run);
      const marked = await withVictimFile(state, run);
      expect(marked).toBe(plain);
    });
  }
});

describe("updateFile: a File may only point at a usable Partner", () => {
  async function updateFile(data: Record<string, unknown>): Promise<unknown> {
    const barrel = (await barrelPromise) as Record<string, Callable>;
    return barrel.updateFile.run({ data: { fileId: A.file, data }, auth: { uid: ATTACKER, token: {} } });
  }
  const partnerOf = async () => (await getFirestore().doc(`files/${A.file}`).get()).data()?.partnerId;

  it("accepts my own user Partner and a Global Partner", async () => {
    await freshAccounts();
    await getFirestore().doc("globalPartners/g-partner-1").set({ name: "Global GmbH" });
    await updateFile({ partnerId: A.partner, partnerType: "user" });
    expect(await partnerOf()).toBe(A.partner);
    await updateFile({ partnerId: "g-partner-1", partnerType: "global" });
    expect(await partnerOf()).toBe("g-partner-1");
  });

  for (const [label, data] of [
    ["user", { partnerId: V.partner, partnerType: "user" }],
    ["untyped", { partnerId: V.partner }],
    ["claimed global", { partnerId: V.partner, partnerType: "global" }],
    ["missing", { partnerId: "no-such-partner", partnerType: "user" }],
  ] as const) {
    it(`refuses another user's Partner (${label})`, async () => {
      await freshAccounts();
      await expect(updateFile(data)).rejects.toMatchObject({ code: "not-found" });
      expect(await partnerOf()).toBeUndefined();
    });
  }
});
