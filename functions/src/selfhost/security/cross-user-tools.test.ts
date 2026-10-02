/**
 * Cross-user isolation, AI tool registry: EVERY tool in TOOL_DEFINITIONS (the
 * one surface MCP, the REST API and external AI clients all reach) called
 * through handleTool as the attacker, with arguments generated from the
 * tool's own parameter schema:
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
import { __resetFirestoreShim } from "../firestore-shim";
import { drainTriggers, __resetTriggerShim } from "../trigger-shim";
import {
  ATTACKER,
  A,
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

beforeAll(async () => {
  // No network: anything a handler would fetch fails fast.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("offline", { status: 503 })));
  ({ handleTool } = await import("../../tools/handlers"));
}, 120_000);

async function freshAccounts(): Promise<Map<string, string>> {
  await new Promise((r) => setTimeout(r, 20));
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
          const r = await withTimeout(handleTool(ATTACKER, def.name, args), CALL_TIMEOUT_MS);
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
