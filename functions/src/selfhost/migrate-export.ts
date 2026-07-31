/**
 * W3 migration dump — exporter (chunk 1). Handles are INJECTED so the same
 * code runs against real firebase-admin (creds-side script,
 * functions/scripts/export-firebase-dump.ts, chunk 4) and against the
 * shims (this repo's round-trip tests). Never imports the shim modules
 * directly — only the duck-typed surfaces below.
 *
 * Full seam documented in migrate-import.test.ts and
 * migrate-import-storage.test.ts; implementation brief in
 * handoffs/2026-07-22-w3-migration-impl.md.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { DUMP_VERSION, serializeDocData, type DumpManifest, type DocLine, type UserLine, type StorageLine } from "./dump-format";

export interface FirestoreDocSnapshotLike {
  id: string;
  data(): Record<string, unknown> | undefined;
}

export interface FirestoreQuerySnapshotLike {
  docs: FirestoreDocSnapshotLike[];
}

export interface FirestoreCollectionLike {
  get(): Promise<FirestoreQuerySnapshotLike>;
}

export interface FirestoreLike {
  collection(path: string): FirestoreCollectionLike;
  /** Real firebase-admin only — the shims don't implement discovery. */
  listCollections?(): Promise<{ id: string }[]>;
}

export interface AuthUserProviderInfoLike {
  providerId: string;
}

export interface AuthUserRecordLike {
  uid: string;
  email?: string;
  displayName?: string;
  disabled?: boolean;
  customClaims?: Record<string, unknown>;
  providerData?: AuthUserProviderInfoLike[];
}

export interface AuthLike {
  listUsers(maxResults?: number, pageToken?: string): Promise<{ users: AuthUserRecordLike[]; pageToken?: string }>;
}

export interface StorageFileLike {
  name: string;
  download(): Promise<[Buffer]>;
  getMetadata(): Promise<[{ contentType?: string; metadata?: Record<string, string> }]>;
}

export interface BucketLike {
  getFiles(query?: { prefix?: string }): Promise<[StorageFileLike[]]>;
}

export interface ExportDumpOptions {
  dir: string;
  firestore?: FirestoreLike;
  collections?: string[];
  auth?: AuthLike;
  storage?: BucketLike;
  storagePrefix?: string;
}

async function writeNdjson(filePath: string, lines: unknown[]): Promise<void> {
  const body = lines.length ? lines.map((l) => JSON.stringify(l)).join("\n") + "\n" : "";
  await fs.writeFile(filePath, body);
}

async function exportCollections(
  dir: string,
  firestore: FirestoreLike,
  collectionPaths: string[],
): Promise<DumpManifest["collections"]> {
  await fs.mkdir(path.join(dir, "collections"), { recursive: true });
  const result: DumpManifest["collections"] = [];
  let seq = 0;
  for (const colPath of collectionPaths) {
    const snap = await firestore.collection(colPath).get();
    const lines: DocLine[] = snap.docs.map((d) => ({
      id: d.id,
      data: serializeDocData(d.data() ?? {}),
    }));
    const file = `c${++seq}.ndjson`;
    await writeNdjson(path.join(dir, "collections", file), lines);
    result.push({ path: colPath, file, count: lines.length });
  }
  return result;
}

async function exportUsers(dir: string, auth: AuthLike): Promise<DumpManifest["users"]> {
  const lines: UserLine[] = [];
  let pageToken: string | undefined;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const u of page.users) {
      if (!u.email) continue;
      const line: UserLine = {
        uid: u.uid,
        email: u.email,
        providerIds: (u.providerData ?? []).map((p) => p.providerId),
      };
      if (u.displayName) line.displayName = u.displayName;
      if (u.customClaims?.admin === true) line.admin = true;
      if (u.disabled) line.disabled = true;
      lines.push(line);
    }
    pageToken = page.pageToken;
  } while (pageToken);

  if (lines.length === 0) return null;
  await writeNdjson(path.join(dir, "users.ndjson"), lines);
  return { file: "users.ndjson", count: lines.length };
}

async function exportStorage(
  dir: string,
  storage: BucketLike,
  prefix: string | undefined,
): Promise<DumpManifest["storage"]> {
  const [files] = await storage.getFiles(prefix ? { prefix } : undefined);
  if (files.length === 0) return null;

  await fs.mkdir(path.join(dir, "objects"), { recursive: true });
  const lines: StorageLine[] = [];
  let bytes = 0;
  for (const file of files) {
    const [data] = await file.download();
    const [meta] = await file.getMetadata();
    const target = path.join(dir, "objects", file.name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    bytes += data.length;

    const line: StorageLine = {
      path: file.name,
      size: data.length,
      md5: createHash("md5").update(data).digest("hex"),
    };
    if (meta.contentType) line.contentType = meta.contentType;
    if (meta.metadata && Object.keys(meta.metadata).length > 0) line.metadata = meta.metadata;
    lines.push(line);
  }
  await writeNdjson(path.join(dir, "storage-manifest.ndjson"), lines);
  return { manifest: "storage-manifest.ndjson", objectsDir: "objects", count: lines.length, bytes };
}

export async function exportDump(opts: ExportDumpOptions): Promise<DumpManifest> {
  await fs.mkdir(opts.dir, { recursive: true });

  let collections: DumpManifest["collections"] = [];
  if (opts.firestore) {
    let collectionPaths = opts.collections;
    if (!collectionPaths) {
      if (typeof opts.firestore.listCollections !== "function") {
        throw new Error(
          "migrate-export: opts.collections is required when firestore.listCollections is unavailable",
        );
      }
      collectionPaths = (await opts.firestore.listCollections()).map((c) => c.id);
    }
    collections = await exportCollections(opts.dir, opts.firestore, collectionPaths);
  } else if (opts.collections && opts.collections.length > 0) {
    throw new Error("migrate-export: opts.collections given without opts.firestore");
  }

  const users = opts.auth ? await exportUsers(opts.dir, opts.auth) : null;
  const storage = opts.storage ? await exportStorage(opts.dir, opts.storage, opts.storagePrefix) : null;

  const manifest: DumpManifest = {
    version: DUMP_VERSION,
    exportedAt: new Date().toISOString(),
    collections,
    users,
    storage,
  };
  await fs.writeFile(path.join(opts.dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}
