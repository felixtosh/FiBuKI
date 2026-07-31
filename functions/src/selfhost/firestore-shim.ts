/**
 * Postgres-backed drop-in for the `firebase-admin/firestore` module surface
 * FiBuKI actually uses. Swapped in at module resolution (vitest/bundler
 * alias) — application code is unchanged.
 *
 * Spike scope: documents live in one JSONB table; query filters/order/limit
 * are applied in JS after an equality-pushdown fetch. Production hardening
 * (SQL pushdown, indexes, real connection pool) comes after Gate 3 passes.
 *
 * FieldValue / Timestamp are the REAL classes from @google-cloud/firestore
 * (pure sentinels / data classes) — exact semantics, zero reimplementation.
 * The shim interprets the sentinels at write time, mirroring how the
 * Firestore backend applies transforms.
 */

import { FieldValue, Timestamp } from "@google-cloud/firestore";
import { emitChange } from "./bus";
import { notifyChange } from "./change-notify";
import { FLATTENED, FlatSpec } from "./db/collections";
import { runMigrations } from "./db/migrate";
import { compileFlatQuery, CursorSpec } from "./db/pushdown";
import { getTenantId } from "./db/tenant";

export { FieldValue, Timestamp };

// ---------------------------------------------------------------------------
// Field-name validation
// ---------------------------------------------------------------------------

/**
 * Firestore reserves field names matching __.*__ (firebase-admin rejects
 * them on write); the shim does the same. That parity rule conveniently
 * covers "__proto__", killing prototype-pollution through document field
 * names. "constructor"/"prototype" are rejected as well — stricter than
 * real Firestore, which no app data uses (documented divergence).
 *
 * NOTE: every dynamic-key sink below guards with LITERAL comparisons
 * (k === "__proto__" || ...) rather than a shared Set/helper on purpose —
 * that's the guard shape static analysis (CodeQL) recognizes as a
 * sanitizer, and these sinks are the ones it watches.
 */
const RESERVED_FIELD_NAME = /^__.*__$/;

