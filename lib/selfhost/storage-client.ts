/**
 * Self-host client Storage shim (work item 6, slice C).
 *
 * Drop-in replacement for the subset of `firebase/storage` the app uses,
 * swapped at module-resolution time the same way as the firestore-client and
 * functions-client shims (lib/selfhost/firestore-client.ts,
 * lib/selfhost/functions-client.ts) — env-gated, FIBUKI_BACKEND=selfhost,
 * zero app-code changes.
 *
 * Speaks the blob wire protocol the host implements
 * (functions/src/selfhost/storage-routes.ts), serving the server-side blob
 * surface (functions/src/selfhost/storage-shim.ts) over HTTP:
 *   POST   /__storage/upload?path=<p>&contentType=<ct>   raw bytes body
 *          -> { path, downloadUrl }
 *   GET    /__storage/download/<path>                    -> raw bytes
 *          (accepts Bearer OR ?token= — the latter for <img>/<iframe> src)
 *   DELETE /__storage/object/<path>                       -> { ok: true }
 *
 * Covered surface (measured 2026-07-14 across all client call sites):
 *   getStorage / connectStorageEmulator (no-op) / ref
 *   uploadBytes / uploadBytesResumable / getDownloadURL / getBytes / deleteObject
 *
 * Deliberately self-contained: the transport/error plumbing is duplicated
 * from firestore-client.ts / functions-client.ts rather than imported, since
 * these shims alias to different upstream modules at build time and must not
 * create a cross-dependency between them.
 *
 * Single-user divergences from the real SDK (documented, not bugs):
 *   - uploadBytesResumable() is NOT actually resumable (no chunked/restart
 *     protocol) — it is a single request whose progress is reported via
 *     XMLHttpRequest.upload.onprogress where available, or a synthetic
 *     0% -> 100% pair when XHR isn't available (Node/test environments).
 *   - getDownloadURL() embeds the current bearer token as a `?token=` query
 *     parameter so the URL is usable directly as an <img>/<iframe> `src`
 *     (which cannot carry an Authorization header). This is weaker than a
 *     real Firebase Storage download token but fine for a single-user LAN
 *     deployment.
 */

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

export interface StorageClientTransport {
  /** Base URL of fibuki-api, e.g. https://api.fibuki.home (no trailing slash). */
  apiUrl: string;
  /** Bearer token source. The auth shim (slice D) wires this to Authentik. */
  getToken: () => Promise<string | null> | string | null;
}

let _transport: StorageClientTransport | null = null;

/**
 * Wire the storage transport. Called by the auth shim once the token source
 * exists, and by tests to point at a booted host. Without it, the env
 * fallback (NEXT_PUBLIC_FIBUKI_API_URL + a token getter set via
 * __setStorageClientToken) is used.
 */
export function __configureStorageClient(t: StorageClientTransport): void {
  _transport = t;
}

let _envTokenGetter: StorageClientTransport["getToken"] = () => null;
/** Env-fallback token source (auth shim sets this if it doesn't configure the whole transport). */
export function __setStorageClientToken(getToken: StorageClientTransport["getToken"]): void {
  _envTokenGetter = getToken;
}

function transport(): StorageClientTransport {
  if (_transport) return _transport;
  const apiUrl =
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_FIBUKI_API_URL) || "";
  if (apiUrl) {
    _transport = { apiUrl: apiUrl.replace(/\/$/, ""), getToken: () => _envTokenGetter() };
    return _transport;
  }
  throw new StorageError(
    "storage/unknown",
    "Storage client not configured: set NEXT_PUBLIC_FIBUKI_API_URL or call __configureStorageClient().",
  );
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Mirrors the FirebaseError shape the app checks (`err.code`, `err.name`), firebase/storage-flavored codes. */
export class StorageError extends Error {
  readonly name = "FirebaseError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function toStorageError(res: Response): Promise<StorageError> {
  let message = res.statusText;
  try {
    const j = await res.json();
    if (j?.error?.message) message = j.error.message;
  } catch {
    /* non-JSON body — fall back to HTTP status */
  }
  const code =
    res.status === 404
      ? "storage/object-not-found"
      : res.status === 401 || res.status === 403
        ? "storage/unauthorized"
        : "storage/unknown";
  return new StorageError(code, message);
}

