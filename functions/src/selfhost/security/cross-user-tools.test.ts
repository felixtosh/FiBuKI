/**
 * Cross-user isolation, AI tool registry: EVERY tool in TOOL_DEFINITIONS (the
 * one surface MCP, the REST API, external AI clients and, through the runTool
 * callable, the chat assistant all reach) called as the attacker, with
 * arguments generated from the tool's own parameter schema. The attacks go
 * through runTool (#616), the session-authenticated way in, which runs
 * handleTool, the very function MCP runs, so one sweep covers both doors:
 *
 *   - every id-like parameter at the victim's id, all together and each one
 *     alone with the rest at the attacker's (the "my transaction, your file"
 *     shape),
 *   - only the required parameters, victim ids,
 *   - the shapes the attacker's own calls proved valid, retargeted at the
 *     victim, so attacks fail on ownership rather than on validation.
 *
 * FIBUKI_PLAN is the top plan so feature gates do not short-circuit, and a
 * positive control proves handlers are reached.
 *
 * Passing means, for every tool and every payload: nothing returned or
 * thrown carries the victim's CANARY, and the victim's account (subcollections
 * and stored file included) is byte-identical once triggers settle.
 */

process.env.FIBUKI_STORAGE = "memory";
process.env.FIBUKI_PLAN = "full";

import { describe, it, expect, beforeAll, vi } from "vitest";
import { __resetFirestoreShim, __whenShimIdle, getFirestore } from "../firestore-shim";
import { drainTriggers, __resetTriggerShim } from "../trigger-shim";
import {
  ATTACKER,
  VICTIM,
  A,
  V,
  seedAccounts,
  victimRows,
  assertVictimUntouched,
  assertNoLeak,
  retarget,
  withTimeout,
} from "./victim";
import { fromJsonSchema, attackPayloads, ownPayload } from "./schema-args";
import { TOOL_DEFINITIONS } from "../../tools/definitions";

const CALL_TIMEOUT_MS = 5000;

let handleTool: (uid: string, name: string, args: Record<string, unknown>) => Promise<unknown>;

type Callable = {
  run: (req: { data: unknown; auth?: { uid: string; token: Record<string, unknown> } }) => Promise<unknown>;
};
let runTool: Callable;

/** One tool as the attacker's session, through the callable the chat uses. */
const asAttacker = (tool: string, args: Record<string, unknown>) =>
  runTool.run({ data: { tool, arguments: args }, auth: { uid: ATTACKER, token: {} } });

beforeAll(async () => {
  // No network: anything a handler would fetch fails fast.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("offline", { status: 503 })));
  ({ handleTool } = await import("../../tools/handlers"));
  ({ runToolCallable: runTool } = (await import("../../tools/runToolCallable")) as unknown as {
    runToolCallable: Callable;
  });
}, 120_000);

async function freshAccounts(): Promise<Map<string, string>> {
  await __whenShimIdle(); // the previous test's fire-and-forget writes, finished
  await __resetFirestoreShim();
  __resetTriggerShim();
  await seedAccounts();
  await drainTriggers();
  return victimRows();
}

