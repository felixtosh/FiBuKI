/**
 * Cross-user isolation, callables: EVERY callable the API host mounts, called
 * as the attacker with the victim's ids in every parameter an entry point
 * could take, alone and in combination with the attacker's own ids (the
 * classic hole is a handler that checks one side of a pair: "my transaction"
 * plus "your file").
 *
 * Driven off the barrel, not a list, so a callable added tomorrow is attacked
 * tomorrow without anyone remembering to add it here.
 *
 * Passing means, for every callable and every payload:
 *   - nothing returned or thrown carries the victim's CANARY, and
 *   - the victim's account is byte-identical, storage included, after every
 *     trigger the calls set off has run.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeAll } from "vitest";
import { __resetFirestoreShim, getFirestore, __whenShimIdle } from "../firestore-shim";
import { drainTriggers, __resetTriggerShim } from "../trigger-shim";
import {
  ATTACKER,
  A,
  V,
  VICTIM,
  ALL_VICTIM_IDS,
  seedAccounts,
  victimRows,
  assertVictimUntouched,
  assertNoLeak,
  victimValueFor,
  attackerValueFor,
  retarget,
  withTimeout,
} from "./victim";

type Callable = ((...a: unknown[]) => unknown) & {
  __selfhostCallable: true;
  run: (req: { data: unknown; auth?: { uid: string; token: Record<string, unknown> } }) => Promise<unknown>;
};

const ATTACKER_AUTH = { uid: ATTACKER, token: { email: "attacker@attacker.test", email_verified: true } };
const CALL_TIMEOUT_MS = 4000;

/** Parameter names entry points use for ids and identity. */
const ID_KEYS = [
  "id", "ids", "docId", "documentId",
  "transactionId", "transactionIds", "txId",
  "fileId", "fileIds", "originalFileId", "invoiceFileId", "otherFileId",
  "partnerId", "partnerIds", "sourcePartnerId", "targetPartnerId",
  "sourceId", "sourceIds", "accountId",
  "categoryId", "noReceiptCategoryId",
  "importId", "importJobId",
  "integrationId", "emailIntegrationId",
  "invoiceId",
  "connectionId",
  "sessionId", "chatSessionId",
  "notificationId",
  "keyId", "apiKeyId",
  "storagePath", "downloadUrl", "path",
  "userId", "uid", "targetUserId", "ownerId",
];

/**
 * Payload shapes aimed at the attacker's OWN account. Whatever a callable
 * accepts here is a correctly shaped request for it, which `retarget` then
 * points at the victim: an attack that fails ownership, not validation.
 */
function ownPayloads(): Array<Record<string, unknown>> {
  const all: Record<string, unknown> = {};
  for (const k of ID_KEYS) all[k] = attackerValueFor(k);
  return [
    all,
    ...ID_KEYS.map((k) => ({ [k]: attackerValueFor(k) })),
    { id: A.transaction, data: { description: "probe" } },
    // #621: the Transaction update callables take only their callers' fields.
    { id: A.transaction, data: { foreignSupplyKind: "goods" } },
    { ids: [A.transaction], data: { description: "probe" } },
    { ids: [A.transaction], data: { partnerId: A.partner, partnerType: "user" } },
    { ids: [A.transaction], data: { noReceiptCategoryId: A.category } },
    { id: A.file, data: { fileName: "probe.pdf" } },
    { id: A.partner, data: { name: "probe" } },
    { transactionId: A.transaction, updates: { description: "probe" } },
    { fileId: A.file, transactionId: A.transaction },
    { partnerId: A.partner, transactionId: A.transaction },
    { partnerId: A.partner, fileId: A.file },
    { categoryId: A.category, transactionId: A.transaction },
    { transactionIds: [A.transaction] },
    { fileIds: [A.file] },
    { partnerIds: [A.partner] },
    { sourceId: A.source, transactions: [{ sourceId: A.source, amount: -1, name: "probe", date: new Date().toISOString(), dedupeHash: "probe" }] },
    { invoiceId: A.invoice },
    { sessionId: A.chat },
  ];
}

/**
 * The attacker's OWN rows, with the owner rewritten to the victim (#621).
 * Ownership checks pass, since the row is the attacker's; what has to refuse
 * is the field list. A row handed over this way lands in the victim's list,
 * UVA period and BMD export, which is a change to the victim's account.
 */