function xhrError(xhr: XMLHttpRequest): StorageError {
  let message = xhr.statusText || "Upload failed";
  try {
    const j = JSON.parse(xhr.responseText);
    if (j?.error?.message) message = j.error.message;
  } catch {
    /* non-JSON body */
  }
  const code =
    xhr.status === 404
      ? "storage/object-not-found"
      : xhr.status === 401 || xhr.status === 403
        ? "storage/unauthorized"
        : "storage/unknown";
  return new StorageError(code, message);
}

/* ------------------------------------------------------------------ */
/* Storage instance + references                                       */
/* ------------------------------------------------------------------ */

export interface FirebaseStorage {
  readonly __fibukiStorage: true;
}

const _storage: FirebaseStorage = { __fibukiStorage: true };

function isStorage(x: unknown): x is FirebaseStorage {
  return typeof x === "object" && x !== null && (x as FirebaseStorage).__fibukiStorage === true;
}

/** Matches the server storage-shim's default bucket name (functions/src/selfhost/storage-shim.ts). */
const DEFAULT_BUCKET = "fibuki-selfhost";

export class StorageReference {
  constructor(
    readonly fullPath: string,
    readonly bucket: string,
  ) {}

  get name(): string {
    return this.fullPath.split("/").pop() ?? "";
  }

  toString(): string {
    return `gs://${this.bucket}/${this.fullPath}`;
  }
}

/** getStorage(app?) — load-safe opaque handle; config.ts calls this at module load. */
export function getStorage(_app?: unknown, _bucketUrl?: string): FirebaseStorage {
  return _storage;
}

export function connectStorageEmulator(_storage: unknown, _host: string, _port: number): void {
  /* no-op: the selfhost client talks to fibuki-api, never an emulator */
}

/**
 * ref(storage, path) — new reference from the Storage instance.
 * ref(existingRef, childPath?) — child reference relative to an existing one
 * (childPath omitted returns the same reference, SDK parity).
 */
export function ref(storageOrRef: unknown, path?: string): StorageReference {
  if (storageOrRef instanceof StorageReference) {
    if (!path) return storageOrRef;
    const base = storageOrRef.fullPath.replace(/\/+$/, "");
    const child = path.replace(/^\/+/, "");
    return new StorageReference(`${base}/${child}`, storageOrRef.bucket);
  }
  if (isStorage(storageOrRef)) {
    if (!path) {
      throw new StorageError("storage/invalid-argument", "ref() requires a path when called with the Storage instance");
    }
    return new StorageReference(path.replace(/^\/+/, ""), DEFAULT_BUCKET);
  }
  throw new StorageError(
    "storage/invalid-argument",
    "ref() expects a FirebaseStorage instance or StorageReference first",
  );
}

/* ------------------------------------------------------------------ */
/* Path encoding                                                       */
/* ------------------------------------------------------------------ */

/** Percent-encode each segment (never the "/" separators) for use in a URL path. */
function encodePathSegments(fullPath: string): string {
  return fullPath.split("/").map(encodeURIComponent).join("/");
}

function downloadPath(ref: StorageReference): string {
  return `/__storage/download/${encodePathSegments(ref.fullPath)}`;
}

/* ------------------------------------------------------------------ */
/* Base64-JSON helper (custom metadata header, cross-env)              */
/* ------------------------------------------------------------------ */

function toBase64Json(obj: unknown): string {
  const json = JSON.stringify(obj);
  if (typeof btoa === "function") {
    const bytes = new TextEncoder().encode(json);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  }
  return Buffer.from(json, "utf-8").toString("base64");
}

/* ------------------------------------------------------------------ */
/* Upload data helpers                                                 */
/* ------------------------------------------------------------------ */

/** Data accepted by uploadBytes/uploadBytesResumable. File is covered via Blob (its runtime supertype). */
export type UploadData = Blob | Uint8Array | ArrayBuffer;

export interface UploadMetadata {
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  customMetadata?: Record<string, string>;
}

function byteLength(data: UploadData): number {
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  if (data instanceof Uint8Array) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return 0;
}

function inferContentType(data: UploadData, metadata?: UploadMetadata): string | undefined {
  if (metadata?.contentType) return metadata.contentType;
  if (typeof Blob !== "undefined" && data instanceof Blob && data.type) return data.type;
  return undefined;
}

