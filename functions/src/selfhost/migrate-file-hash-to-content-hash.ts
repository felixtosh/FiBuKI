/**
 * #328: one-shot backfill that moves the digest the two Gmail routes stored as
 * `fileHash` onto `contentHash`, the field the write point's duplicate lookup
 * reads (functions/src/files/createFileRecord.ts). Until it runs, a receipt
 * imported from Gmail is invisible to that lookup, so the same bytes uploaded
 * by hand land as a second File.
 *
 * Both fields are the sha256 hex of the stored bytes, so the value moves
 * unchanged. A File holding two different digests is reported and left alone.
 *
 * Files that turn out to be byte copies of each other once moved are reported,
 * never merged or deleted here: which copy carries the Transaction connections
 * is the user's call.
 *
 * Dry run unless `apply` is set. Postgres only: `firebase-admin/firestore`
 * resolves to the self-host shim, and this module is never wired into
 * index.ts, so it cannot touch the retained Firebase project.
 *
 * Idempotent: a moved File no longer holds `fileHash`, so a second run finds
 * nothing to do.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

export interface MigrateFileHashReport {
  filesScanned: number;
  /** Files whose `fileHash` became their `contentHash`. */
  moved: string[];
  /** Files that already held the same `contentHash`; only the old field goes. */
  dropped: string[];
  /** Files holding two different digests, left as stored. */
  conflicts: Array<{ id: string; fileHash: string; contentHash: string }>;
  /** Byte copies within one tenant once the pass is done, for the user to resolve. */
  duplicates: Array<{ userId: string; contentHash: string; ids: string[] }>;
  /** Path of the pre-write backup, or null on a dry run or with nothing to do. */
  backupPath: string | null;
  applied: boolean;
}

export interface MigrateFileHashOptions {
  /** Write the changes. Without it nothing is written and no backup taken. */
  apply?: boolean;
  /** Limit the pass to one tenant's Files. */
  userId?: string;
  /** Directory the pre-write backup JSON goes into. Required with `apply`. */
  backupDir?: string;
  log?: (line: string) => void;
}

const digest = (v: unknown) => (typeof v === "string" && v ? v : null);

export async function migrateFileHashToContentHash(
  opts: MigrateFileHashOptions = {},
): Promise<MigrateFileHashReport> {
  const log = opts.log ?? ((m: string) => console.log(m));
  if (opts.apply && !opts.backupDir) {
    throw new Error("backupDir is required when applying");
  }

  const db = getFirestore();
  const collection = db.collection("files");
  const snap = opts.userId
    ? await collection.where("userId", "==", opts.userId).get()
    : await collection.get();

  const moved: string[] = [];
  const dropped: string[] = [];
  const conflicts: MigrateFileHashReport["conflicts"] = [];
  const backup: Array<{ id: string; fileHash: string; contentHash: string | null }> = [];
  const updates: Array<{ ref: (typeof snap.docs)[number]["ref"]; data: Record<string, unknown> }> = [];
  // userId -> contentHash -> file ids, over digests as they will be after the pass.
  const byDigest = new Map<string, Map<string, string[]>>();

  for (const doc of snap.docs) {
    const data = (doc.data() ?? {}) as Record<string, unknown>;
    const fileHash = digest(data.fileHash);
    const contentHash = digest(data.contentHash);
    let finalHash = contentHash;

    if (fileHash) {
      if (contentHash && contentHash !== fileHash) {
        conflicts.push({ id: doc.id, fileHash, contentHash });
      } else {
        const update: Record<string, unknown> = {
          fileHash: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        };
        if (contentHash) {
          dropped.push(doc.id);
        } else {
          update.contentHash = fileHash;
          moved.push(doc.id);
          finalHash = fileHash;
        }
        backup.push({ id: doc.id, fileHash, contentHash });
        updates.push({ ref: doc.ref, data: update });
      }
    }

    if (finalHash && typeof data.userId === "string") {
      const forUser = byDigest.get(data.userId) ?? new Map<string, string[]>();
      forUser.set(finalHash, [...(forUser.get(finalHash) ?? []), doc.id]);
      byDigest.set(data.userId, forUser);
    }
  }

  const duplicates: MigrateFileHashReport["duplicates"] = [];
  for (const [userId, forUser] of byDigest) {
    for (const [contentHash, ids] of forUser) {
      if (ids.length > 1) duplicates.push({ userId, contentHash, ids: [...ids].sort() });
    }
  }

  for (const id of moved) log(`  ${id}: fileHash -> contentHash`);
  for (const id of dropped) log(`  ${id}: contentHash already set, dropping fileHash`);
  for (const c of conflicts) {
    log(`  conflict: ${c.id} holds fileHash ${c.fileHash} and contentHash ${c.contentHash}, left as stored`);
  }
  for (const d of duplicates) {
    log(`  duplicate: user ${d.userId} holds the same bytes as ${d.ids.join(", ")} (resolve by hand)`);
  }

  let backupPath: string | null = null;
  if (opts.apply && updates.length > 0) {
    await fs.mkdir(opts.backupDir!, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = path.join(opts.backupDir!, `file-hash-to-content-hash-${stamp}.json`);
    await fs.writeFile(backupPath, JSON.stringify(backup, null, 2));
    log(`  backup: ${backup.length} file(s) written to ${backupPath}`);

    for (const u of updates) {
      await u.ref.update(u.data);
    }
  }

  log(
    `  files: ${moved.length} moved, ${dropped.length} dropped, ${conflicts.length} conflict(s), ` +
      `${duplicates.length} duplicate group(s) of ${snap.size} scanned` +
      (opts.apply ? "" : " (dry run, nothing written)"),
  );

  return {
    filesScanned: snap.size,
    moved,
    dropped,
    conflicts,
    duplicates,
    backupPath,
    applied: !!opts.apply,
  };
}
