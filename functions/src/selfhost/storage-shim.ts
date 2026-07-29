/**
 * Drop-in for `firebase-admin/storage`: the `bucket().file()` surface the
 * app actually uses, backed by a pluggable blob store (work item 5).
 *
 * Used subset (mapped 2026-07-13 across all non-test call sites):
 *   getStorage().bucket()            — default bucket only, plus `.name`
 *   bucket.file(path)                — save / download / delete / exists /
 *                                      getMetadata / setMetadata / makePublic
 *   bucket.getFiles({ prefix })      — list + per-file delete/name
 *
 * Backend selection (resolved lazily on first operation, so the barrel
 * always boots — `getStorage()` runs at module load in receiveEmail.ts):
 *   FIBUKI_STORAGE=memory   → in-process Map (tests, throwaway dev)
 *   FIBUKI_STORAGE=s3, or FIBUKI_S3_ENDPOINT set → MinIO/S3 (blobstore-s3.ts)
 *   neither                 → every operation throws loudly (a storage-
 *                             touching path must never silently no-op)
 *
 * Metadata follows GCS shapes where call sites depend on them: `size` is a
 * string (processUserExportQueue does parseInt), custom metadata lives under
 * `metadata.metadata` (download tokens), delete/download on a missing object
 * throw with `code: 404` (real @google-cloud/storage behavior — call sites
 * try/catch on that).
 */

export interface BlobMetadata {
  name: string;
  bucket: string;
  size: string;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  timeCreated: string;
  updated: string;
  /** custom (x-goog-meta-*) metadata, e.g. firebaseStorageDownloadTokens */
  metadata?: Record<string, string>;
}