function handOverPayloads(): Array<Record<string, unknown>> {
  const handOver = { userId: VICTIM };
  const all: Record<string, unknown> = {};
  for (const k of ID_KEYS) all[k] = attackerValueFor(k);
  return [
    { ...all, data: handOver, updates: handOver },
    ...ID_KEYS.map((k) => ({ [k]: attackerValueFor(k), data: handOver, updates: handOver })),
    // Smuggled beside a field the callable does write.
    { id: A.transaction, data: { foreignSupplyKind: "goods", userId: VICTIM } },
    { ids: [A.transaction], data: { isComplete: true, userId: VICTIM } },
    { transactionId: A.transaction, updates: { description: "mine", userId: VICTIM } },
    { fileId: A.file, data: { fileName: "mine.pdf", userId: VICTIM } },
    { partnerId: A.partner, data: { name: "Mine", userId: VICTIM } },
    { categoryId: A.category, data: { name: "Mine", userId: VICTIM } },
    { sourceId: A.source, data: { name: "Mine", userId: VICTIM } },
    { invoiceId: A.invoice, data: { recipientName: "Mine", userId: VICTIM } },
  ];
}

function payloads(): Array<Record<string, unknown>> {
  const all: Record<string, unknown> = {};
  for (const k of ID_KEYS) all[k] = victimValueFor(k);
  const out: Array<Record<string, unknown>> = [
    {},
    all,
    ...ID_KEYS.map((k) => ({ [k]: victimValueFor(k) })),
    // Mutations wrapped the way callables take them.
    { id: V.transaction, data: { name: "pwned", userId: ATTACKER } },
    { transactionId: V.transaction, updates: { name: "pwned", userId: ATTACKER } },
    { fileId: V.file, data: { fileName: "pwned", userId: ATTACKER } },
    { partnerId: V.partner, data: { name: "pwned", userId: ATTACKER } },
    // One side mine, one side theirs: each pair both ways round.
    { fileId: V.file, transactionId: A.transaction },
    { fileId: A.file, transactionId: V.transaction },
    { partnerId: V.partner, transactionId: A.transaction },
    { partnerId: A.partner, transactionId: V.transaction },
    { partnerId: A.partner, fileId: V.file },
    // #162: a Copy and its original, each side someone else's.
    { fileId: V.file, originalFileId: A.file },
    { fileId: A.file, originalFileId: V.file },
    // #571: a Receipt and the invoice it pays, each side someone else's.
    { fileId: V.file, invoiceFileId: A.file },
    { fileId: A.file, invoiceFileId: V.file },
    { fileId: A.file, otherFileId: V.file },
    { fileId: V.file, otherFileId: A.file },
    { sourcePartnerId: V.partner, targetPartnerId: A.partner },
    { sourcePartnerId: A.partner, targetPartnerId: V.partner },
    { categoryId: V.category, transactionId: A.transaction },
    { transactionIds: [A.transaction, V.transaction], fileIds: [A.file, V.file] },
    // Writing INTO the victim's account from the attacker's side.
    { sourceId: V.source, transactions: [{ sourceId: V.source, amount: -1, name: "planted", date: new Date().toISOString(), dedupeHash: "x" }] },
    { userId: VICTIM, name: "planted", data: { userId: VICTIM } },
    // Every id at once, in arrays, in case a handler takes "ids" generically.
    { ids: ALL_VICTIM_IDS, items: ALL_VICTIM_IDS.map((id) => ({ id })) },
  ];
  return out;
}

const barrelPromise = import("../../index");

let callables: Array<[string, Callable]> = [];

beforeAll(async () => {
  const barrel = (await barrelPromise) as Record<string, unknown>;
  callables = Object.entries(barrel).filter(
    (e): e is [string, Callable] => typeof e[1] === "function" && "__selfhostCallable" in (e[1] as object),
  );
}, 120_000);

async function freshAccounts(): Promise<Map<string, string>> {
  await __whenShimIdle(); // the previous test's fire-and-forget writes, finished
  await __resetFirestoreShim();
  __resetTriggerShim();
  await seedAccounts();
  await drainTriggers();
  return victimRows();
}