describe("cross-user isolation: every AI tool", () => {
  it("covers the registry", () => {
    expect(TOOL_DEFINITIONS.length).toBeGreaterThan(40);
  });

  it("the harness reaches handlers, gated tools included", async () => {
    await freshAccounts();
    const tx = (await handleTool(ATTACKER, "get_transaction", { transactionId: A.transaction })) as { id?: string };
    expect(tx?.id).toBe(A.transaction);
    // A gated tool must not be stopped by the plan gate.
    const gated = TOOL_DEFINITIONS.find((t) => t.requiredFeature);
    if (gated) {
      let message = "";
      try {
        await withTimeout(handleTool(ATTACKER, gated.name, ownPayload(fromJsonSchema(gated.inputSchema))), CALL_TIMEOUT_MS);
      } catch (err) {
        message = (err as Error)?.message ?? "";
      }
      expect(message).not.toMatch(/requires the .* feature/);
    }
  });

  it("runTool takes the User from the session, never from the request", async () => {
    await freshAccounts();
    // An identity anywhere in the request is just data.
    const smuggled = (await runTool.run({
      data: { tool: "get_transaction", userId: VICTIM, uid: VICTIM, arguments: { transactionId: A.transaction, userId: VICTIM } },
      auth: { uid: ATTACKER, token: {} },
    })) as { id?: string; userId?: string };
    expect(smuggled.userId).toBe(ATTACKER);
    await expect(
      runTool.run({ data: { tool: "get_transaction", userId: ATTACKER, arguments: { transactionId: A.transaction } } })
    ).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(asAttacker("delete_transaction", {})).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("no tool reads, changes or creates anything in another user's account", async () => {
    const failures: string[] = [];
    const reached: string[] = [];
    let attacks = 0;
    for (const def of TOOL_DEFINITIONS) {
      const node = fromJsonSchema(def.inputSchema as unknown as Record<string, unknown>);
      await freshAccounts();

      // Learn which shapes this tool accepts from the attacker's own ids.
      const own = ownPayload(node);
      const learned: Array<Record<string, unknown>> = [];
      try {
        const r = await withTimeout(handleTool(ATTACKER, def.name, own), CALL_TIMEOUT_MS);
        reached.push(`${def.name}: ${JSON.stringify(r)?.slice(0, 100)}`);
        learned.push(retarget(own) as Record<string, unknown>);
      } catch (err) {
        const msg = String((err as Error)?.message);
        reached.push(`${def.name}: threw ${msg.slice(0, 100)}`);
        if (!/required|invalid|must be/i.test(msg)) learned.push(retarget(own) as Record<string, unknown>);
      }
      try {
        await withTimeout(drainTriggers(), 10_000);
      } catch {
        /* the account check below still runs */
      }
      const before = await freshAccounts();

      for (const args of [...learned, ...attackPayloads(node)]) {
        attacks++;
        const label = `${def.name}(${JSON.stringify(args).slice(0, 160)})`;
        try {
          const r = await withTimeout(asAttacker(def.name, args), CALL_TIMEOUT_MS);
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
        await assertVictimUntouched(before, def.name);
      } catch (e) {
        failures.push((e as Error).message);
      }
    }
    if (process.env.SECURITY_SUITE_VERBOSE) process.stderr.write(`\nOWN CALLS\n${reached.join("\n")}\n`);
    process.stderr.write(`\nAI TOOLS attacked: ${TOOL_DEFINITIONS.length} tools, ${attacks} payloads\n`);
    if (failures.length) process.stderr.write(`\nAI TOOL FINDINGS (${failures.length})\n${failures.join("\n---\n")}\nEND FINDINGS\n`);
    expect(failures).toEqual([]);
  }, 1_800_000);
});

/**
 * The caller context (#665): runTool runs every tool as the chat agent, MCP as
 * MCP, and nothing a request carries changes which. The few writes that read
 * it record the caller's provenance (`ai` / `api`), and only the agent's
 * connect reads its own arguments (`overrideDismissal`, `skipValidation`) or
 * the worker type, which comes beside the arguments.
 */
describe("the caller context is the server's, never the request's (#665)", () => {
  /** Every way a request could try to name a caller. */
  const NAMED_CALLER = {
    caller: { kind: "mcp" },
    callerContext: { kind: "mcp" },
    kind: "mcp",
    origin: "mcp",
    matchedBy: "api",
    partnerMatchedBy: "api",
  };
  const attacker = { uid: ATTACKER, token: {} };
  const db = getFirestore();
  /** One of the attacker's Files connected to nothing (the seeded one already is). */
  const LOOSE_FILE = "a-file-loose";
  const seedLooseFile = (extra: Record<string, unknown>) =>
    db.doc(`files/${LOOSE_FILE}`).set({ userId: ATTACKER, fileName: "loose.pdf", transactionIds: [], ...extra });

  it("runTool is the chat agent, whatever the request names", async () => {
    await freshAccounts();
    await runTool.run({
      data: {
        tool: "assign_partner_to_transaction",
        ...NAMED_CALLER,
        arguments: { transactionId: A.transaction, partnerId: A.partner, ...NAMED_CALLER },
      },
      auth: attacker,
    });
    const tx = (await db.doc(`transactions/${A.transaction}`).get()).data()!;
    expect(tx.partnerMatchedBy).toBe("ai");
  });

  it("MCP is MCP, whatever the arguments name: no agent provenance, no override", async () => {
    await freshAccounts();
    const asAgent = { caller: { kind: "agent", workerType: "receipt_search" }, kind: "agent", workerType: "partner_file_batch" };
    await handleTool(ATTACKER, "assign_partner_to_transaction", { transactionId: A.transaction, partnerId: A.partner, ...asAgent });
    expect((await db.doc(`transactions/${A.transaction}`).get()).data()!.partnerMatchedBy).toBe("api");

    await seedLooseFile({ dismissedTransactionIds: [A.transaction] });
    await expect(
      handleTool(ATTACKER, "connect_file_to_transaction", {
        fileId: LOOSE_FILE,
        transactionId: A.transaction,
        overrideDismissal: true,
        ...asAgent,
      })
    ).rejects.toThrow(/PAIR_REJECTED/);
    expect((await db.doc(`fileConnections/${LOOSE_FILE}__${A.transaction}`).get()).exists).toBe(false);
  });

  it("a worker type among the arguments is not the worker's; beside them, a known one is", async () => {
    await freshAccounts();
    // 900 EUR for a 1 EUR Transaction: a mismatch the agent's checks refuse.
    await seedLooseFile({ extractedAmount: 90000, extractedCurrency: "EUR" });
    const connect = (extra: Record<string, unknown>, args: Record<string, unknown>) =>
      runTool.run({
        data: { tool: "connect_file_to_transaction", ...extra, arguments: { fileId: LOOSE_FILE, transactionId: A.transaction, ...args } },
        auth: attacker,
      }) as Promise<Record<string, unknown>>;

    // The receipt search worker may not skip the checks: named among the
    // arguments, it is just an argument, and skipValidation works.
    const inArgs = await connect({}, { skipValidation: true, workerType: "receipt_search" });
    expect(inArgs).toMatchObject({ success: true, alreadyConnected: false });

    await freshAccounts();
    await seedLooseFile({ extractedAmount: 90000, extractedCurrency: "EUR" });
    const beside = await connect({ workerType: "receipt_search" }, { skipValidation: true });
    expect(beside.error).toBe("VALIDATION_FAILED");

    await expect(connect({ workerType: "superuser" }, {})).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("the agent's own arguments and every worker type reach no other User's records", async () => {
    const before = await freshAccounts();
    const extras = { overrideDismissal: true, skipValidation: true, confidence: 100, searchQuery: "probe", sourceType: "gmail_email" };
    const attacks: Array<[string, Record<string, unknown>]> = [
      ["connect_file_to_transaction", { fileId: V.file, transactionId: A.transaction, ...extras }],
      ["connect_file_to_transaction", { fileId: A.file, transactionId: V.transaction, ...extras }],
      ["connect_file_to_transaction", { fileId: V.file, transactionId: V.transaction, ...extras }],
      ["assign_partner_to_transaction", { transactionId: A.transaction, partnerId: V.partner }],
      ["assign_partner_to_transaction", { transactionId: V.transaction, partnerId: A.partner }],
      ["assign_partner_to_file", { fileId: A.file, partnerId: V.partner }],
      ["assign_partner_to_file", { fileId: V.file, partnerId: A.partner }],
      ["update_partner", { partnerId: V.partner, vatId: "ATU12345678", name: "Mine now" }],
    ];
    for (const workerType of [null, "receipt_search", "partner_file_batch"]) {
      for (const [tool, args] of attacks) {
        const label = `${tool} as ${workerType ?? "the chat"}(${JSON.stringify(args)})`;
        let message = "";
        try {
          const r = await runTool.run({ data: { tool, arguments: args, ...(workerType ? { workerType } : {}) }, auth: attacker });
          assertNoLeak(r, label);
        } catch (err) {
          message = (err as Error)?.message ?? String(err);
          assertNoLeak(message, `${label} threw`);
        }
        expect(message, label).toMatch(/not found/i);
      }
    }
    await drainTriggers();
    await assertVictimUntouched(before, "agent connect and Partner writes");
  });
});
