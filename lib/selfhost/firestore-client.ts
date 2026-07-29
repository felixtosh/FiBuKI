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
  500: "internal",
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
    let message = res.statusText;
    let statusCode = "";
    try {
      const j = await res.json();
      if (j?.error?.message) message = j.error.message;
      if (j?.error?.status) statusCode = j.error.status;
    } catch {
      /* non-JSON body — fall back to HTTP status */
    }
    const code = statusCode
      ? statusCode.toLowerCase().replace(/_/g, "-")
      : CODE_BY_HTTP[res.status] ?? "unknown";
    throw new FirestoreError(code, message);
  }
  return res.json();
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
 * onSnapshot(target, onNext, onError?) — polling emulation. Fires on the
 * initial load and whenever the serialized response changes. Pauses while
 * the tab is hidden (document.hidden), resumes on visibilitychange. Errors
 * go to onError (the central hook already surfaces them). Unsubscribe stops
 * the timer.
 */
export function onSnapshot(
  target: Query | DocumentReference,
  onNextOrObserver: NextFn | Observer,
  onError?: ErrFn,
): Unsubscribe {
  const { next, error } = normalizeObserver(onNextOrObserver, onError);
  const isDoc = target instanceof DocumentReference;
  const interval = pollMs();

  let stopped = false;
  let lastHash: string | null = null;
  let inFlight = false;

  async function tick(): Promise<void> {
    if (stopped || inFlight) return;
    if (typeof document !== "undefined" && document.hidden) return;
    inFlight = true;
    try {
      const raw = isDoc
        ? await post("get", { path: (target as DocumentReference).path })
        : await post("query", queryBody(target as Query));
      if (stopped) return;
      const hash = JSON.stringify(raw);
      if (hash === lastHash) return;
      lastHash = hash;
      if (isDoc) {
        const ref = target as DocumentReference;
        next(
          new DocumentSnapshot(
            raw.id,
            ref,
            raw.exists ? (decodeValue(raw.data) as Record<string, unknown>) : undefined,
            raw.exists,
          ),
        );
      } else {
        next(toQuerySnapshot((target as Query).path, raw.docs));
      }
    } catch (err) {
      if (stopped) return; // unsubscribed mid-flight — don't deliver a late error
      const fe = err instanceof FirestoreError ? err : new FirestoreError("unknown", String((err as Error)?.message ?? err));
      error?.(fe);
    } finally {
      inFlight = false;
    }
  }

  void tick();
  const timer = setInterval(() => void tick(), interval);
  const onVisibility = (): void => {
    if (typeof document !== "undefined" && !document.hidden) void tick();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

  return () => {
    stopped = true;
    clearInterval(timer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
  };
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