describe("cross-user isolation: every callable", () => {
  it("covers the whole barrel", () => {
    // A barrel that failed to load would make every case below vacuous.
    expect(callables.length).toBeGreaterThan(100);
  });

  it("the harness reaches handlers: the attacker can change their own data", async () => {
    await freshAccounts();
    const update = callables.find(([n]) => n === "updateTransaction")?.[1];
    expect(update).toBeDefined();
    await update!.run({ data: { id: A.transaction, data: { foreignSupplyKind: "service" } }, auth: ATTACKER_AUTH });
    const mine = await getFirestore().doc(`transactions/${A.transaction}`).get();
    expect(mine.data()?.foreignSupplyKind).toBe("service");
  });

  it("refuses to set what another user's 0% sale is (#565)", async () => {
    const before = await freshAccounts();
    const update = callables.find(([n]) => n === "updateTransaction")?.[1];
    await expect(
      update!.run({
        data: { id: V.transaction, data: { saleSupplyKind: "service-non-eu" } },
        auth: ATTACKER_AUTH,
      })
    ).rejects.toThrow();
    await drainTriggers();
    await assertVictimUntouched(before, "updateTransaction saleSupplyKind");
  });

  it("no callable hands the attacker's own row to another user (#621)", async () => {
    const failures: string[] = [];
    for (const [name, fn] of callables) {
      const before = await freshAccounts();
      for (const data of handOverPayloads()) {
        try {
          await withTimeout(fn.run({ data, auth: ATTACKER_AUTH }), CALL_TIMEOUT_MS);
        } catch {
          // Refused: what this case wants. The account check below decides.
        }
      }
      try {
        await withTimeout(drainTriggers(), 10_000);
      } catch {
        /* the account check still runs */
      }
      try {
        await assertVictimUntouched(before, name);
      } catch (e) {
        failures.push((e as Error).message);
      }
    }
    if (failures.length) process.stderr.write(`\nHAND-OVER FINDINGS (${failures.length})\n${failures.join("\n---\n")}\nEND FINDINGS\n`);
    expect(failures).toEqual([]);
  }, 1_800_000);

  it("no callable reads, changes or creates anything in another user's account", async () => {
    const failures: string[] = [];
    const timeouts: string[] = [];
    const loops: string[] = [];
    let shapeValid = 0;
    const outcomes = new Map<string, number>();
    const tally = (k: string) => outcomes.set(k, (outcomes.get(k) ?? 0) + 1);
    for (const [name, fn] of callables) {
      let before = await freshAccounts();
      const learned: Array<Record<string, unknown>> = [];
      for (const own of ownPayloads()) {
        try {
          const r = await withTimeout(fn.run({ data: own, auth: ATTACKER_AUTH }), CALL_TIMEOUT_MS);
          if (r !== "timeout") learned.push(retarget(own) as Record<string, unknown>);
        } catch (err) {
          const code = (err as { code?: string })?.code;
          // Rejected on its shape: not a template. Anything else (not found,
          // precondition, internal) got past validation, so the shape is real.
          if (code !== "invalid-argument" && code !== "unauthenticated" && code !== "permission-denied") {
            learned.push(retarget(own) as Record<string, unknown>);
          }
        }
      }
      shapeValid += learned.length;
      if (learned.length) {
        // The probes may have changed the attacker's own data; start the
        // attack itself from clean accounts so nothing carries over.
        try {
          await withTimeout(drainTriggers(), 10_000);
        } catch {
          /* reported below if it recurs */
        }
        before = await freshAccounts();
      }
      for (const data of [...learned, ...payloads()]) {
        const label = `${name}(${JSON.stringify(data).slice(0, 120)})`;
        try {
          const result = await withTimeout(fn.run({ data, auth: ATTACKER_AUTH }), CALL_TIMEOUT_MS);
          if (result === "timeout") {
            timeouts.push(label);
            tally("timeout");
          } else {
            tally("ok");
            assertNoLeak(result, label);
          }
        } catch (err) {
          tally(String((err as { code?: string })?.code ?? "error"));
          try {
            assertNoLeak((err as Error)?.message ?? err, `${label} threw`);
          } catch (leak) {
            failures.push((leak as Error).message);
          }
          if ((err as Error)?.message?.includes("victim data reached")) failures.push((err as Error).message);
        }
      }
      try {
        await withTimeout(drainTriggers(), 10_000);
      } catch (e) {
        // Not an isolation failure in itself, but worth knowing: it names the
        // callable whose triggers did not settle. The account check still runs.
        loops.push(`${name}: ${(e as Error).message}`);
      }
      try {
        await assertVictimUntouched(before, name);
      } catch (e) {
        failures.push((e as Error).message);
      }
    }
    process.stderr.write(`\nOUTCOMES ${JSON.stringify(Object.fromEntries(outcomes))} shape-valid attacks: ${shapeValid}\n`);
    if (loops.length) process.stderr.write(`\nTRIGGER LOOPS\n${loops.join("\n")}\nEND LOOPS\n`);
    if (timeouts.length) console.warn(`cross-user: ${timeouts.length} calls timed out (still checked for side effects):\n  ${timeouts.slice(0, 20).join("\n  ")}`);
    if (failures.length) process.stderr.write(`\nCROSS-USER FINDINGS (${failures.length})\n${failures.join("\n---\n")}\nEND FINDINGS\n`);
    expect(failures).toEqual([]);
  }, 1_800_000);
});
