/**
 * #722: one-shot repair of the size recorded on mail-imported Files.
 *
 * The mail imports wrote the size the Mail Provider reported, and an IMAP
 * server reports the encoded mail part (base64 plus line breaks, about 1.37×).
 * The stored bytes were always right, so the size is read back from the stored
 * object and written onto the File's `fileSize`. Nothing else on the File, and
 * nothing in storage, is touched.
 *
 * A File whose stored object is gone (a purged File) is reported and left as
 * stored.
 *
 * Dry run unless `apply` is set. Postgres only: `firebase-admin/firestore` and
 * `firebase-admin/storage` resolve to the self-host shims, and this module is
 * never wired into index.ts, so it cannot touch the retained Firebase project.
 *
 * Idempotent: a repaired File already records its stored size, so a second run
 * changes nothing.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

export interface RepairMailFileSizesReport {
  filesScanned: number;
  /** Files whose recorded size differed from their stored object's. */
  changed: Array<{ id: string; from: unknown; to: number }>;
  /** Files with no stored object to read a size from, left as stored. */
  missing: string[];
  /** Path of the pre-write backup, or null on a dry run or with nothing to do. */
  backupPath: string | null;
  applied: boolean;
}

export interface RepairMailFileSizesOptions {
  /** Write the changes. Without it nothing is written and no backup taken. */
  apply?: boolean;
  /** Limit the pass to one tenant's Files. */
  userId?: string;
  /** Directory the pre-write backup JSON goes into. Required with `apply`. */
  backupDir?: string;
  log?: (line: string) => void;
}

/** Every mail import path (sync queue, precision search, attach route) writes this. */
const MAIL_SOURCE_TYPE = "gmail";

export async function repairMailFileSizes(
  opts: RepairMailFileSizesOptions = {},
): Promise<RepairMailFileSizesReport> {
  const log = opts.log ?? ((m: string) => console.log(m));
  if (opts.apply && !opts.backupDir) {
    throw new Error("backupDir is required when applying");
  }

  const db = getFirestore();
  const bucket = getStorage().bucket();
  let query = db.collection("files").where("sourceType", "==", MAIL_SOURCE_TYPE);
  if (opts.userId) query = query.where("userId", "==", opts.userId);
  const snap = await query.get();

  const changed: RepairMailFileSizesReport["changed"] = [];
  const missing: string[] = [];
  const refs = new Map<string, (typeof snap.docs)[number]["ref"]>();

  for (const doc of snap.docs) {
    const data = (doc.data() ?? {}) as Record<string, unknown>;
    const storagePath = typeof data.storagePath === "string" ? data.storagePath : "";
    const object = storagePath ? bucket.file(storagePath) : null;
    if (!object || !(await object.exists())[0]) {
      missing.push(doc.id);
      continue;
    }
    const [meta] = await object.getMetadata();
    const stored = Number(meta.size);
    if (!Number.isFinite(stored)) {
      missing.push(doc.id);
      continue;
    }
    if (data.fileSize !== stored) {
      changed.push({ id: doc.id, from: data.fileSize ?? null, to: stored });
      refs.set(doc.id, doc.ref);
    }
  }

  for (const c of changed) log(`  ${c.id}: fileSize ${String(c.from)} -> ${c.to}`);
  for (const id of missing) log(`  ${id}: no stored object, left as stored`);

  let backupPath: string | null = null;
  if (opts.apply && changed.length > 0) {
    await fs.mkdir(opts.backupDir!, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = path.join(opts.backupDir!, `mail-file-sizes-${stamp}.json`);
    await fs.writeFile(
      backupPath,
      JSON.stringify(changed.map((c) => ({ id: c.id, fileSize: c.from })), null, 2),
    );
    log(`  backup: ${changed.length} file(s) written to ${backupPath}`);

    for (const c of changed) {
      await refs.get(c.id)!.update({ fileSize: c.to });
    }
  }

  log(
    `  files: ${changed.length} ${opts.apply ? "changed" : "would change"}, ` +
      `${missing.length} without a stored object, of ${snap.size} scanned` +
      (opts.apply ? "" : " (dry run, nothing written)"),
  );

  return {
    filesScanned: snap.size,
    changed,
    missing,
    backupPath,
    applied: !!opts.apply,
  };
}
