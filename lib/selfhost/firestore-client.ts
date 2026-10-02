/**
 * Self-host client Firestore shim (work item 6, slice B).
 *
 * Drop-in replacement for the subset of `firebase/firestore` the app uses,
 * swapped at module-resolution time via next.config.ts (env-gated,
 * FIBUKI_BACKEND=selfhost). Zero app-code changes — same trick as the
 * backend shims. Talks to the slice-A server data plane
 * (functions/src/selfhost/data-plane.ts) over `/__data/{query,get,write}`;
 * wire formats in frontend-shim-design.md §2.
 *
 * Covered surface (measured, frontend-shim-design.md §0):
 *   collection / doc / query / where / orderBy / limit / documentId
 *   getDoc / getDocs / onSnapshot (= poll)
 *   addDoc / setDoc / updateDoc / deleteDoc / writeBatch
 *   runTransaction (one call site: worker-request claim) via ifUnchanged
 *   serverTimestamp / increment / arrayUnion / arrayRemove / deleteField
 *   Timestamp (real class — `instanceof Timestamp` is load-bearing, x5 sites)
 *
 * Deliberately NOT covered (verified unused client-side): cursors
 * (startAfter/…), collectionGroup, or()/and(), getCountFromServer, Bytes,
 * GeoPoint. Any of those would throw rather than silently misbehave.
 */

import { pokePollers, registerPoller, isStreamHealthy, type ChangeHint } from "./poll-bus";
import { readHttpError } from "./http-error";

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

export interface FirestoreClientTransport {
  /** Base URL of fibuki-api, e.g. https://api.fibuki.home (no trailing slash). */
  apiUrl: string;
  /** Bearer token source. The auth shim (slice D) wires this to Authentik. */
  getToken: () => Promise<string | null> | string | null;
}

let _transport: FirestoreClientTransport | null = null;

/**
 * Wire the data-plane transport. Called by the auth shim once the token
 * source exists, and by tests to point at a booted host. Without it, the
 * env fallback (NEXT_PUBLIC_FIBUKI_API_URL + a token getter set via
 * __setFirestoreClientToken) is used.
 */
export function __configureFirestoreClient(t: FirestoreClientTransport): void {
  _transport = t;
}

let _envTokenGetter: FirestoreClientTransport["getToken"] = () => null;
/** Env-fallback token source (auth shim sets this if it doesn't configure the whole transport). */
export function __setFirestoreClientToken(getToken: FirestoreClientTransport["getToken"]): void {
  _envTokenGetter = getToken;
}

function transport(): FirestoreClientTransport {
  if (_transport) return _transport;
  const apiUrl =
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_FIBUKI_API_URL) || "";
  if (apiUrl) {
    _transport = { apiUrl: apiUrl.replace(/\/$/, ""), getToken: () => _envTokenGetter() };
    return _transport;
  }
  throw new FirestoreError(
    "failed-precondition",
    "Firestore client not configured: set NEXT_PUBLIC_FIBUKI_API_URL or call __configureFirestoreClient().",
  );
}

const CODE_BY_HTTP: Record<number, string> = {
  400: "invalid-argument",
  401: "unauthenticated",
  403: "permission-denied",
  404: "not-found",
  409: "aborted",
  // The host rate-limits every plane (functions/src/selfhost/rate-limit.ts); a
  // busy tab hits it before it hits anything else, and an unmapped status used to
  // reach the app as the meaningless code "unknown".
  429: "resource-exhausted",
  500: "internal",
  503: "unavailable",
};