function uploadUrl(t: StorageClientTransport, ref: StorageReference, contentType: string | undefined): string {
  const qp = new URLSearchParams({ path: ref.fullPath });
  if (contentType) qp.set("contentType", contentType);
  return `${t.apiUrl}/__storage/upload?${qp.toString()}`;
}

/* ------------------------------------------------------------------ */
/* uploadBytes                                                         */
/* ------------------------------------------------------------------ */

export interface UploadResult {
  ref: StorageReference;
  metadata: {
    fullPath: string;
    name: string;
    bucket: string;
    size: number;
    contentType?: string;
    customMetadata?: Record<string, string>;
  };
}

export async function uploadBytes(
  ref: StorageReference,
  data: UploadData,
  metadata?: UploadMetadata,
): Promise<UploadResult> {
  const t = transport();
  const token = await t.getToken();
  const contentType = inferContentType(data, metadata);
  const headers: Record<string, string> = { "content-type": contentType || "application/octet-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (metadata?.customMetadata) headers["x-fibuki-custom"] = toBase64Json(metadata.customMetadata);

  const res = await fetch(uploadUrl(t, ref, contentType), {
    method: "POST",
    headers,
    body: data as BodyInit,
  });
  if (!res.ok) throw await toStorageError(res);
  await res.json(); // { path, downloadUrl } — not needed by call sites, but drain the body

  return {
    ref,
    metadata: {
      fullPath: ref.fullPath,
      name: ref.name,
      bucket: ref.bucket,
      size: byteLength(data),
      contentType,
      customMetadata: metadata?.customMetadata,
    },
  };
}

/* ------------------------------------------------------------------ */
/* uploadBytesResumable                                                */
/* ------------------------------------------------------------------ */

export type TaskState = "running" | "paused" | "success" | "canceled" | "error";

export interface UploadTaskSnapshot {
  ref: StorageReference;
  bytesTransferred: number;
  totalBytes: number;
  state: TaskState;
}

type NextFn = (snapshot: UploadTaskSnapshot) => void;
type ErrorFn = (error: StorageError) => void;
type CompleteFn = () => void;

/**
 * NOT actually resumable — single-request upload (single-user LAN divergence,
 * see module banner). Thenable + `.on("state_changed", ...)`, SDK parity for
 * the fields call sites read (`snapshot.bytesTransferred/totalBytes/ref`).
 */
export interface UploadTask {
  readonly snapshot: UploadTaskSnapshot;
  on(
    event: "state_changed",
    next?: NextFn | null,
    error?: ErrorFn | null,
    complete?: CompleteFn | null,
  ): () => void;
  then<TResult1 = UploadTaskSnapshot, TResult2 = never>(
    onfulfilled?: ((value: UploadTaskSnapshot) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<UploadTaskSnapshot | TResult>;
}

class UploadTaskImpl implements UploadTask {
  private nextListeners: NextFn[] = [];
  private errorListeners: ErrorFn[] = [];
  private completeListeners: CompleteFn[] = [];
  private _snapshot: UploadTaskSnapshot;
  private readonly donePromise: Promise<UploadTaskSnapshot>;
  private resolveDone!: (s: UploadTaskSnapshot) => void;
  private rejectDone!: (e: unknown) => void;

  constructor(ref: StorageReference, totalBytes: number) {
    this._snapshot = { ref, bytesTransferred: 0, totalBytes, state: "running" };
    this.donePromise = new Promise<UploadTaskSnapshot>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
  }

  get snapshot(): UploadTaskSnapshot {
    return this._snapshot;
  }

  on(
    _event: "state_changed",
    next?: NextFn | null,
    error?: ErrorFn | null,
    complete?: CompleteFn | null,
  ): () => void {
    if (next) {
      this.nextListeners.push(next);
      next(this._snapshot); // replay current state so late subscribers see at least one event
    }
    if (error) this.errorListeners.push(error);
    if (complete) this.completeListeners.push(complete);
    return () => {
      if (next) this.nextListeners = this.nextListeners.filter((f) => f !== next);
      if (error) this.errorListeners = this.errorListeners.filter((f) => f !== error);
      if (complete) this.completeListeners = this.completeListeners.filter((f) => f !== complete);
    };
  }

  then<TResult1 = UploadTaskSnapshot, TResult2 = never>(
    onfulfilled?: ((value: UploadTaskSnapshot) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.donePromise.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<UploadTaskSnapshot | TResult> {
    return this.donePromise.catch(onrejected);
  }

  _progress(bytesTransferred: number): void {
    this._snapshot = { ...this._snapshot, bytesTransferred, state: "running" };
    for (const l of this.nextListeners) l(this._snapshot);
  }
  _success(): void {
    this._snapshot = { ...this._snapshot, bytesTransferred: this._snapshot.totalBytes, state: "success" };
    for (const l of this.nextListeners) l(this._snapshot);
    for (const l of this.completeListeners) l();
    this.resolveDone(this._snapshot);
  }
  _fail(err: StorageError): void {
    this._snapshot = { ...this._snapshot, state: "error" };
    for (const l of this.errorListeners) l(err);
    this.rejectDone(err);
  }
}

async function runResumableUpload(
  task: UploadTaskImpl,
  ref: StorageReference,
  data: UploadData,
  metadata: UploadMetadata | undefined,
  total: number,
): Promise<void> {
  const t = transport();
  const token = await t.getToken();
  const contentType = inferContentType(data, metadata);
  const url = uploadUrl(t, ref, contentType);
  const customHeader = metadata?.customMetadata ? toBase64Json(metadata.customMetadata) : undefined;

  if (typeof XMLHttpRequest !== "undefined") {
    await new Promise<void>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url, true);
      xhr.setRequestHeader("content-type", contentType || "application/octet-stream");
      if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
      if (customHeader) xhr.setRequestHeader("x-fibuki-custom", customHeader);
      xhr.upload.onprogress = (e) => {
        task._progress(e.lengthComputable ? e.loaded : task.snapshot.bytesTransferred);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          task._success();
        } else {
          task._fail(xhrError(xhr));
        }
        resolve();
      };
      xhr.onerror = () => {
        task._fail(new StorageError("storage/unknown", "Network error during upload"));
        resolve();
      };
      // Cast: Blob | Uint8Array | ArrayBuffer are all valid XHR bodies at
      // runtime; the generic Uint8Array<ArrayBufferLike> type doesn't
      // structurally match XMLHttpRequestBodyInit under this TS lib version.
      xhr.send(data as XMLHttpRequestBodyInit);
    });
    return;
  }

  // Node / no-XHR fallback (test environments): synthetic 0% -> 100% pair.
  task._progress(0);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": contentType || "application/octet-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(customHeader ? { "x-fibuki-custom": customHeader } : {}),
      },
      body: data as BodyInit,
    });
    if (!res.ok) {
      task._fail(await toStorageError(res));
      return;
    }
    await res.json();
    task._progress(total);
    task._success();
  } catch (err) {
    task._fail(err instanceof StorageError ? err : new StorageError("storage/unknown", String((err as Error)?.message ?? err)));
  }
}

