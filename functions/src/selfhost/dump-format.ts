/**
 * W3 migration dump — format module (chunk 1). PURE: no shim imports, so the
 * creds-side exporter script can load this next to the REAL firebase-admin.
 * Contract + full seam documented in migrate-import.test.ts; implementation
 * brief in handoffs/2026-07-22-w3-migration-impl.md.
 *
 * Dump directory layout (version 1):
 *   manifest.json                    DumpManifest
 *   collections/<file>.ndjson        one DocLine per line
 *   users.ndjson                     one UserLine per line
 *   storage-manifest.ndjson          one StorageLine per line
 *   objects/<path...>                raw object bytes, Firebase paths verbatim
 *
 * Timestamp-like values ({seconds,nanoseconds}, admin-SDK
 * {_seconds,_nanoseconds}, and Date) become { __ts: [s, n] } — the same
 * tagged encoding wire-values.ts speaks. undefined is dropped. Exotic
 * Firestore types (GeoPoint, DocumentReference, Bytes) and "__"-tagged keys
 * THROW: silently passing them through would land garbage in the store.
 */

export const DUMP_VERSION = 1;

export interface DumpManifest {
  version: 1;
  exportedAt: string;
  projectId?: string;
  collections: { path: string; file: string; count: number }[];
  users: { file: string; count: number } | null;
  storage: { manifest: string; objectsDir: string; count: number; bytes: number } | null;
}

export interface DocLine {
  id: string;
  data: Record<string, unknown>;
}

export interface UserLine {
  uid: string;
  email: string;
  displayName?: string;
  admin?: boolean;
  providerIds: string[];
  disabled?: boolean;
}

export interface StorageLine {
  path: string;
  size: number;
  md5: string;
  contentType?: string;
  metadata?: Record<string, string>;
}

/** Firestore/admin-SDK exotic types that don't have a lossless wire shape. */
const EXOTIC_CONSTRUCTOR_NAMES = new Set(["GeoPoint", "DocumentReference", "Bytes"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/**
 * Duck-types both the shim/real-SDK public shape and the admin-SDK internal
 * shape. Requires the object have EXACTLY the two timestamp fields (and
 * nothing else) so an unrelated business object that merely happens to have
 * numeric `seconds`/`nanoseconds` fields (e.g. a duration) doesn't get
 * mistaken for a Timestamp and silently lose its other fields.
 */
function timestampTag(v: Record<string, unknown>): { __ts: [number, number] } | null {
  const keys = Object.keys(v);
  if (
    keys.length === 2 &&
    keys.includes("seconds") &&
    keys.includes("nanoseconds") &&
    typeof v.seconds === "number" &&
    typeof v.nanoseconds === "number"
  ) {
    return { __ts: [v.seconds, v.nanoseconds] };
  }
  if (
    keys.length === 2 &&
    keys.includes("_seconds") &&
    keys.includes("_nanoseconds") &&
    typeof v._seconds === "number" &&
    typeof v._nanoseconds === "number"
  ) {
    return { __ts: [v._seconds, v._nanoseconds] };
  }
  return null;
}

function serializeValue(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (value instanceof Date) {
    const ms = value.getTime();
    return { __ts: [Math.floor(ms / 1000), (ms % 1000) * 1e6] };
  }
  if (Buffer.isBuffer(value)) {
    throw new Error("dump-format: exotic Firestore Bytes value has no lossless wire shape");
  }
  if (Array.isArray(value)) return value.map((v) => serializeValue(v));
  if (isPlainObject(value)) {
    const ctorName = (value as { constructor?: { name?: string } }).constructor?.name;
    if (ctorName && EXOTIC_CONSTRUCTOR_NAMES.has(ctorName)) {
      throw new Error(`dump-format: exotic Firestore type "${ctorName}" has no lossless wire shape`);
    }
    const tag = timestampTag(value);
    if (tag) return tag;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith("__")) throw new Error(`dump-format: reserved wire-tag key "${k}"`);
      if (k === "__proto__" || k === "constructor" || k === "prototype") {
        throw new Error(`dump-format: unsafe field name "${k}"`);
      }
      const sv = serializeValue(v);
      if (sv !== undefined) out[k] = sv;
    }
    return out;
  }
  return value;
}

export function serializeDocData(data: Record<string, unknown>): Record<string, unknown> {
  return serializeValue(data) as Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validates the dump manifest contract. Throws on any malformed shape. */
export function parseManifest(json: unknown): DumpManifest {
  if (!isRecord(json)) throw new Error("dump-format: manifest must be a JSON object");
  if (json.version !== DUMP_VERSION) {
    throw new Error(`dump-format: unsupported manifest version ${JSON.stringify(json.version)}`);
  }
  if (typeof json.exportedAt !== "string") {
    throw new Error("dump-format: manifest.exportedAt must be a string");
  }
  if (!Array.isArray(json.collections)) {
    throw new Error("dump-format: manifest.collections must be an array");
  }
  const collections: DumpManifest["collections"] = json.collections.map((c) => {
    if (
      !isRecord(c) ||
      typeof c.path !== "string" ||
      typeof c.file !== "string" ||
      typeof c.count !== "number"
    ) {
      throw new Error(`dump-format: malformed collections entry ${JSON.stringify(c)}`);
    }
    return { path: c.path, file: c.file, count: c.count };
  });

  let users: DumpManifest["users"] = null;
  if (json.users !== null && json.users !== undefined) {
    const u = json.users;
    if (!isRecord(u) || typeof u.file !== "string" || typeof u.count !== "number") {
      throw new Error("dump-format: malformed manifest.users");
    }
    users = { file: u.file, count: u.count };
  }

  let storage: DumpManifest["storage"] = null;
  if (json.storage !== null && json.storage !== undefined) {
    const s = json.storage;
    if (
      !isRecord(s) ||
      typeof s.manifest !== "string" ||
      typeof s.objectsDir !== "string" ||
      typeof s.count !== "number" ||
      typeof s.bytes !== "number"
    ) {
      throw new Error("dump-format: malformed manifest.storage");
    }
    storage = { manifest: s.manifest, objectsDir: s.objectsDir, count: s.count, bytes: s.bytes };
  }

  const manifest: DumpManifest = {
    version: DUMP_VERSION,
    exportedAt: json.exportedAt,
    collections,
    users,
    storage,
  };
  if (typeof json.projectId === "string") manifest.projectId = json.projectId;
  return manifest;
}
