/**
 * W3 migration dump — creds-side EXPORT launcher (chunk 4). A thin wrapper
 * over src/selfhost/migrate-export.ts that wires REAL firebase-admin handles
 * into exportDump() and writes a self-contained version-1 dump directory.
 *
 * This is the ONE piece of W3 that touches Firebase. It runs on a
 * credential-bearing machine (never the audit box, never CI) — the exporter
 * and importer are split precisely because Admin credentials must not live
 * where the selfhost stack runs. migrate-export.ts is shim-free and
 * duck-typed, so loading it here next to real firebase-admin is safe; do NOT
 * run this under vitest.selfhost.config.ts (that aliases firebase-admin/* to
 * the shims — the opposite of what this needs).
 *
 *   # auth via GOOGLE_APPLICATION_CREDENTIALS (a service-account JSON path)
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json
 *   npx vite-node scripts/export-firebase-dump.ts -- \
 *     --dir ./dump --bucket my-project.appspot.com
 *
 * By default it discovers every top-level collection (listCollections),
 * exports all auth users, and copies the whole storage bucket. Narrow with
 * --collections / --storage-prefix, or drop a section with --no-*.
 *
 * The resulting dump is what `npm run selfhost:import -- --dir <dump>` (and
 * `selfhost:verify`) consume on the selfhost side.
 */

import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getStorage } from "firebase-admin/storage";
import { exportDump } from "../src/selfhost/migrate-export";
import type { FirestoreLike, AuthLike, BucketLike } from "../src/selfhost/migrate-export";

interface Options {
  dir: string;
  collections?: string[];
  storagePrefix?: string;
  bucket?: string;
  projectId?: string;
  withFirestore: boolean;
  withUsers: boolean;
  withStorage: boolean;
}

const USAGE = `export-firebase-dump — emit a version-1 migration dump from Firebase

Usage:
  vite-node scripts/export-firebase-dump.ts -- --dir <out> [options]

Options:
  --dir <path>              output dump directory (required)
  --collections <a,b,c>     explicit collections (default: discover all top-level)
  --storage-prefix <p>      only export objects under this path prefix
  --bucket <name>           storage bucket (default: FIREBASE_STORAGE_BUCKET env)
  --project <id>            GCP project id (default: from credentials)
  --no-firestore            skip collections
  --no-users                skip auth users
  --no-storage              skip storage objects
  -h, --help                show this help

Auth: set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON path.`;

function parseArgs(argv: string[]): Options | { help: true } | { error: string } {
  if (argv.includes("-h") || argv.includes("--help")) return { help: true };

  let dir: string | undefined;
  let collections: string[] | undefined;
  let storagePrefix: string | undefined;
  let bucket: string | undefined;
  let projectId: string | undefined;
  let withFirestore = true;
  let withUsers = true;
  let withStorage = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const need = (): string | { error: string } => {
      const v = argv[++i];
      return v === undefined ? { error: `${arg} requires a value` } : v;
    };
    switch (arg) {
      case "--dir": {
        const v = need();
        if (typeof v !== "string") return v;
        dir = v;
        break;
      }
      case "--collections": {
        const v = need();
        if (typeof v !== "string") return v;
        collections = v.split(",").map((s) => s.trim()).filter(Boolean);
        break;
      }
      case "--storage-prefix": {
        const v = need();
        if (typeof v !== "string") return v;
        storagePrefix = v;
        break;
      }
      case "--bucket": {
        const v = need();
        if (typeof v !== "string") return v;
        bucket = v;
        break;
      }
      case "--project": {
        const v = need();
        if (typeof v !== "string") return v;
        projectId = v;
        break;
      }
      case "--no-firestore":
        withFirestore = false;
        break;
      case "--no-users":
        withUsers = false;
        break;
      case "--no-storage":
        withStorage = false;
        break;
      default:
        return { error: `unexpected argument "${arg}"` };
    }
  }

  if (!dir) return { error: "--dir <out> is required" };
  return { dir, collections, storagePrefix, bucket, projectId, withFirestore, withUsers, withStorage };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("help" in parsed) {
    console.log(USAGE);
    return;
  }
  if ("error" in parsed) {
    console.error(`error: ${parsed.error}\n\n${USAGE}`);
    process.exit(2);
  }

  const bucketName = parsed.bucket ?? process.env.FIREBASE_STORAGE_BUCKET;
  if (parsed.withStorage && !bucketName) {
    console.error("error: storage export needs a bucket — pass --bucket or set FIREBASE_STORAGE_BUCKET (or --no-storage)");
    process.exit(2);
  }

  if (getApps().length === 0) {
    initializeApp({
      credential: applicationDefault(),
      ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
      ...(bucketName ? { storageBucket: bucketName } : {}),
    });
  }

  // Real firebase-admin handles structurally satisfy the duck-typed *Like
  // surfaces migrate-export.ts injects; cast at the boundary.
  const firestore = parsed.withFirestore ? (getFirestore() as unknown as FirestoreLike) : undefined;
  const auth = parsed.withUsers ? (getAuth() as unknown as AuthLike) : undefined;
  const storage = parsed.withStorage ? (getStorage().bucket(bucketName) as unknown as BucketLike) : undefined;

  console.log(`exporting to ${parsed.dir} …`);
  const manifest = await exportDump({
    dir: parsed.dir,
    firestore,
    collections: parsed.collections,
    auth,
    storage,
    storagePrefix: parsed.storagePrefix,
  });

  console.log("export — done:");
  console.log(`  collections: ${manifest.collections.length} (${manifest.collections.reduce((n, c) => n + c.count, 0)} docs)`);
  console.log(`  users: ${manifest.users?.count ?? 0}`);
  console.log(`  storage: ${manifest.storage?.count ?? 0} objects, ${manifest.storage?.bytes ?? 0} bytes`);
  console.log(`\nnext: transfer ${parsed.dir} to the selfhost host and run\n  npm run selfhost:import -- --dir <dump>\n  npm run selfhost:verify -- --dir <dump>`);
}

main().catch((err) => {
  console.error(`export-firebase-dump: fatal — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
