/**
 * #626: one-shot repair of the daily limit stored on inbound email addresses.
 *
 * Until #626 the browser wrote these rows with whatever fields it sent, so a
 * User could store a daily limit of their own choosing. No server code ever
 * set one other than DEFAULT_DAILY_LIMIT, so every address is set back to it.
 * Nothing else on the address is touched: the counters are not repaired, since
 * nothing records what they were before a User reset them.
 *
 * Dry run unless `apply` is set. Postgres only: `firebase-admin/firestore`
 * resolves to the self-host shim, and this module is never wired into
 * index.ts, so it cannot touch the retained Firebase project.
 *
 * Idempotent: a repaired address already holds the default, so a second run
 * changes nothing.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getFirestore } from "firebase-admin/firestore";
import { DEFAULT_DAILY_LIMIT } from "../email-inbound/inboundAddressCallables";

export interface RepairInboundDailyLimitsReport {
  addressesScanned: number;
  /** Addresses whose stored limit was not the default. */
  changed: Array<{ id: string; userId: unknown; from: unknown }>;
  /** Path of the pre-write backup, or null on a dry run or with nothing to do. */
  backupPath: string | null;
  applied: boolean;
}

export interface RepairInboundDailyLimitsOptions {
  /** Write the changes. Without it nothing is written and no backup taken. */
  apply?: boolean;
  /** Limit the pass to one User's addresses. */
  userId?: string;
  /** Directory the pre-write backup JSON goes into. Required with `apply`. */
  backupDir?: string;
  log?: (line: string) => void;
}

export async function repairInboundDailyLimits(
  opts: RepairInboundDailyLimitsOptions = {},
): Promise<RepairInboundDailyLimitsReport> {
  const log = opts.log ?? ((m: string) => console.log(m));
  if (opts.apply && !opts.backupDir) {
    throw new Error("backupDir is required when applying");
  }

  const db = getFirestore();
  let query: FirebaseFirestore.Query = db.collection("inboundEmailAddresses");
  if (opts.userId) query = query.where("userId", "==", opts.userId);
  const snap = await query.get();

  const changed: RepairInboundDailyLimitsReport["changed"] = [];
  const refs = new Map<string, (typeof snap.docs)[number]["ref"]>();
  for (const doc of snap.docs) {
    const data = (doc.data() ?? {}) as Record<string, unknown>;
    if (data.dailyLimit !== DEFAULT_DAILY_LIMIT) {
      changed.push({ id: doc.id, userId: data.userId ?? null, from: data.dailyLimit ?? null });
      refs.set(doc.id, doc.ref);
    }
  }

  for (const c of changed) log(`  ${c.id} (user ${String(c.userId)}): dailyLimit ${String(c.from)} -> ${DEFAULT_DAILY_LIMIT}`);

  let backupPath: string | null = null;
  if (opts.apply && changed.length > 0) {
    await fs.mkdir(opts.backupDir!, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = path.join(opts.backupDir!, `inbound-daily-limits-${stamp}.json`);
    await fs.writeFile(
      backupPath,
      JSON.stringify(changed.map((c) => ({ id: c.id, dailyLimit: c.from })), null, 2),
    );
    log(`  backup: ${changed.length} address(es) written to ${backupPath}`);

    for (const c of changed) {
      await refs.get(c.id)!.update({ dailyLimit: DEFAULT_DAILY_LIMIT });
    }
  }

  log(
    `  addresses: ${changed.length} ${opts.apply ? "changed" : "would change"} of ${snap.size} scanned` +
      (opts.apply ? "" : " (dry run, nothing written)"),
  );

  return { addressesScanned: snap.size, changed, backupPath, applied: !!opts.apply };
}