export interface BlobStore {
  put(path: string, data: Buffer, meta: BlobMetadata): Promise<void>;
  /** null if absent */
  head(path: string): Promise<BlobMetadata | null>;
  /** null if absent */
  get(path: string): Promise<{ data: Buffer; meta: BlobMetadata } | null>;
  /** false if absent */
  delete(path: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
  /** merge-patch metadata of an existing object; throws if absent */
  setMeta(path: string, meta: BlobMetadata): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Backends                                                            */
/* ------------------------------------------------------------------ */

/** GCS hands out fresh metadata objects; mutating callers must not corrupt the store. */
function copyMeta(meta: BlobMetadata): BlobMetadata {
  return { ...meta, metadata: meta.metadata ? { ...meta.metadata } : undefined };
}

class MemoryBlobStore implements BlobStore {
  private blobs = new Map<string, { data: Buffer; meta: BlobMetadata }>();

  async put(path: string, data: Buffer, meta: BlobMetadata): Promise<void> {
    this.blobs.set(path, { data: Buffer.from(data), meta });
  }
  async head(path: string): Promise<BlobMetadata | null> {
    const b = this.blobs.get(path);
    return b ? copyMeta(b.meta) : null;
  }
  async get(path: string): Promise<{ data: Buffer; meta: BlobMetadata } | null> {
    const b = this.blobs.get(path);
    return b ? { data: Buffer.from(b.data), meta: copyMeta(b.meta) } : null;
  }
  async delete(path: string): Promise<boolean> {
    return this.blobs.delete(path);
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.blobs.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  async setMeta(path: string, meta: BlobMetadata): Promise<void> {
    const b = this.blobs.get(path);
    if (!b) throw notFound(path);
    b.meta = meta;
  }
}

class UnconfiguredBlobStore implements BlobStore {
  private fail(): never {
    throw new Error(
      "selfhost storage-shim: no blob store configured — set FIBUKI_S3_ENDPOINT " +
        "(+ FIBUKI_S3_ACCESS_KEY/FIBUKI_S3_SECRET_KEY) for MinIO/S3, or " +
        "FIBUKI_STORAGE=memory for a throwaway in-process store",
    );
  }
  put(): Promise<void> { return this.fail(); }
  head(): Promise<BlobMetadata | null> { return this.fail(); }
  get(): Promise<{ data: Buffer; meta: BlobMetadata } | null> { return this.fail(); }
  delete(): Promise<boolean> { return this.fail(); }
  list(): Promise<string[]> { return this.fail(); }
  setMeta(): Promise<void> { return this.fail(); }
}

let storePromise: Promise<BlobStore> | undefined;

function resolveStore(): Promise<BlobStore> {
  if (!storePromise) {
    const mode = process.env.FIBUKI_STORAGE;
    if (mode === "memory") {
      storePromise = Promise.resolve(new MemoryBlobStore());
    } else if (mode === "s3" || process.env.FIBUKI_S3_ENDPOINT) {
      storePromise = import("./blobstore-s3").then(
        (m) => new m.S3BlobStore(bucketName()),
      );
    } else {
      storePromise = Promise.resolve(new UnconfiguredBlobStore());
    }
  }
  return storePromise;
}

/** Test hook: drop the cached backend (e.g. after setting FIBUKI_STORAGE). */
export function _resetStorageForTests(): void {
  storePromise = undefined;
}

function bucketName(): string {
  return process.env.FIBUKI_STORAGE_BUCKET || "fibuki-selfhost";
}

function notFound(path: string): Error {
  return Object.assign(new Error(`No such object: ${path}`), { code: 404 });
}

/* ------------------------------------------------------------------ */
/* GCS-flavored save-option normalization                              */
/* ------------------------------------------------------------------ */

interface SaveOptions {
  contentType?: string;
  metadata?: {
    contentType?: string;
    cacheControl?: string;
    contentDisposition?: string;
    metadata?: Record<string, unknown>;
  };
}

interface SetMetadataPatch {
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata?: Record<string, unknown>;
}

function customMeta(
  raw: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    // Sink guard (routes reject these upfront; literal comparisons on purpose)
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (v !== undefined && v !== null) out[k] = String(v);
  }
  return out;
}

/** Coerce a metadata field to a string or drop it — HTTP-sourced values can be string[]-shaped. */
function asOptionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/* ------------------------------------------------------------------ */
/* File / Bucket surface                                               */
/* ------------------------------------------------------------------ */

export class StorageFile {
  constructor(
    public readonly name: string,
    private readonly bucketRef: StorageBucket,
  ) {}

  async save(data: Buffer | string, options?: SaveOptions): Promise<void> {
    const store = await resolveStore();
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const now = new Date().toISOString();
    const prev = await store.head(this.name);
    const m = options?.metadata;
    await store.put(this.name, buf, {
      name: this.name,
      bucket: this.bucketRef.name,
      size: String(buf.length),
      contentType: asOptionalString(options?.contentType ?? m?.contentType),
      cacheControl: asOptionalString(m?.cacheControl),
      contentDisposition: asOptionalString(m?.contentDisposition),
      metadata: customMeta(m?.metadata),
      timeCreated: prev?.timeCreated ?? now,
      updated: now,
    });
  }

  async download(): Promise<[Buffer]> {
    const store = await resolveStore();
    const b = await store.get(this.name);
    if (!b) throw notFound(this.name);
    return [b.data];
  }

  async delete(): Promise<void> {
    const store = await resolveStore();
    const existed = await store.delete(this.name);
    if (!existed) throw notFound(this.name);
  }

  async exists(): Promise<[boolean]> {
    const store = await resolveStore();
    return [(await store.head(this.name)) !== null];
  }

  async getMetadata(): Promise<[BlobMetadata]> {
    const store = await resolveStore();
    const meta = await store.head(this.name);
    if (!meta) throw notFound(this.name);
    return [meta];
  }

  /** Merge-patch, GCS-style: custom metadata keys merge; null deletes a key. */
  async setMetadata(patch: SetMetadataPatch): Promise<void> {
    const store = await resolveStore();
    const meta = await store.head(this.name);
    if (!meta) throw notFound(this.name);
    const merged: BlobMetadata = {
      ...meta,
      contentType: patch.contentType ?? meta.contentType,
      cacheControl: patch.cacheControl ?? meta.cacheControl,
      contentDisposition: patch.contentDisposition ?? meta.contentDisposition,
      updated: new Date().toISOString(),
    };
    if (patch.metadata) {
      const custom = { ...(meta.metadata ?? {}) };
      for (const [k, v] of Object.entries(patch.metadata)) {
        if (v === null) delete custom[k];
        else if (v !== undefined) custom[k] = String(v);
      }
      merged.metadata = custom;
    }
    await store.setMeta(this.name, merged);
  }

  /**
   * No-op: object ACLs don't exist on MinIO/the memory store. Selfhost
   * serves downloads through the API host / a bucket-level policy; the
   * public-URL strings call sites build are a deployment-time concern
   * (see handoff — candidate upstream refactor: central buildDownloadUrl).
   */
  async makePublic(): Promise<void> {}
}

export class StorageBucket {
  constructor(public readonly name: string) {}

  file(path: string): StorageFile {
    if (!path) {
      throw new Error("selfhost storage-shim: file() requires a non-empty path");
    }
    return new StorageFile(path, this);
  }

  async getFiles(query?: { prefix?: string }): Promise<[StorageFile[]]> {
    const store = await resolveStore();
    const names = await store.list(query?.prefix ?? "");
    return [names.map((n) => new StorageFile(n, this))];
  }
}

export interface StorageShim {
  bucket(name?: string): StorageBucket;
}

export function getStorage(): StorageShim {
  return {
    bucket(name?: string): StorageBucket {
      return new StorageBucket(name || bucketName());
    },
  };
}