export function uploadBytesResumable(ref: StorageReference, data: UploadData, metadata?: UploadMetadata): UploadTask {
  const total = byteLength(data);
  const task = new UploadTaskImpl(ref, total);
  void runResumableUpload(task, ref, data, metadata, total);
  return task;
}

/* ------------------------------------------------------------------ */
/* getDownloadURL / getBytes / deleteObject                            */
/* ------------------------------------------------------------------ */

/**
 * Returns `<apiUrl>/__storage/download/<path>?token=<bearer>` — the token is
 * embedded in the query string (not just an Authorization header) so the URL
 * is directly usable as an <img>/<iframe> `src` attribute. Single-user
 * divergence from real Firebase Storage download tokens (module banner).
 */
export async function getDownloadURL(ref: StorageReference): Promise<string> {
  const t = transport();
  const token = await t.getToken();
  const url = `${t.apiUrl}${downloadPath(ref)}`;
  return token ? `${url}?token=${encodeURIComponent(token)}` : url;
}

export async function getBytes(ref: StorageReference): Promise<ArrayBuffer> {
  const t = transport();
  const token = await t.getToken();
  const res = await fetch(`${t.apiUrl}${downloadPath(ref)}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw await toStorageError(res);
  return res.arrayBuffer();
}

export async function deleteObject(ref: StorageReference): Promise<void> {
  const t = transport();
  const token = await t.getToken();
  const path = encodePathSegments(ref.fullPath);
  const res = await fetch(`${t.apiUrl}/__storage/object/${path}`, {
    method: "DELETE",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw await toStorageError(res);
  await res.json();
}
