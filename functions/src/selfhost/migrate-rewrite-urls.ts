/**
 * Post-migration step: repoint stored download URLs at the self-host blob plane.
 *
 * ## Why this is a separate step and not part of the import
 *
 * Migrated documents carry absolute `downloadUrl` strings written by the Firebase
 * backend, e.g.
 *
 *   https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<enc-path>?alt=media&token=…
 *
 * The objects themselves migrate correctly (replayed to their verbatim Firebase
 * paths), and `buildDownloadUrl-shim.ts` produces correct URLs for everything the
 * self-host backend writes from now on. But nothing rewrites what already exists,
 * so a migrated file's preview still fetches from Firebase — which fails today
 * with a CORS error (the new host is not an allowed origin on the bucket) and
 * fails permanently once the Firebase project is decommissioned.
 *
 * It is NOT folded into `migrate-import` because `verify` compares every imported
 * document against the dump with an exact deep-equal (migrate-import.ts). Any
 * transformation at import time would make the gate fail, and that gate is worth
 * more than the convenience — it has already caught a real problem. So the order
 * is: import → verify (clean) → this.
 *
 * Idempotent: rewrites only URLs pointing at Firebase Storage, so re-running
 * converges. Safe to run repeatedly.
 *
 * Writes go through the ordinary shim path (DocRef.update), so flattened
 * generated columns and canonical JSONB stay consistent with organically-written
 * data.
 *
 * Usage (on the self-host host, with the same env the API uses):
 *   npm run selfhost:rewrite-urls -- --dry-run
 *   npm run selfhost:rewrite-urls
 */

import { getFirestore } from "firebase-admin/firestore";

/**
 * Google serves the same object under TWO host shapes, and the app writes both:
 *
 *   firebasestorage.googleapis.com/v0/b/<bucket>/o/<pct-encoded-path>?alt=media&token=…
 *     from buildDownloadUrl — path is percent-encoded as a WHOLE ('/' becomes %2F)
 *   storage.googleapis.com/<bucket>/<path>
 *     from buildStorageObjectUrl — path is a plain, unencoded suffix
 *
 * Matching only the first missed 18 of 539 file documents on the first run. Both
 * must be handled or the leftovers break the moment Firebase is decommissioned.
 */
const FIREBASE_STORAGE_HOSTS = [
  "firebasestorage.googleapis.com",
  "storage.googleapis.com",
] as const;

function isFirebaseStorageUrl(url: string): boolean {
  return FIREBASE_STORAGE_HOSTS.some((h) => url.includes(h));
}

/** Per-segment encode, preserving `/` — mirrors buildDownloadUrl-shim.ts. */
function encodePath(storagePath: string): string {
  return storagePath.split("/").map(encodeURIComponent).join("/");
}

function base(): string {
  return (process.env.FIBUKI_PUBLIC_URL || "").replace(/\/$/, "");
}

function hostDownloadUrl(storagePath: string): string {
  return `${base()}/__storage/download/${encodePath(storagePath)}`;
}

/**
 * Recover the object path from either Firebase Storage URL shape.
 *
 * Only needed when a document has no `storagePath` of its own — every file
 * document in the first real migration had one, so this is a fallback.
 */
export function pathFromFirebaseUrl(url: string): string | null {
  // firebasestorage.googleapis.com/v0/b/<bucket>/o/<pct-encoded>?alt=media
  const viaO = /\/o\/([^?]+)/.exec(url);
  if (viaO) {
    try {
      return decodeURIComponent(viaO[1]);
    } catch {
      return null;
    }
  }

  // storage.googleapis.com/<bucket>/<path> — strip host and bucket, keep the rest.
  // Segments are individually encoded here, not wholesale, so decode per segment.
  const viaGcs = /storage\.googleapis\.com\/[^/]+\/(.+)$/.exec(url.split("?")[0]);
  if (viaGcs) {
    try {
      return viaGcs[1].split("/").map(decodeURIComponent).join("/");
    } catch {
      return null;
    }
  }

  return null;
}

export interface RewriteReport {
  /** Documents inspected because they held a Firebase Storage URL. */
  candidates: number;
  rewritten: number;
  /** Held a Firebase URL but no path could be determined — needs a human. */
  unresolved: string[];
}

interface Target {
  collection: string;
  /** Field holding the absolute URL. */
  field: string;
  /** Field holding the object path, preferred over parsing the URL. */
  pathField: string;
}

/**
 * Collections known to store absolute download URLs.
 *
 * `files.downloadUrl` is the one that matters (521 of 539 documents in the first
 * real migration). `bmdExports` also stores export artefact links.
 */
const TARGETS: readonly Target[] = [
  { collection: "files", field: "downloadUrl", pathField: "storagePath" },
  { collection: "bmdExports", field: "downloadUrl", pathField: "storagePath" },
];

export async function rewriteDownloadUrls(
  opts: { dryRun?: boolean; log?: (m: string) => void } = {}
): Promise<RewriteReport> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const db = getFirestore();
  const report: RewriteReport = { candidates: 0, rewritten: 0, unresolved: [] };

  if (!base()) {
    throw new Error(
      "selfhost rewrite-urls: FIBUKI_PUBLIC_URL is required — without it the " +
        "rewritten URLs would be root-relative and break when opened from the " +
        "web origin, which is the whole problem being fixed.",
    );
  }

  for (const target of TARGETS) {
    const snap = await db.collection(target.collection).get();
    let touched = 0;

    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>;
      const url = data[target.field];
      if (typeof url !== "string" || !isFirebaseStorageUrl(url)) {
        continue; // already self-host, or no URL — idempotent by construction
      }
      report.candidates++;

      const stored = data[target.pathField];
      const path =
        typeof stored === "string" && stored ? stored : pathFromFirebaseUrl(url);
      if (!path) {
        report.unresolved.push(`${target.collection}/${doc.id}`);
        continue;
      }

      if (!opts.dryRun) {
        await doc.ref.update({ [target.field]: hostDownloadUrl(path) });
      }
      touched++;
      report.rewritten++;
    }

    log(
      `  ${target.collection}: ${touched}/${snap.size} rewritten` +
        (opts.dryRun ? " (dry run — nothing written)" : ""),
    );
  }

  if (report.unresolved.length > 0) {
    log(
      `  WARNING ${report.unresolved.length} document(s) held a Firebase URL with ` +
        `no recoverable path: ${report.unresolved.slice(0, 10).join(", ")}`,
    );
  }

  return report;
}
