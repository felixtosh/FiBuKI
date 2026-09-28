/**
 * #266: one-shot backfill that decodes HTML character references in the
 * names and aliases of Partners stored before extraction decoded them
 * (#233, #299). Without it the next clean extraction of "AL&FA Taxi KG"
 * lands beside the stored "AL&amp;FA Taxi KG" and the user gets two Partners
 * for one business.
 *
 * What to write is decided by `planPartnerNameDecode`, shared with the
 * per-user callable, which uses the decoder extraction uses. A name with no
 * character reference, bare "&" included, is never written.
 *
 * Dry run unless `apply` is set. Postgres only, for the reasons spelled out
 * in migrate-strip-line-item-fields.ts: `firebase-admin/firestore` resolves
 * to the self-host shim, and this module is never wired into index.ts, so it
 * cannot touch the retained Firebase project (#227).
 *
 * Idempotent: every rewritten Partner is stamped `nameEntitiesDecodedAt`,
 * and a stamped Partner is skipped, so a double-encoded name loses one layer
 * once and a second run writes nothing.
 *
 * A backup of every name and alias list about to change is written before
 * any update is issued.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import {
  PARTNER_NAME_DECODED_MARKER,
  planPartnerNameDecode,
  unhandledReferences,
} from "../partners/partnerNameEntities";

export interface PartnerNameChange {
  id: string;
  userId: unknown;
  before: { name: unknown; aliases: unknown };
  after: { name: unknown; aliases: unknown };
}

export interface DecodePartnerNameEntitiesReport {
  partnersScanned: number;
  /** Partners whose name or aliases changed (or would, on a dry run). */
  changes: PartnerNameChange[];
  /**
   * Partners that, once decoded, share their name with another Partner of
   * the same user: the duplicates this backfill exists to surface. Reported
   * for a Merge, never merged here.
   */
  collisions: Array<{ id: string; name: string; otherIds: string[] }>;
  /** Names or aliases still holding a reference the decoder leaves alone. */
  unhandled: Array<{ id: string; values: string[] }>;
  /** Path of the pre-write backup, or null on a dry run or with nothing to do. */
  backupPath: string | null;
  applied: boolean;
}

export interface DecodePartnerNameEntitiesOptions {
  /** Write the changes. Without it nothing is written and no backup taken. */
  apply?: boolean;
  /** Limit the pass to one tenant's Partners. */
  userId?: string;
  /** Directory the pre-write backup JSON goes into. Required with `apply`. */
  backupDir?: string;
  log?: (line: string) => void;
}

const nameKey = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : null);

export async function decodePartnerNameEntities(
  opts: DecodePartnerNameEntitiesOptions = {},
): Promise<DecodePartnerNameEntitiesReport> {
  const log = opts.log ?? ((m: string) => console.log(m));
  if (opts.apply && !opts.backupDir) {
    throw new Error("backupDir is required when applying");
  }

  const db = getFirestore();
  const collection = db.collection("partners");
  const snap = opts.userId
    ? await collection.where("userId", "==", opts.userId).get()
    : await collection.get();

  const changes: PartnerNameChange[] = [];
  const unhandled: DecodePartnerNameEntitiesReport["unhandled"] = [];
  const updates: Array<{ ref: (typeof snap.docs)[number]["ref"]; data: Record<string, unknown> }> = [];
  // userId -> name key -> partner ids, over names as they will be after the pass.
  const namesByUser = new Map<unknown, Map<string, string[]>>();

  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown> | undefined;
    const plan = planPartnerNameDecode(data);

    const leftover = unhandledReferences(data, plan);
    if (leftover.length > 0) unhandled.push({ id: doc.id, values: leftover });

    const finalName = nameKey(plan?.name ?? data?.name);
    if (finalName) {
      const byName = namesByUser.get(data?.userId) ?? new Map<string, string[]>();
      byName.set(finalName, [...(byName.get(finalName) ?? []), doc.id]);
      namesByUser.set(data?.userId, byName);
    }

    if (!plan) continue;

    const update: Record<string, unknown> = {
      [PARTNER_NAME_DECODED_MARKER]: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (plan.name !== undefined) update.name = plan.name;
    if (plan.aliases !== undefined) update.aliases = plan.aliases;

    changes.push({
      id: doc.id,
      userId: data?.userId,
      before: plan.before,
      after: { name: plan.name ?? plan.before.name, aliases: plan.aliases ?? plan.before.aliases },
    });
    updates.push({ ref: doc.ref, data: update });
  }

  const collisions: DecodePartnerNameEntitiesReport["collisions"] = [];
  for (const change of changes) {
    if (change.before.name === change.after.name) continue;
    const key = nameKey(change.after.name);
    const ids = key ? namesByUser.get(change.userId)?.get(key) ?? [] : [];
    const otherIds = ids.filter((id) => id !== change.id);
    if (otherIds.length > 0) {
      collisions.push({ id: change.id, name: change.after.name as string, otherIds });
    }
  }

  for (const c of changes) {
    log(`  ${c.id} (user ${String(c.userId)}): ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`);
  }
  for (const c of collisions) {
    log(`  collision: ${c.id} decodes to "${c.name}", also held by ${c.otherIds.join(", ")} (candidate for a Merge)`);
  }
  for (const u of unhandled) {
    log(`  unhandled reference on ${u.id}: ${JSON.stringify(u.values)}`);
  }

  let backupPath: string | null = null;
  if (opts.apply && changes.length > 0) {
    await fs.mkdir(opts.backupDir!, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = path.join(opts.backupDir!, `decode-partner-name-entities-${stamp}.json`);
    await fs.writeFile(
      backupPath,
      JSON.stringify(changes.map((c) => ({ id: c.id, ...c.before })), null, 2),
    );
    log(`  backup: ${changes.length} partner(s) written to ${backupPath}`);

    for (const u of updates) {
      await u.ref.update(u.data);
    }
  }

  log(
    `  partners: ${changes.length}/${snap.size} changed, ${collisions.length} collision(s), ` +
      `${unhandled.length} with unhandled references` +
      (opts.apply ? "" : " (dry run, nothing written)"),
  );

  return {
    partnersScanned: snap.size,
    changes,
    collisions,
    unhandled,
    backupPath,
    applied: !!opts.apply,
  };
}