async function post(route: "query" | "get" | "write", body: unknown): Promise<any> {
  const t = transport();
  const token = await t.getToken();
  const res = await fetch(`${t.apiUrl}/__data/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const { statusCode, message } = await readHttpError(res);
    const code = statusCode
      ? statusCode.toLowerCase().replace(/_/g, "-")
      : CODE_BY_HTTP[res.status] ?? "unknown";
    throw new FirestoreError(code, message);
  }
  const json = await res.json();
  // A successful write means every active listener is now stale, and we know it at
  // this exact moment — better information than any timer has. Poked here rather
  // than at the six write entry points (addDoc / setDoc / updateDoc / deleteDoc /
  // batch commit / runTransaction), since all of them funnel through this route.
  //
  // Without it, a user's own action takes up to a full poll interval to appear,
  // which reads as the app being broken rather than merely eventually-consistent.
  //
  // The poke names the documents this write touched, so listens refetch just
  // those. What the server's triggers write in turn arrives as change frames.
  // Without a stream nothing reports those follow-on writes, so then every
  // listen revalidates, as before.
  if (route === "write") pokePollers(isStreamHealthy() ? writeHints(body, json) : undefined);
  return json;
}

/** The documents a write touched, or undefined if any of them is unknown. */
function writeHints(body: unknown, result: unknown): ChangeHint[] | undefined {
  const ops = (body as { ops?: Array<{ type: string; path: string }> })?.ops;
  if (!Array.isArray(ops)) return undefined;
  const ids = (result as { ids?: unknown[] })?.ids;
  const hints: ChangeHint[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.type === "add") {
      // An add names its collection; the server picked the id.
      const id = Array.isArray(ids) ? ids[i] : undefined;
      if (typeof id !== "string") return undefined;
      hints.push({ collection: op.path, id });
    } else {
      const cut = op.path.lastIndexOf("/");
      if (cut <= 0) return undefined;
      hints.push({ collection: op.path.slice(0, cut), id: op.path.slice(cut + 1) });
    }
  }
  return hints;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Mirrors the FirebaseError shape the app checks (`err.code`, `err.name`). */
export class FirestoreError extends Error {
  readonly name = "FirebaseError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------------ */
/* Timestamp                                                           */
/* ------------------------------------------------------------------ */

/** Real, instanceof-safe Timestamp matching the firebase/firestore API. */
export class Timestamp {
  constructor(
    readonly seconds: number,
    readonly nanoseconds: number,
  ) {}

  static now(): Timestamp {
    return Timestamp.fromMillis(Date.now());
  }
  static fromDate(date: Date): Timestamp {
    return Timestamp.fromMillis(date.getTime());
  }
  static fromMillis(millis: number): Timestamp {
    const seconds = Math.floor(millis / 1000);
    const nanoseconds = (millis - seconds * 1000) * 1e6;
    return new Timestamp(seconds, nanoseconds);
  }

  toDate(): Date {
    return new Date(this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6));
  }
  toMillis(): number {
    return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6);
  }
  isEqual(other: Timestamp): boolean {
    return (
      other instanceof Timestamp &&
      other.seconds === this.seconds &&
      other.nanoseconds === this.nanoseconds
    );
  }
  valueOf(): string {
    // Sortable string form (SDK parity) so Timestamps order correctly if compared.
    return `${String(this.seconds).padStart(12, "0")}.${String(this.nanoseconds).padStart(9, "0")}`;
  }
  toJSON(): { seconds: number; nanoseconds: number } {
    return { seconds: this.seconds, nanoseconds: this.nanoseconds };
  }
}

/* ------------------------------------------------------------------ */
/* Sentinels (FieldValue)                                              */
/* ------------------------------------------------------------------ */

class Sentinel {
  constructor(private readonly wire: Record<string, unknown>) {}
  __toWire(): Record<string, unknown> {
    return this.wire;
  }
}

export function serverTimestamp(): Sentinel {
  return new Sentinel({ __sv: "serverTimestamp" });
}
export function increment(n: number): Sentinel {
  return new Sentinel({ __sv: "increment", n });
}
export function arrayUnion(...elements: unknown[]): Sentinel {
  return new Sentinel({ __sv: "arrayUnion", v: elements.map(encodeValue) });
}
export function arrayRemove(...elements: unknown[]): Sentinel {
  return new Sentinel({ __sv: "arrayRemove", v: elements.map(encodeValue) });
}
export function deleteField(): Sentinel {
  return new Sentinel({ __sv: "deleteField" });
}

/* ------------------------------------------------------------------ */
/* Value codec                                                         */
/* ------------------------------------------------------------------ */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** App value -> wire JSON (Timestamps/sentinels tagged, undefined dropped). */
function encodeValue(value: unknown): unknown {
  if (value instanceof Timestamp) return { __ts: [value.seconds, value.nanoseconds] };
  if (value instanceof Date) {
    const ms = value.getTime();
    const s = Math.floor(ms / 1000);
    return { __ts: [s, (ms - s * 1000) * 1e6] };
  }
  if (value instanceof Sentinel) return value.__toWire();
  if (Array.isArray(value)) return value.map(encodeValue);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = encodeValue(v);
    }
    return out;
  }
  return value;
}

/** Wire JSON -> app value (rehydrates __ts into Timestamps). */
function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (isPlainObject(value)) {
    if ("__ts" in value) {
      const ts = value.__ts as [number, number];
      return new Timestamp(ts[0], ts[1]);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = decodeValue(v);
    return out;
  }
  return value;
}

function deepGet(data: unknown, dotted: string): unknown {
  let v: unknown = data;
  for (const part of dotted.split(".")) {
    if (typeof v !== "object" || v === null) return undefined;
    v = (v as Record<string, unknown>)[part];
  }
  return v;
}

/* ------------------------------------------------------------------ */
/* References + Query                                                  */
/* ------------------------------------------------------------------ */

export interface Firestore {
  readonly __fibukiFirestore: true;
}

const _db: Firestore = { __fibukiFirestore: true };

interface QueryState {
  wheres: Array<{ field: string; op: string; value: unknown }>;
  orderBys: Array<{ field: string; dir: string }>;
  limit?: number;
}

export class Query {
  constructor(
    readonly path: string,
    readonly _state: QueryState,
  ) {}
}

export class CollectionReference extends Query {
  constructor(path: string) {
    super(path, { wheres: [], orderBys: [] });
  }
  get id(): string {
    return this.path.split("/").pop()!;
  }
}

export class DocumentReference {
  constructor(
    readonly path: string,
    readonly id: string,
  ) {}
}

function isDb(x: unknown): x is Firestore {
  return typeof x === "object" && x !== null && (x as Firestore).__fibukiFirestore === true;
}

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** 20-char auto id (Firestore parity — collision-safe enough for single-user). */
function generateId(): string {
  let id = "";
  const bytes = new Uint8Array(20);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 20; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  for (let i = 0; i < 20; i++) id += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return id;
}

/** collection(db, path) or collection(db, ...segments) — odd segment count. */
export function collection(db: unknown, ...segments: string[]): CollectionReference {
  if (!isDb(db)) throw new FirestoreError("invalid-argument", "collection() expects the Firestore instance first");
  return new CollectionReference(segments.join("/"));
}

/**
 * doc(db, ...segments) — even segment count, id = last segment.
 * doc(collectionRef) — auto-id. doc(collectionRef, id) — explicit id.
 */
export function doc(ref: unknown, ...segments: string[]): DocumentReference {
  let path: string;
  if (ref instanceof CollectionReference) {
    const id = segments.length ? segments.join("/") : generateId();
    path = `${ref.path}/${id}`;
  } else if (ref instanceof DocumentReference) {
    path = [ref.path, ...segments].join("/");
  } else if (isDb(ref)) {
    if (segments.length === 0) throw new FirestoreError("invalid-argument", "doc() needs a path");
    path = segments.join("/");
  } else {
    throw new FirestoreError("invalid-argument", "doc() expects a Firestore, collection, or document reference first");
  }
  return new DocumentReference(path, path.split("/").pop()!);
}

/* ------------------------------------------------------------------ */
/* Query constraints                                                   */
/* ------------------------------------------------------------------ */

export interface QueryConstraint {
  __apply(state: QueryState): void;
}

const DOCUMENT_ID = { __fieldPath: "__name__" as const };
/** documentId() — a field-path marker; where() serializes it as "__name__". */
export function documentId(): typeof DOCUMENT_ID {
  return DOCUMENT_ID;
}

function idOf(v: unknown): unknown {
  return v instanceof DocumentReference ? v.id : v;
}

export function where(field: unknown, op: string, value: unknown): QueryConstraint {
  const isName =
    field === DOCUMENT_ID ||
    (typeof field === "object" && field !== null && (field as { __fieldPath?: string }).__fieldPath === "__name__");
  const fieldName = isName ? "__name__" : String(field);
  const wireValue = isName
    ? Array.isArray(value)
      ? value.map(idOf)
      : idOf(value)
    : encodeValue(value);
  return { __apply: (s) => s.wheres.push({ field: fieldName, op, value: wireValue }) };
}

export function orderBy(field: unknown, dir: "asc" | "desc" = "asc"): QueryConstraint {
  const fieldName =
    typeof field === "object" && field !== null && (field as { __fieldPath?: string }).__fieldPath === "__name__"
      ? "__name__"
      : String(field);
  return { __apply: (s) => s.orderBys.push({ field: fieldName, dir }) };
}

export function limit(n: number): QueryConstraint {
  return { __apply: (s) => (s.limit = n) };
}

export function query(base: Query, ...constraints: QueryConstraint[]): Query {
  const state: QueryState = {
    wheres: [...base._state.wheres],
    orderBys: [...base._state.orderBys],
    limit: base._state.limit,
  };
  for (const c of constraints) c.__apply(state);
  return new Query(base.path, state);
}

/* ------------------------------------------------------------------ */
/* Snapshots                                                           */
/* ------------------------------------------------------------------ */

const NO_PENDING = Object.freeze({ hasPendingWrites: false, fromCache: false });

export class DocumentSnapshot {
  constructor(
    readonly id: string,
    readonly ref: DocumentReference,
    private readonly _data: Record<string, unknown> | undefined,
    private readonly _exists: boolean,
  ) {}
  exists(): boolean {
    return this._exists;
  }
  data(): Record<string, unknown> | undefined {
    return this._exists ? this._data : undefined;
  }
  get(fieldPath: string): unknown {
    // The document-id sentinel is the doc id, not a field — as the server
    // shim's DocSnapshot.get resolves it, so a future startAfter(snap) on
    // orderBy("__name__") carries a value instead of undefined.
    if (fieldPath === "__name__") return this.id;
    return deepGet(this._data, fieldPath);
  }
  get metadata() {
    return NO_PENDING;
  }
}

export class QueryDocumentSnapshot extends DocumentSnapshot {
  constructor(id: string, path: string, data: Record<string, unknown>) {
    super(id, new DocumentReference(path, id), data, true);
  }
  data(): Record<string, unknown> {
    return super.data()!;
  }
}

export class QuerySnapshot {
  constructor(readonly docs: QueryDocumentSnapshot[]) {}
  get empty(): boolean {
    return this.docs.length === 0;
  }
  get size(): number {
    return this.docs.length;
  }
  get metadata() {
    return NO_PENDING;
  }
  forEach(fn: (doc: QueryDocumentSnapshot) => void): void {
    this.docs.forEach(fn);
  }
  docChanges() {
    // Poll shim has no incremental deltas; every doc reads as "added".
    return this.docs.map((doc, i) => ({ type: "added" as const, doc, oldIndex: -1, newIndex: i }));
  }
}

function toQuerySnapshot(path: string, docs: Array<{ id: string; data: unknown }>): QuerySnapshot {
  return new QuerySnapshot(
    docs.map((d) => new QueryDocumentSnapshot(d.id, `${path}/${d.id}`, decodeValue(d.data) as Record<string, unknown>)),
  );
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

function queryBody(q: Query) {
  return { path: q.path, wheres: q._state.wheres, orderBys: q._state.orderBys, limit: q._state.limit };
}

export async function getDocs(q: Query): Promise<QuerySnapshot> {
  const r = await post("query", queryBody(q));
  return toQuerySnapshot(q.path, r.docs);
}

export async function getDoc(ref: DocumentReference): Promise<DocumentSnapshot> {
  const r = await post("get", { path: ref.path });
  return new DocumentSnapshot(
    r.id,
    ref,
    r.exists ? (decodeValue(r.data) as Record<string, unknown>) : undefined,
    r.exists,
  );
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

interface WireOp {
  type: "add" | "set" | "update" | "delete";
  path: string;
  data?: unknown;
  merge?: boolean;
  ifUnchanged?: Record<string, unknown>;
}

export async function addDoc(col: CollectionReference, data: Record<string, unknown>): Promise<DocumentReference> {
  const r = await post("write", { ops: [{ type: "add", path: col.path, data: encodeValue(data) }] });
  const id = r.ids[0];
  return new DocumentReference(`${col.path}/${id}`, id);
}

export async function setDoc(
  ref: DocumentReference,
  data: Record<string, unknown>,
  options?: { merge?: boolean },
): Promise<void> {
  await post("write", {
    ops: [{ type: "set", path: ref.path, data: encodeValue(data), merge: options?.merge === true }],
  });
}

export async function updateDoc(ref: DocumentReference, data: Record<string, unknown>): Promise<void> {
  await post("write", { ops: [{ type: "update", path: ref.path, data: encodeValue(data) }] });
}

export async function deleteDoc(ref: DocumentReference): Promise<void> {
  await post("write", { ops: [{ type: "delete", path: ref.path }] });
}

export class WriteBatch {
  private readonly ops: WireOp[] = [];
  set(ref: DocumentReference, data: Record<string, unknown>, options?: { merge?: boolean }): this {
    this.ops.push({ type: "set", path: ref.path, data: encodeValue(data), merge: options?.merge === true });
    return this;
  }
  update(ref: DocumentReference, data: Record<string, unknown>): this {
    this.ops.push({ type: "update", path: ref.path, data: encodeValue(data) });
    return this;
  }
  delete(ref: DocumentReference): this {
    this.ops.push({ type: "delete", path: ref.path });
    return this;
  }
  async commit(): Promise<void> {
    if (this.ops.length === 0) return;
    await post("write", { ops: this.ops });
  }
}

export function writeBatch(_db?: unknown): WriteBatch {
  return new WriteBatch();
}

/* ------------------------------------------------------------------ */
/* runTransaction (single site: worker-request claim)                  */
/* ------------------------------------------------------------------ */

/**
 * REST can't hold a server-side transaction, so we emulate optimistic
 * concurrency: read docs, run the callback, then submit the buffered writes
 * as ONE batch with an `ifUnchanged` precondition = the read snapshot. A
 * concurrent writer that changed the doc trips the precondition -> 409
 * ABORTED -> we retry the whole callback, exactly like the SDK. Documented
 * single-user divergence (frontend-shim-design.md §2.4).
 */
export class Transaction {
  private readonly reads = new Map<string, Record<string, unknown> | undefined>();
  private readonly ops: WireOp[] = [];

  async get(ref: DocumentReference): Promise<DocumentSnapshot> {
    const r = await post("get", { path: ref.path });
    const data = r.exists ? (decodeValue(r.data) as Record<string, unknown>) : undefined;
    this.reads.set(ref.path, data);
    return new DocumentSnapshot(r.id, ref, data, r.exists);
  }
  set(ref: DocumentReference, data: Record<string, unknown>, options?: { merge?: boolean }): this {
    this.ops.push(
      this.precondition(
        { type: "set", path: ref.path, data: encodeValue(data), merge: options?.merge === true },
        ref.path,
      ),
    );
    return this;
  }
  update(ref: DocumentReference, data: Record<string, unknown>): this {
    this.ops.push(this.precondition({ type: "update", path: ref.path, data: encodeValue(data) }, ref.path));
    return this;
  }
  delete(ref: DocumentReference): this {
    this.ops.push(this.precondition({ type: "delete", path: ref.path }, ref.path));
    return this;
  }

  private precondition(op: WireOp, path: string): WireOp {
    if (this.reads.has(path)) {
      const read = this.reads.get(path);
      // Only guard against a doc we saw as existing; a create-race isn't the
      // failure mode the one call site (claiming an existing request) needs.
      if (read !== undefined) op.ifUnchanged = encodeValue(read) as Record<string, unknown>;
    }
    return op;
  }

  async __commit(): Promise<void> {
    if (this.ops.length > 0) await post("write", { ops: this.ops });
  }
}

export async function runTransaction<T>(
  _db: unknown,
  updateFunction: (transaction: Transaction) => Promise<T>,
  options?: { maxAttempts?: number },
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 5;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const tx = new Transaction();
    const result = await updateFunction(tx); // callback errors propagate, not retried
    try {
      await tx.__commit();
      return result;
    } catch (err) {
      if (err instanceof FirestoreError && err.code === "aborted") {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError ?? new FirestoreError("aborted", "Transaction failed after retries");
}

/* ------------------------------------------------------------------ */
/* onSnapshot = poll                                                   */
/* ------------------------------------------------------------------ */

export type Unsubscribe = () => void;

type NextFn = (snap: any) => void;
type ErrFn = (err: FirestoreError) => void;
interface Observer {
  next?: NextFn;
  error?: ErrFn;
}

function normalizeObserver(a: NextFn | Observer | undefined, b?: ErrFn): { next: NextFn; error?: ErrFn } {
  if (typeof a === "object" && a !== null) return { next: a.next ?? (() => {}), error: a.error };
  return { next: a ?? (() => {}), error: b };
}

function pollMs(): number {
  const raw = typeof process !== "undefined" && process.env?.NEXT_PUBLIC_FIBUKI_POLL_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 2500;
}

/**
 * Interval to use right now.
 *
 * While the realtime stream is delivering, the timer is a safety net rather than
 * the mechanism, so it backs off hard — that removes most idle traffic, which at a
 * few seconds times ~8 live listeners per tab was the bulk of it. The moment the
 * stream drops, this returns to the configured interval on the very next cycle,
 * which is why the timer below re-reads it each time instead of capturing it once.
 *
 * Never returns Infinity: a stream can be up and still miss an event, and a slow
 * poll converges where no poll would not.
 */
const STREAM_HEALTHY_POLL_MS = 60_000;

function effectivePollMs(): number {
  const configured = pollMs();
  // Respect a deployment that deliberately polls slower than the safety net.
  return isStreamHealthy() ? Math.max(configured, STREAM_HEALTHY_POLL_MS) : configured;
}

/**
 * onSnapshot(target, onNext, onError?): one shared listen per query.
 *
 * ## Why shared
 *
 * Every listen is an HTTP query, so two hooks asking for the same files list
 * used to cost two round trips, and a panel that mounts a hook the table
 * already has waited on a fetch for data that was already in the tab.
 * firebase/firestore dedupes identical listeners and answers from its cache;
 * this does the same. All listeners on one query (same path, filters, order
 * and limit) share one listen. A newcomer gets the result the listen already
 * holds straight away, and one request serves all of them afterwards.
 *
 * ## How a listen stays current
 *
 * A change frame from the realtime stream names the document that changed
 * (poll-bus.ts). A query listen on that collection then asks the server only
 * "which of these ids still match my query?" (`ids` on /__data/query) and
 * merges the answer: replace in place, or drop. The server applies the same
 * filters and access policy as for the full query, so the client never
 * re-decides membership. Whenever the merge would have to decide something
 * only the server can (a new member's position, a changed sort key, any
 * `limit` window), it refetches the whole query instead.
 *
 * ## How it heals
 *
 * The targeted refetch is an optimisation, never the source of truth. A full
 * revalidation replaces the listen's result outright, and one runs:
 *  - on the safety-net timer (60s while the stream is up, the configured poll
 *    interval while it is down),
 *  - when the stream (re)connects (change-stream-client.ts),
 *  - when the tab becomes visible again (hidden tabs fetch nothing),
 *  - after any callable or hint-less poke,
 *  - when a newcomer joins a listen that was idle in its keep-alive window,
 *  - when a targeted refetch fails.
 * A full revalidation sends the hash of the result it holds (`ifHash`), so an
 * unchanged result costs a tiny "unchanged" answer rather than the whole list.
 *
 * ## Lifetime
 *
 * When the last listener leaves, the listen is kept for KEEP_ALIVE_MS without
 * its timer, still applying change frames, so closing and reopening a panel
 * stays instant. Rejoining it also triggers a revalidation, because without
 * the timer it may have missed something.
 *
 * Errors go to onError. An exception from a listener's own handler is
 * rethrown to the host (#124) and that listener is offered the same result
 * again on the next cycle.
 */

/** How long a listen nobody holds keeps its result for the next one. */
const KEEP_ALIVE_MS = 30_000;
/** Past this many changed ids in one window, one full refetch is cheaper. */
const MAX_DELTA_IDS = 50;
/** Inequality filters order the result by their field even without an orderBy */
const RANGE_OPS = new Set(["<", "<=", ">", ">=", "!=", "not-in"]);

type WireDoc = { id: string; data: unknown };

interface Subscriber {
  next: NextFn;
  error?: ErrFn;
  /** contentKey of the result this listener last accepted without throwing. */
  delivered: string | null;
}

interface Listen {
  key: string;
  target: Query | DocumentReference;
  isDoc: boolean;
  subs: Set<Subscriber>;
  /** Query listens: the result as wire docs, in the server's order. */
  docs: WireDoc[];
  /** Doc listens: the raw /get response. */
  docRaw: unknown;
  loaded: boolean;
  /** Serialized result; what "did it change" and "was it delivered" compare. */
  contentKey: string | null;
  /** Server hash of the last FULL result, dropped once a merge changes it. */
  serverHash: string | null;
  inFlight: boolean;
  wantFull: boolean;
  wantIds: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  keepAlive: ReturnType<typeof setTimeout> | null;
  unregister: () => void;
  disposed: boolean;
}

const listens = new Map<string, Listen>();

function listenKey(target: Query | DocumentReference): string {
  return target instanceof DocumentReference
    ? `d:${target.path}`
    : `q:${JSON.stringify(queryBody(target))}`;
}

function buildSnapshot(l: Listen): unknown {
  if (l.isDoc) {
    const ref = l.target as DocumentReference;
    const raw = l.docRaw as { id: string; exists: boolean; data: unknown };
    return new DocumentSnapshot(
      raw.id,
      ref,
      raw.exists ? (decodeValue(raw.data) as Record<string, unknown>) : undefined,
      raw.exists,
    );
  }
  // Decoded per listener, as before sharing: a handler that mutates what it
  // was given must not reach into another listener's data.
  return toQuerySnapshot((l.target as Query).path, l.docs);
}

function deliver(l: Listen): void {
  if (!l.loaded || l.disposed) return;
  for (const sub of [...l.subs]) {
    if (sub.delivered === l.contentKey || !l.subs.has(sub)) continue;
    // The listener's own handler runs OUTSIDE the onError funnel. An exception
    // here is application code failing, not the listen, and firebase/firestore
    // lets it reach the host rather than dressing it up as a FirebaseError
    // (#124). `delivered` stays put, so the next cycle offers it again even if
    // nothing changed, instead of leaving the listener dark.
    try {
      sub.next(buildSnapshot(l));
    } catch (err) {
      setTimeout(() => {
        throw err;
      });
      continue;
    }
    sub.delivered = l.contentKey;
  }
}

function fail(l: Listen, err: unknown): void {
  const fe =
    err instanceof FirestoreError ? err : new FirestoreError("unknown", String((err as Error)?.message ?? err));
  for (const sub of [...l.subs]) sub.error?.(fe);
}

/** Fields whose change can move a document within the result. */
function orderingFields(q: Query): string[] {
  const fields = q._state.orderBys.map((o) => o.field);
  for (const w of q._state.wheres) if (RANGE_OPS.has(w.op)) fields.push(w.field);
  return fields.filter((f) => f !== "__name__");
}

async function fetchFull(l: Listen): Promise<void> {
  if (l.isDoc) {
    const raw = await post("get", { path: (l.target as DocumentReference).path });
    l.docRaw = raw;
    l.contentKey = JSON.stringify(raw);
    l.loaded = true;
    return;
  }
  const body = queryBody(l.target as Query);
  const r = await post("query", l.loaded && l.serverHash ? { ...body, ifHash: l.serverHash } : body);
  if (r.unchanged) {
    if (l.loaded) return;
    // Cannot happen (ifHash is only sent once loaded), but never trust it blind.
    const again = await post("query", body);
    return applyFull(l, again);
  }
  applyFull(l, r);
}

function applyFull(l: Listen, r: { docs: WireDoc[]; hash?: string }): void {
  l.docs = r.docs;
  l.serverHash = typeof r.hash === "string" ? r.hash : null;
  l.contentKey = JSON.stringify(r.docs);
  l.loaded = true;
}

/**
 * Merge "which of these ids still match" into the held result. Returns false
 * when the merge would need a decision only the server can make, in which case
 * nothing was changed and the caller refetches the whole query.
 */
async function fetchDelta(l: Listen, ids: string[]): Promise<boolean> {
  const q = l.target as Query;
  const body = queryBody(q);
  const r = await post("query", { path: body.path, wheres: body.wheres, orderBys: body.orderBys, ids });
  const fresh = new Map<string, WireDoc>((r.docs as WireDoc[]).map((d) => [d.id, d]));
  const ordering = orderingFields(q);
  const docs = [...l.docs];

  for (const id of ids) {
    const next = fresh.get(id);
    const at = docs.findIndex((d) => d.id === id);
    if (!next) {
      if (at !== -1) docs.splice(at, 1); // deleted, or no longer matches
      continue;
    }
    if (at === -1) return false; // a new member: where it sorts is the server's call
    const moved = ordering.some(
      (f) => JSON.stringify(deepGet(docs[at].data, f)) !== JSON.stringify(deepGet(next.data, f)),
    );
    if (moved) return false;
    docs[at] = next;
  }

  const key = JSON.stringify(docs);
  if (key !== l.contentKey) {
    l.docs = docs;
    l.contentKey = key;
    l.serverHash = null; // the server never saw this exact result; next full sends no hash
  }
  return true;
}

async function run(l: Listen): Promise<void> {
  if (l.inFlight || l.disposed) return; // the running loop picks up what was asked
  if (typeof document !== "undefined" && document.hidden) return; // wants stay set; visibility resumes
  l.inFlight = true;
  try {
    while (!l.disposed && (l.wantFull || l.wantIds.size > 0)) {
      const canDelta =
        l.loaded && !l.isDoc && (l.target as Query)._state.limit === undefined && l.wantIds.size <= MAX_DELTA_IDS;
      const full = l.wantFull || !canDelta;
      const ids = [...l.wantIds];
      l.wantFull = false;
      l.wantIds.clear();
      try {
        if (full) {
          await fetchFull(l);
        } else if (!(await fetchDelta(l, ids))) {
          l.wantFull = true;
          continue;
        }
      } catch (err) {
        if (l.disposed) return;
        // Whatever was asked is still owed. A full revalidation is the safe
        // way to pay it, on the next timer tick or poke rather than in a tight
        // loop against a failing server.
        l.wantFull = true;
        fail(l, err);
        return;
      }
      deliver(l);
    }
    // A listener that threw is offered the same result again (#124).
    deliver(l);
  } finally {
    l.inFlight = false;
  }
}

function poke(l: Listen, hints: readonly ChangeHint[] | null): void {
  if (hints === null) {
    l.wantFull = true;
  } else {
    for (const h of hints) {
      if (l.isDoc) {
        if (`${h.collection}/${h.id}` === (l.target as DocumentReference).path) l.wantFull = true;
      } else if (h.collection === (l.target as Query).path) {
        l.wantIds.add(h.id);
      }
    }
  }
  if (l.wantFull || l.wantIds.size > 0) void run(l);
}

function startTimer(l: Listen): void {
  // Self-scheduling rather than setInterval, so the interval is re-read every
  // cycle and a stream going up or down takes effect immediately, and a slow
  // request can never stack up behind itself.
  const schedule = (): void => {
    if (l.disposed || l.subs.size === 0) return;
    l.timer = setTimeout(() => {
      l.wantFull = true;
      void run(l).finally(schedule);
    }, effectivePollMs());
  };
  schedule();
}

function stopTimer(l: Listen): void {
  if (l.timer) clearTimeout(l.timer);
  l.timer = null;
}

function dispose(l: Listen): void {
  l.disposed = true;
  stopTimer(l);
  if (l.keepAlive) clearTimeout(l.keepAlive);
  l.unregister();
  if (listens.get(l.key) === l) listens.delete(l.key);
}

function createListen(key: string, target: Query | DocumentReference): Listen {
  const l: Listen = {
    key,
    target,
    isDoc: target instanceof DocumentReference,
    subs: new Set(),
    docs: [],
    docRaw: null,
    loaded: false,
    contentKey: null,
    serverHash: null,
    inFlight: false,
    wantFull: false,
    wantIds: new Set(),
    timer: null,
    keepAlive: null,
    unregister: () => {},
    disposed: false,
  };
  l.unregister = registerPoller((hints) => poke(l, hints));
  return l;
}

let visibilityHooked = false;
function hookVisibility(): void {
  if (visibilityHooked || typeof document === "undefined") return;
  visibilityHooked = true;
  // A hidden tab fetches nothing, so it may have missed anything: revalidate
  // every held listen the moment it is looked at again.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    for (const l of listens.values()) {
      if (l.subs.size === 0) continue;
      l.wantFull = true;
      void run(l);
    }
  });
}

export function onSnapshot(
  target: Query | DocumentReference,
  onNextOrObserver: NextFn | Observer,
  onError?: ErrFn,
): Unsubscribe {
  const { next, error } = normalizeObserver(onNextOrObserver, onError);
  hookVisibility();

  const key = listenKey(target);
  let l = listens.get(key);
  if (!l || l.disposed) {
    l = createListen(key, target);
    listens.set(key, l);
  }
  const listen = l;
  const sub: Subscriber = { next, error, delivered: null };
  const wasIdle = listen.subs.size === 0;
  listen.subs.add(sub);
  if (listen.keepAlive) {
    clearTimeout(listen.keepAlive);
    listen.keepAlive = null;
  }
  if (wasIdle) startTimer(listen);

  if (!listen.loaded) {
    // First load, or one already in flight that will deliver to everyone.
    listen.wantFull = true;
    void run(listen);
  } else {
    // Instant: hand the newcomer what the listen already holds. Asynchronous,
    // as firebase/firestore is, so a caller may unsubscribe from inside its
    // own first callback.
    queueMicrotask(() => {
      if (listen.subs.has(sub)) deliver(listen);
    });
    if (wasIdle) {
      listen.wantFull = true;
      void run(listen);
    }
  }

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    listen.subs.delete(sub);
    if (listen.subs.size === 0 && !listen.disposed) {
      stopTimer(listen);
      listen.keepAlive = setTimeout(() => dispose(listen), KEEP_ALIVE_MS);
      // Never let a cache hold a Node process (tests, SSR) open.
      (listen.keepAlive as { unref?: () => void }).unref?.();
    }
  };
}

/**
 * Test seam: resolve once no shared listen has a request in flight or work
 * queued, and none picked any up in the following macrotask. Lets a test
 * assert "nothing was delivered" deterministically instead of sleeping.
 */
export async function __whenListensIdle(): Promise<void> {
  const busy = () => [...listens.values()].some((l) => l.inFlight || l.wantFull || l.wantIds.size > 0);
  for (;;) {
    while (busy()) await new Promise<void>((r) => setTimeout(r, 1));
    await new Promise<void>((r) => setTimeout(r, 0));
    if (!busy()) return;
  }
}

/** Test seam: drop every shared listen so cases cannot see each other's cache. */
export function __resetListens(): void {
  for (const l of [...listens.values()]) dispose(l);
}

/** Test/diagnostic hook: how many shared listens are held, and by how many. */
export function __listenStats(): Array<{ key: string; subscribers: number; loaded: boolean }> {
  return [...listens.values()].map((l) => ({ key: l.key, subscribers: l.subs.size, loaded: l.loaded }));
}

/* ------------------------------------------------------------------ */
/* Firestore instance + no-ops                                         */
/* ------------------------------------------------------------------ */

export function getFirestore(_app?: unknown): Firestore {
  return _db;
}

export function initializeFirestore(_app: unknown, _settings?: unknown): Firestore {
  return _db;
}

export function connectFirestoreEmulator(_db: unknown, _host: string, _port: number): void {
  /* no-op: the selfhost client talks to fibuki-api, never an emulator */
}