function assertValidFieldName(name: string, context: string): void {
  if (RESERVED_FIELD_NAME.test(name) || name === "constructor" || name === "prototype") {
    throw new Error(
      `selfhost firestore shim: invalid field name "${name}"` +
        (context ? ` (in "${context}")` : "") +
        ` — names matching __.*__ are reserved, prototype-polluting names are refused`,
    );
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

type QueryFn = <R = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<{ rows: R[] }>;

/**
 * Minimal SQL client surface the shim needs — satisfied by BOTH the embedded
 * PGlite (tests / default) and node-postgres' Pool (production). Both return
 * `{ rows }` from a parameterized `$1`-style query, and both auto-parse JSONB
 * columns to JS values and accept a JSON *string* cast via `$n::jsonb`, so the
 * shim's SQL is identical against either backend.
 *
 * `query` is autocommit with NO tenant context — DDL and the migration
 * ledger only. All document IO goes through `tx`, one transaction with
 * set_config('app.tenant_id', <tenant>, true) applied first, which is what
 * arms the RLS policies (see drizzle/0000_init.sql).
 */
export interface SqlClient {
  query: QueryFn;
  tx<T>(tenantId: string | null, fn: (q: QueryFn) => Promise<T>): Promise<T>;
}

let pgPromise: Promise<SqlClient> | null = null;

/**
 * Pick the backend from the environment:
 *   DATABASE_URL set → real Postgres via node-postgres (production LXC).
 *   unset           → embedded in-memory PGlite (tests, local dev).
 * Same DDL and same SQL run against whichever is chosen.
 */
async function makeClient(): Promise<SqlClient> {
  const url = process.env.DATABASE_URL;
  if (!url && process.env.NODE_ENV === "production") {
    // The fallback below is an in-memory database. In production that is not a
    // degraded mode, it is a data-loss-shaped illusion: the process boots, reports
    // healthy, serves an EMPTY dataset and accepts writes that vanish on restart.
    // A missing/typo'd DATABASE_URL is the likely cause and is trivially fixable —
    // but only if it is visible, so refuse to start instead.
    throw new Error(
      "fibuki firestore-shim: DATABASE_URL is required in production. Refusing to " +
        "fall back to the in-memory database, which would silently serve empty data.",
    );
  }
  if (url) {
    const { Pool } = await import("pg");
    // node-postgres defaults to max:10. Every onSnapshot in the client is a poll
    // (lib/selfhost/firestore-client.ts), so steady-state read traffic scales
    // with visible tabs x live listeners, and each `tx` below holds a connection
    // for the whole transaction. At ~10 concurrent users that default is the
    // first thing to saturate, and it presents as latency rather than an error.
    // Keep POSTGRES_MAX_CONNECTIONS <= Postgres' own max_connections (100 default).
    const max = Number(process.env.POSTGRES_MAX_CONNECTIONS) || 25;
    const pool = new Pool({ connectionString: url, max });
    // Surface pool-level errors instead of crashing the process on an idle-client drop.
    pool.on("error", (err) => {
      console.error("fibuki firestore-shim: postgres pool error:", err.message);
    });
    return {
      query: async <R>(sql: string, params?: unknown[]) => {
        const res = await pool.query<Record<string, unknown>>(sql, params as unknown[]);
        return { rows: res.rows as unknown as R[] };
      },
      tx: async <T>(tenantId: string | null, fn: (q: QueryFn) => Promise<T>): Promise<T> => {
        const conn = await pool.connect();
        const q: QueryFn = async <R>(sql: string, params?: unknown[]) => {
          const res = await conn.query<Record<string, unknown>>(sql, params as unknown[]);
          return { rows: res.rows as unknown as R[] };
        };
        try {
          await q(`BEGIN`);
          // The connecting user is typically the owner or a superuser, whom
          // RLS does not bind — document IO runs as the plain app role.
          await q(`SET LOCAL ROLE fibuki_app`);
          if (tenantId !== null) {
            await q(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
          }
          const result = await fn(q);
          await q(`COMMIT`);
          return result;
        } catch (err) {
          try {
            await q(`ROLLBACK`);
          } catch {
            // connection may already be gone; the pool will recycle it
          }
          throw err;
        } finally {
          conn.release();
        }
      },
    };
  }
  // Imported HERE, not at module scope, for the same reason `pg` is above: this is
  // the tests/local-dev backend, and PGlite is a dev-only dependency carrying a WASM
  // Postgres build. A static import forces every consumer to resolve it — including
  // the Next.js web build, which imports this shim for server-side document IO and
  // has no reason to ship an embedded database. Production sets DATABASE_URL and
  // returns above, so this line never runs there.
  // The ignore comments are load-bearing for the WEB build. Bundlers resolve
  // dynamic imports statically, so without them Turbopack fails the build with
  // "Module not found: Can't resolve '@electric-sql/pglite'" — a dev-only
  // dependency that fibuki-web has no reason to ship, and whose code path cannot
  // run there anyway (DATABASE_URL is always set, and the guard above enforces
  // it). Left resolvable at RUNTIME for tests and local dev, which do use it.
  const { PGlite } = await import(
    /* webpackIgnore: true */ /* turbopackIgnore: true */ "@electric-sql/pglite"
  );
  const pg = new PGlite(); // in-memory; no DATABASE_URL configured
  const q: QueryFn = async <R>(sql: string, params?: unknown[]) => {
    const res = await pg.query<Record<string, unknown>>(sql, params as unknown[]);
    return { rows: res.rows as unknown as R[] };
  };
  // PGlite is a single connection: serialize ALL statements so a transaction
  // is never interleaved with another caller's statements.
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const run = chain.then(job);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  return {
    query: (sql, params) => enqueue(() => q(sql, params)),
    tx: <T>(tenantId: string | null, fn: (qq: QueryFn) => Promise<T>): Promise<T> =>
      enqueue(async () => {
        await q(`BEGIN`);
        try {
          // PGlite connects as a superuser, whom RLS never binds — document
          // IO runs as the plain app role.
          await q(`SET LOCAL ROLE fibuki_app`);
          if (tenantId !== null) {
            await q(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
          }
          const result = await fn(q);
          await q(`COMMIT`);
          return result;
        } catch (err) {
          await q(`ROLLBACK`);
          throw err;
        }
      }),
  };
}

async function getPg(): Promise<SqlClient> {
  if (!pgPromise) {
    pgPromise = (async () => {
      const client = await makeClient();
      await runMigrations(client);
      return client;
    })();
  }
  return pgPromise;
}

/**
 * Selfhost-internal accessor: the shared SQL client, migrations applied.
 * better-auth.ts routes ALL auth-store IO through this so identity data
 * rides the same connection/serialization queue as document IO — in tests
 * that is the same in-memory PGlite instance the shim uses.
 */
export function getSqlClient(): Promise<SqlClient> {
  return getPg();
}

/** Every document read/write runs tenant-scoped: one transaction, SET LOCAL app.tenant_id. */
async function withTenant<T>(fn: (q: QueryFn) => Promise<T>): Promise<T> {
  const pg = await getPg();
  return pg.tx(getTenantId(), fn);
}

/** Flattened-table spec for a TOP-LEVEL collection path, if that collection has one. */
function flatSpecFor(collectionPath: string): FlatSpec | undefined {
  return collectionPath.includes("/") ? undefined : FLATTENED[collectionPath];
}

/**
 * Test helper: run raw SQL.
 *   tenantId string    → the normal tenant-scoped app-role transaction.
 *   tenantId null      → app role armed but NO tenant configured; this is
 *                        how the RLS tests prove the policies hold.
 *   tenantId undefined → owner/superuser autocommit (RLS-exempt) for
 *                        asserting raw table contents.
 */
export async function __rawSqlForTest(
  sql: string,
  params?: unknown[],
  tenantId?: string | null,
): Promise<{ rows: Record<string, unknown>[] }> {
  const pg = await getPg();
  if (tenantId === undefined) return pg.query(sql, params);
  return pg.tx(tenantId, (q) => q(sql, params));
}

/** Test helper: wipe all documents (current tenant). */
export async function __resetFirestoreShim(): Promise<void> {
  await withTenant(async (q) => {
    await q(`DELETE FROM docs`);
    for (const spec of Object.values(FLATTENED)) await q(`DELETE FROM ${spec.table}`);
  });
}

// ---------------------------------------------------------------------------
// Encoding: JS values <-> JSONB
// ---------------------------------------------------------------------------

const TS_MARKER = "__fbts__";

function isTimestampLike(v: unknown): v is Timestamp {
  return v instanceof Timestamp;
}

function encodeValue(v: unknown): unknown {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (isTimestampLike(v)) return { [TS_MARKER]: { s: v.seconds, n: v.nanoseconds } };
  if (v instanceof Date) {
    const ts = Timestamp.fromDate(v);
    return { [TS_MARKER]: { s: ts.seconds, n: ts.nanoseconds } };
  }
  if (Array.isArray(v)) return v.map((x) => encodeValue(x));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      // Sink guard (writes reject these upfront; literal comparisons on purpose)
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      const enc = encodeValue(val);
      if (enc !== undefined) out[k] = enc;
    }
    return out;
  }
  return v;
}

function decodeValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map((x) => decodeValue(x));
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const marker = obj[TS_MARKER] as { s: number; n: number } | undefined;
    if (marker && Object.keys(obj).length === 1) {
      return new Timestamp(marker.s, marker.n);
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(obj)) {
      // Sink guard (cannot exist post-validation; literal comparisons on purpose)
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      out[k] = decodeValue(val);
    }
    return out;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Sentinel (FieldValue transform) application
// ---------------------------------------------------------------------------

function sentinelKind(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  const name = (v as object).constructor?.name || "";
  if (name.includes("ServerTimestamp")) return "serverTimestamp";
  if (name.includes("ArrayUnion")) return "arrayUnion";
  if (name.includes("ArrayRemove")) return "arrayRemove";
  if (name.includes("NumericIncrement")) return "increment";
  if (name === "DeleteTransform" || name.includes("Delete")) return "delete";
  return null;
}

function sentinelElements(v: unknown): unknown[] {
  return ((v as { elements?: unknown[] }).elements || []) as unknown[];
}

function sentinelOperand(v: unknown): number {
  return Number((v as { operand?: number }).operand ?? 0);
}

function deepGet(obj: Record<string, unknown>, dotPath: string): unknown {
  return dotPath.split(".").reduce<unknown>((acc, seg) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[seg];
    return undefined;
  }, obj);
}

/**
 * Refusing to WALK or WRITE a prototype-polluting segment: `cur["__proto__"]`
 * resolves to Object.prototype, so one crafted dot-path would otherwise
 * pollute every object in the process. Field-name validation rejects these
 * upfront; the inline literal checks below are the guards at the sink.
 */
function throwUnsafeSegment(seg: string, dotPath: string): never {
  throw new Error(
    `selfhost firestore shim: refusing prototype-polluting path segment "${seg}" in "${dotPath}"`,
  );
}

function deepSet(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const segs = dotPath.split(".");
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (seg === "__proto__" || seg === "constructor" || seg === "prototype") {
      throwUnsafeSegment(seg, dotPath);
    }
    if (!cur[seg] || typeof cur[seg] !== "object" || Array.isArray(cur[seg])) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  const last = segs[segs.length - 1];
  if (last === "__proto__" || last === "constructor" || last === "prototype") {
    throwUnsafeSegment(last, dotPath);
  }
  cur[last] = value;
}

function deepDelete(obj: Record<string, unknown>, dotPath: string): void {
  const segs = dotPath.split(".");
  let cur: Record<string, unknown> | undefined = obj;
  for (let i = 0; i < segs.length - 1 && cur; i++) {
    const seg = segs[i];
    if (seg === "__proto__" || seg === "constructor" || seg === "prototype") {
      throwUnsafeSegment(seg, dotPath);
    }
    cur = cur[seg] as Record<string, unknown> | undefined;
  }
  const last = segs[segs.length - 1];
  if (last === "__proto__" || last === "constructor" || last === "prototype") {
    throwUnsafeSegment(last, dotPath);
  }
  if (cur && typeof cur === "object") delete cur[last];
}

/**
 * Reject `undefined` anywhere in a write payload, mirroring firebase-admin's
 * DEFAULT behavior — the app never enables ignoreUndefinedProperties, so any
 * optional TS field reaching a write throws against real Firestore and must
 * throw here too. Sentinels, Timestamps and Dates are opaque leaves.
 */
function assertNoUndefined(value: unknown, fieldPath: string): void {
  if (value === undefined) {
    throw new Error(
      `selfhost firestore shim: Cannot use "undefined" as a Firestore value` +
        (fieldPath ? ` (found in field "${fieldPath}")` : "") +
        `. If you want to ignore undefined values, enable ignoreUndefinedProperties.`,
    );
  }
  if (value === null || typeof value !== "object") return;
  if (sentinelKind(value) !== null || isTimestampLike(value) || value instanceof Date) return;
  if (Array.isArray(value)) {
    value.forEach((el, i) => assertNoUndefined(el, `${fieldPath}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Same walk also enforces valid field names, mirroring firebase-admin's
    // reserved-name rejection (see assertValidFieldName).
    assertValidFieldName(k, fieldPath);
    assertNoUndefined(v, fieldPath ? `${fieldPath}.${k}` : k);
  }
}

/**
 * Apply an update payload (supports dot-path keys + FieldValue sentinels)
 * onto an existing decoded document. Returns the new decoded document.
 */
function applyUpdate(
  existing: Record<string, unknown>,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(encodeValue(existing)));
  const decoded = decodeValue(result) as Record<string, unknown>; // deep clone preserving Timestamps
  for (const [key, value] of Object.entries(updates)) {
    const kind = sentinelKind(value);
    if (kind === "serverTimestamp") {
      deepSet(decoded, key, Timestamp.now());
    } else if (kind === "delete") {
      deepDelete(decoded, key);
    } else if (kind === "arrayUnion") {
      const cur = deepGet(decoded, key);
      const arr = Array.isArray(cur) ? [...cur] : [];
      for (const el of sentinelElements(value)) {
        if (!arr.some((x) => JSON.stringify(encodeValue(x)) === JSON.stringify(encodeValue(el)))) {
          arr.push(el);
        }
      }
      deepSet(decoded, key, arr);
    } else if (kind === "arrayRemove") {
      const cur = deepGet(decoded, key);
      const removals = sentinelElements(value).map((el) => JSON.stringify(encodeValue(el)));
      const arr = (Array.isArray(cur) ? cur : []).filter(
        (x) => !removals.includes(JSON.stringify(encodeValue(x))),
      );
      deepSet(decoded, key, arr);
    } else if (kind === "increment") {
      const cur = deepGet(decoded, key);
      deepSet(decoded, key, (typeof cur === "number" ? cur : 0) + sentinelOperand(value));
    } else if (value === undefined) {
      // Unreachable from update()/set() — assertNoUndefined throws first.
      // Kept as a safety net for internal callers (e.g. sentinel-stripped
      // merge payloads).
    } else {
      deepSet(decoded, key, applySentinelsInPlace(value));
    }
  }
  return decoded;
}

/** Sentinels nested inside object values of a set() payload. */
function applySentinelsInPlace(value: unknown): unknown {
  const kind = sentinelKind(value);
  if (kind === "serverTimestamp") return Timestamp.now();
  if (kind === "delete") return undefined;
  if (kind === "arrayUnion") return sentinelElements(value);
  if (kind === "arrayRemove") return [];
  if (kind === "increment") return sentinelOperand(value);
  if (Array.isArray(value)) return value.map((v) => applySentinelsInPlace(v));
  if (value && typeof value === "object" && !isTimestampLike(value) && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Sink guard (writes reject these upfront; literal comparisons on purpose)
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      const applied = applySentinelsInPlace(v);
      if (applied !== undefined) out[k] = applied;
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Low-level doc IO (all writes emit bus changes)
// ---------------------------------------------------------------------------

async function rawGet(path: string): Promise<Record<string, unknown> | undefined> {
  const segs = path.split("/");
  const spec = segs.length === 2 ? flatSpecFor(segs[0]) : undefined;
  const res = await withTenant((q) =>
    spec
      ? q<{ data: unknown }>(`SELECT data FROM ${spec.table} WHERE tenant_id = $1 AND id = $2`, [
          getTenantId(),
          segs[1],
        ])
      : q<{ data: unknown }>(`SELECT data FROM docs WHERE tenant_id = $1 AND path = $2`, [
          getTenantId(),
          path,
        ]),
  );
  if (res.rows.length === 0) return undefined;
  return decodeValue(res.rows[0].data) as Record<string, unknown>;
}

async function rawPut(
  collectionPath: string,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  const spec = flatSpecFor(collectionPath);
  const path = `${collectionPath}/${id}`;
  const json = JSON.stringify(encodeValue(data));
  await withTenant(async (q) => {
    if (spec) {
      await q(
        `INSERT INTO ${spec.table} (tenant_id, id, data) VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (tenant_id, id) DO UPDATE SET data = EXCLUDED.data`,
        [getTenantId(), id, json],
      );
    } else {
      await q(
        `INSERT INTO docs (tenant_id, path, collection_path, id, data) VALUES ($1, $2, $3, $4, $5::jsonb)
           ON CONFLICT (tenant_id, path) DO UPDATE SET data = EXCLUDED.data`,
        [getTenantId(), path, collectionPath, id, json],
      );
    }
    // Issued on the SAME connection as the write, so Postgres queues it and
    // delivers only on commit — a rolled-back write notifies nobody.
    await notifyChange(q, {
      tenant: getTenantId(),
      collection: collectionPath,
      id,
      op: "w",
    });
  });
}

async function rawDelete(path: string): Promise<void> {
  const segs = path.split("/");
  const spec = segs.length === 2 ? flatSpecFor(segs[0]) : undefined;
  await withTenant(async (q) => {
    if (spec) {
      await q(`DELETE FROM ${spec.table} WHERE tenant_id = $1 AND id = $2`, [getTenantId(), segs[1]]);
    } else {
      await q(`DELETE FROM docs WHERE tenant_id = $1 AND path = $2`, [getTenantId(), path]);
    }
    await notifyChange(q, {
      tenant: getTenantId(),
      collection: segs.slice(0, -1).join("/"),
      id: segs[segs.length - 1],
      op: "d",
    });
  });
}

async function writeDoc(
  collectionPath: string,
  id: string,
  next: Record<string, unknown> | undefined,
): Promise<void> {
  const path = `${collectionPath}/${id}`;
  const before = await rawGet(path);
  if (next === undefined) {
    await rawDelete(path);
  } else {
    await rawPut(collectionPath, id, next);
  }
  emitChange({ collectionPath, id, path, before, after: next });
}

// ---------------------------------------------------------------------------
// Snapshots / references / queries
// ---------------------------------------------------------------------------

export class DocSnapshot {
  constructor(
    public readonly id: string,
    private readonly _data: Record<string, unknown> | undefined,
    public readonly ref: DocRef,
  ) {}
  get exists(): boolean {
    return this._data !== undefined;
  }
  data(): Record<string, unknown> | undefined {
    return this._data;
  }
  get(field: string): unknown {
    return this._data ? deepGet(this._data, field) : undefined;
  }
  get createTime(): Timestamp {
    return Timestamp.now();
  }
  get updateTime(): Timestamp {
    return Timestamp.now();
  }
}

interface Filter {
  field: string;
  op: string;
  value: unknown;
}

/**
 * startAfter cursor. Snapshot form (both app call sites: tools/handlers.ts,
 * precision-search/precisionSearchQueue.ts) resolves orderBy field values
 * from the doc at query time and uses the doc ID as the implicit __name__
 * tiebreak, like real Firestore. Values form positions by the given values
 * only.
 */
type StartAfterCursor = { snap: DocSnapshot } | { values: unknown[] };

function toComparable(v: unknown): number | string {
  if (isTimestampLike(v)) return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number" || typeof v === "string") return v;
  if (v === null || v === undefined) return Number.NEGATIVE_INFINITY;
  return String(v);
}

function cmp(a: unknown, b: unknown): number {
  const ca = toComparable(a);
  const cb = toComparable(b);
  if (typeof ca === "string" || typeof cb === "string") {
    return String(ca) < String(cb) ? -1 : String(ca) > String(cb) ? 1 : 0;
  }
  return ca < cb ? -1 : ca > cb ? 1 : 0;
}

function valueEquals(a: unknown, b: unknown): boolean {
  if (isTimestampLike(a) || isTimestampLike(b) || a instanceof Date || b instanceof Date) {
    return toComparable(a) === toComparable(b);
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    return JSON.stringify(encodeValue(a)) === JSON.stringify(encodeValue(b));
  }
  return a === b;
}

function matchesFilter(data: Record<string, unknown>, f: Filter, id?: string): boolean {
  // FieldPath.documentId() / "__name__" filters compare against the doc ID.
  // App call site: learnBillingCycle.ts computeInvoiceDelays passes bare IDs;
  // path-shaped values resolve to their last segment like the real backend.
  const v =
    f.field === "__name__" && id !== undefined ? id : deepGet(data, f.field);
  if (f.field === "__name__") {
    const toId = (x: unknown) => String(x).split("/").pop();
    switch (f.op) {
      case "==":
        return v === toId(f.value);
      case "in":
        return Array.isArray(f.value) && (f.value as unknown[]).some((fv) => v === toId(fv));
      default:
        throw new Error(
          `selfhost firestore shim: unsupported operator '${f.op}' on __name__`,
        );
    }
  }
  switch (f.op) {
    case "==":
      return valueEquals(v, f.value);
    case "!=":
      return v !== undefined && !valueEquals(v, f.value);
    case ">":
      return v !== undefined && cmp(v, f.value) > 0;
    case ">=":
      return v !== undefined && cmp(v, f.value) >= 0;
    case "<":
      return v !== undefined && cmp(v, f.value) < 0;
    case "<=":
      return v !== undefined && cmp(v, f.value) <= 0;
    case "array-contains":
      return Array.isArray(v) && v.some((x) => valueEquals(x, f.value));
    case "array-contains-any":
      return (
        Array.isArray(v) &&
        Array.isArray(f.value) &&
        (f.value as unknown[]).some((fv) => (v as unknown[]).some((x) => valueEquals(x, fv)))
      );
    case "in":
      return Array.isArray(f.value) && (f.value as unknown[]).some((fv) => valueEquals(v, fv));
    case "not-in":
      return (
        v !== undefined &&
        Array.isArray(f.value) &&
        !(f.value as unknown[]).some((fv) => valueEquals(v, fv))
      );
    default:
      throw new Error(`selfhost firestore shim: unsupported operator '${f.op}'`);
  }
}

export class Query {
  constructor(
    protected readonly collectionPath: string,
    protected readonly filters: Filter[] = [],
    protected readonly orders: Array<{ field: string; dir: "asc" | "desc" }> = [],
    protected readonly limitN: number | null = null,
    protected readonly offsetN: number = 0,
    /**
     * collectionGroup mode: collectionPath is a bare collection ID matched
     * against the LAST path segment of every collection (top-level or
     * subcollection) — same semantics as Firestore collection group queries.
     */
    protected readonly isGroup: boolean = false,
    protected readonly after: StartAfterCursor | null = null,
  ) {}

  where(field: string, op: string, value: unknown): Query {
    return new Query(
      this.collectionPath,
      [...this.filters, { field, op, value }],
      this.orders,
      this.limitN,
      this.offsetN,
      this.isGroup,
      this.after,
    );
  }

  orderBy(field: string, dir: "asc" | "desc" = "asc"): Query {
    return new Query(
      this.collectionPath,
      this.filters,
      [...this.orders, { field, dir }],
      this.limitN,
      this.offsetN,
      this.isGroup,
      this.after,
    );
  }

  limit(n: number): Query {
    return new Query(
      this.collectionPath,
      this.filters,
      this.orders,
      n,
      this.offsetN,
      this.isGroup,
      this.after,
    );
  }

  offset(n: number): Query {
    return new Query(
      this.collectionPath,
      this.filters,
      this.orders,
      this.limitN,
      n,
      this.isGroup,
      this.after,
    );
  }

  startAfter(...args: unknown[]): Query {
    const cursor: StartAfterCursor =
      args.length === 1 && args[0] instanceof DocSnapshot
        ? { snap: args[0] }
        : { values: args };
    return new Query(
      this.collectionPath,
      this.filters,
      this.orders,
      this.limitN,
      this.offsetN,
      this.isGroup,
      cursor,
    );
  }

  select(..._fields: string[]): Query {
    return this; // projection ignored — full docs returned
  }

  async get(): Promise<QuerySnapshot> {
    // Flattened collections compile filters/order/cursor/limit to SQL against
    // their real table (db/pushdown.ts); everything else fetches its docs
    // rows. Either way the FULL JS pipeline below re-runs on the fetched
    // rows — pushdown narrows the fetch (and, when it compiled exactly,
    // already ordered and limited it), while the JS pipeline stays the
    // parity-pinned semantics referee. Re-filtering returned rows is a
    // no-op-safe superset check; re-sorting is idempotent; re-limiting a
    // pre-limited page is a no-op. OFFSET is never pushed (SQL LIMIT covers
    // offset+limit), so the JS offset slice applies exactly once.
    const tenantId = getTenantId();
    const spec = this.isGroup ? undefined : flatSpecFor(this.collectionPath);
    const fetched = await withTenant(async (q) => {
      if (this.isGroup) {
        const res = await q<{ id: string; collection_path: string; data: unknown }>(
          // Escape LIKE wildcards in the collection ID — the segment match
          // must be literal.
          `SELECT id, collection_path, data FROM docs
           WHERE tenant_id = $1 AND (collection_path = $2 OR collection_path LIKE $3 ESCAPE '\\')`,
          [
            tenantId,
            this.collectionPath,
            `%/${this.collectionPath.replace(/([\\%_])/g, "\\$1")}`,
          ],
        );
        const rows = res.rows.map((r) => ({ id: r.id, collectionPath: r.collection_path, data: r.data }));
        // A flattened TOP-LEVEL collection with this bare name is part of
        // the group too; its rows live in the real table, not in docs.
        const groupSpec = FLATTENED[this.collectionPath];
        if (groupSpec) {
          const extra = await q<{ id: string; data: unknown }>(
            `SELECT id, data FROM ${groupSpec.table} WHERE tenant_id = $1`,
            [tenantId],
          );
          rows.push(
            ...extra.rows.map((r) => ({ id: r.id, collectionPath: this.collectionPath, data: r.data })),
          );
        }
        return rows;
      }
      if (spec) {
        const after = this.after;
        let cursor: CursorSpec | null = null;
        if (after) {
          cursor =
            "snap" in after
              ? { values: this.orders.map((o) => after.snap.get(o.field)), snapId: after.snap.id }
              : { values: after.values, snapId: null };
        }
        const compiled = compileFlatQuery(
          spec,
          tenantId,
          this.filters,
          this.orders,
          this.limitN,
          this.offsetN,
          cursor,
        );
        const res = await q<{ id: string; data: unknown }>(compiled.sql, compiled.params);
        return res.rows.map((r) => ({ id: r.id, collectionPath: this.collectionPath, data: r.data }));
      }
      const res = await q<{ id: string; collection_path: string; data: unknown }>(
        `SELECT id, collection_path, data FROM docs WHERE tenant_id = $1 AND collection_path = $2`,
        [tenantId, this.collectionPath],
      );
      return res.rows.map((r) => ({ id: r.id, collectionPath: r.collection_path, data: r.data }));
    });
    let rows = fetched.map((r) => ({
      id: r.id,
      collectionPath: r.collectionPath,
      data: decodeValue(r.data) as Record<string, unknown>,
    }));
    for (const f of this.filters) rows = rows.filter((r) => matchesFilter(r.data, f, r.id));
    if (this.orders.length > 0) {
      // Implicit __name__ tiebreak in the direction of the last orderBy,
      // like real Firestore — needed for stable startAfter pages. Sorted
      // first; the stable orderBy sorts below then take precedence.
      const lastDir = this.orders[this.orders.length - 1].dir;
      rows.sort((a, b) => (lastDir === "desc" ? -1 : 1) * cmp(a.id, b.id));
    } else {
      // No orderBy still means ascending __name__ in Firestore. Postgres promises
      // nothing without ORDER BY, so pin it here as well as in the SQL
      // (db/pushdown.ts): this path also serves the JSONB bridge and any query the
      // pushdown declined, and the two must agree or pagination and the
      // onSnapshot poll-hash disagree between collections.
      rows.sort((a, b) => cmp(a.id, b.id));
    }
    for (const o of [...this.orders].reverse()) {
      rows.sort(
        (a, b) =>
          (o.dir === "desc" ? -1 : 1) * cmp(deepGet(a.data, o.field), deepGet(b.data, o.field)),
      );
    }
    if (this.after) {
      const after = this.after;
      const snap = "snap" in after ? after.snap : null;
      const values = snap ? this.orders.map((o) => snap.get(o.field)) : (after as { values: unknown[] }).values;
      // Keep only rows strictly past the cursor position in sort order.
      const pastCursor = (row: { id: string; data: Record<string, unknown> }): boolean => {
        for (let i = 0; i < Math.min(this.orders.length, values.length); i++) {
          const o = this.orders[i];
          const c = (o.dir === "desc" ? -1 : 1) * cmp(deepGet(row.data, o.field), values[i]);
          if (c !== 0) return c > 0;
        }
        if (snap) {
          const lastDir = this.orders.length
            ? this.orders[this.orders.length - 1].dir
            : "asc";
          return (lastDir === "desc" ? -1 : 1) * cmp(row.id, snap.id) > 0;
        }
        return false; // values form: rows equal to the cursor are excluded
      };
      rows = rows.filter(pastCursor);
    }
    if (this.offsetN) rows = rows.slice(this.offsetN);
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    const docs = rows.map(
      (r) => new DocSnapshot(r.id, r.data, new DocRef(r.collectionPath, r.id)),
    );
    return new QuerySnapshot(docs);
  }

  count(): { get: () => Promise<{ data: () => { count: number } }> } {
    return {
      get: async () => {
        const snap = await this.get();
        return { data: () => ({ count: snap.size }) };
      },
    };
  }
}

export class QuerySnapshot {
  constructor(public readonly docs: DocSnapshot[]) {}
  get empty(): boolean {
    return this.docs.length === 0;
  }
  get size(): number {
    return this.docs.length;
  }
  forEach(fn: (doc: DocSnapshot) => void): void {
    this.docs.forEach(fn);
  }
}

function generateId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 20; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

export class DocRef {
  constructor(
    public readonly collectionPath: string,
    public readonly id: string,
  ) {}

  get path(): string {
    return `${this.collectionPath}/${this.id}`;
  }

  get parent(): CollectionRef {
    return new CollectionRef(this.collectionPath);
  }

  collection(name: string): CollectionRef {
    return new CollectionRef(`${this.path}/${name}`);
  }

  async get(): Promise<DocSnapshot> {
    const data = await rawGet(this.path);
    return new DocSnapshot(this.id, data, this);
  }

  async set(
    data: Record<string, unknown>,
    opts?: { merge?: boolean },
  ): Promise<{ writeTime: Timestamp }> {
    assertNoUndefined(data, "");
    const processed = applySentinelsInPlace(data) as Record<string, unknown>;
    let next = processed;
    if (opts?.merge) {
      const existing = (await rawGet(this.path)) || {};
      next = applyUpdate(existing, flattenForMerge(processed));
    }
    await writeDoc(this.collectionPath, this.id, next);
    return { writeTime: Timestamp.now() };
  }

  async update(data: Record<string, unknown>): Promise<{ writeTime: Timestamp }> {
    for (const [key, value] of Object.entries(data)) {
      // update() keys are dot-paths — every segment must be a valid name,
      // like firebase-admin's FieldPath validation.
      for (const seg of key.split(".")) assertValidFieldName(seg, key);
      assertNoUndefined(value, key);
    }
    const existing = await rawGet(this.path);
    if (existing === undefined) {
      throw new Error(`selfhost firestore shim: update() on missing doc ${this.path}`);
    }
    const next = applyUpdate(existing, data);
    await writeDoc(this.collectionPath, this.id, next);
    return { writeTime: Timestamp.now() };
  }

  async create(data: Record<string, unknown>): Promise<{ writeTime: Timestamp }> {
    const existing = await rawGet(this.path);
    if (existing !== undefined) {
      throw new Error(`selfhost firestore shim: create() on existing doc ${this.path}`);
    }
    return this.set(data);
  }

  async delete(): Promise<{ writeTime: Timestamp }> {
    await writeDoc(this.collectionPath, this.id, undefined);
    return { writeTime: Timestamp.now() };
  }
}

/** set(merge:true) merges shallow-by-top-level-key like Firestore field paths. */
function flattenForMerge(data: Record<string, unknown>): Record<string, unknown> {
  return data;
}

export class CollectionRef extends Query {
  constructor(collectionPath: string) {
    super(collectionPath);
  }

  get id(): string {
    const segs = this.collectionPath.split("/");
    return segs[segs.length - 1];
  }

  get path(): string {
    return this.collectionPath;
  }

  doc(id?: string): DocRef {
    return new DocRef(this.collectionPath, id || generateId());
  }

  async add(data: Record<string, unknown>): Promise<DocRef> {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }

  async listDocuments(): Promise<DocRef[]> {
    const snap = await this.get();
    return snap.docs.map((d) => d.ref);
  }
}

// ---------------------------------------------------------------------------
// Batch / transaction (spike: sequential application, single-writer model)
// ---------------------------------------------------------------------------

class WriteBatch {
  private ops: Array<() => Promise<void>> = [];

  set(ref: DocRef, data: Record<string, unknown>, opts?: { merge?: boolean }): WriteBatch {
    this.ops.push(async () => {
      await ref.set(data, opts);
    });
    return this;
  }

  update(ref: DocRef, data: Record<string, unknown>): WriteBatch {
    this.ops.push(async () => {
      await ref.update(data);
    });
    return this;
  }

  delete(ref: DocRef): WriteBatch {
    this.ops.push(async () => {
      await ref.delete();
    });
    return this;
  }

  async commit(): Promise<void> {
    for (const op of this.ops) await op();
    this.ops = [];
  }
}

class TransactionShim {
  // Writes queue up and apply at commit time (after the callback resolves),
  // matching real Firestore transaction semantics — reads never see the
  // transaction's own writes, and nothing lands if the callback throws.
  private ops: Array<() => Promise<void>> = [];

  async get(refOrQuery: DocRef | Query): Promise<DocSnapshot | QuerySnapshot> {
    return refOrQuery.get() as Promise<DocSnapshot | QuerySnapshot>;
  }
  set(ref: DocRef, data: Record<string, unknown>, opts?: { merge?: boolean }): TransactionShim {
    this.ops.push(async () => {
      await ref.set(data, opts);
    });
    return this;
  }
  update(ref: DocRef, data: Record<string, unknown>): TransactionShim {
    this.ops.push(async () => {
      await ref.update(data);
    });
    return this;
  }
  delete(ref: DocRef): TransactionShim {
    this.ops.push(async () => {
      await ref.delete();
    });
    return this;
  }
  async __commit(): Promise<void> {
    for (const op of this.ops) await op();
    this.ops = [];
  }
}

// ---------------------------------------------------------------------------
// Firestore facade
// ---------------------------------------------------------------------------

class FirestoreShim {
  collection(path: string): CollectionRef {
    return new CollectionRef(path);
  }

  doc(path: string): DocRef {
    const segs = path.split("/");
    if (segs.length < 2 || segs.length % 2 !== 0) {
      throw new Error(`selfhost firestore shim: invalid doc path '${path}'`);
    }
    const id = segs.pop()!;
    return new DocRef(segs.join("/"), id);
  }

  collectionGroup(name: string): Query {
    if (!name || name.includes("/")) {
      throw new Error(`selfhost firestore shim: collectionGroup takes a collection ID, got '${name}'`);
    }
    return new Query(name, [], [], null, 0, true);
  }

  batch(): WriteBatch {
    return new WriteBatch();
  }

  async runTransaction<T>(fn: (tx: TransactionShim) => Promise<T>): Promise<T> {
    // Spike: no isolation — single-user, single-writer. Production wraps in PG tx.
    const tx = new TransactionShim();
    const result = await fn(tx);
    await tx.__commit();
    return result;
  }

  async getAll(...refs: DocRef[]): Promise<DocSnapshot[]> {
    return Promise.all(refs.map((r) => r.get()));
  }

  async recursiveDelete(ref: DocRef | CollectionRef): Promise<void> {
    const prefix = ref.path;
    const segs = prefix.split("/");
    const spec = flatSpecFor(segs[0]);
    await withTenant(async (q) => {
      const tenantId = getTenantId();
      // Flattened rows live in their real table; their subcollection docs
      // (if any) still live in `docs` and are caught by the LIKE below.
      if (spec && segs.length === 1) {
        await q(`DELETE FROM ${spec.table} WHERE tenant_id = $1`, [tenantId]);
      } else if (spec && segs.length === 2) {
        await q(`DELETE FROM ${spec.table} WHERE tenant_id = $1 AND id = $2`, [tenantId, segs[1]]);
      }
      await q(
        `DELETE FROM docs WHERE tenant_id = $1 AND (path = $2 OR path LIKE $3 OR collection_path LIKE $4)`,
        [tenantId, prefix, `${prefix}/%`, `${prefix}%`],
      );
    });
  }

  settings(_opts: unknown): void {}
}

const firestoreSingleton = new FirestoreShim();

export function getFirestore(): FirestoreShim {
  return firestoreSingleton;
}

export function initializeFirestore(): FirestoreShim {
  return firestoreSingleton;
}
