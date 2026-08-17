/**
 * Self-host client Auth shim (work item 6, slice D).
 *
 * Drop-in replacement for the subset of `firebase/auth` the app uses, swapped
 * at module-resolution time via next.config.ts (env-gated,
 * FIBUKI_BACKEND=selfhost). Zero app-code changes — same trick as the
 * firestore / storage / functions client shims.
 *
 * Identity comes from one of two backends, mirroring the host's
 * `server.ts#resolveVerifier` precedence (W1 chunk 4):
 *
 *   - NEXT_PUBLIC_OIDC_ISSUER set → **external OIDC** (Authentik/Keycloak/
 *     Entra) via Authorization-Code + PKCE (public SPA client, no secret).
 *     Design: frontend-shim-design.md §4. Unchanged behavior.
 *   - otherwise → **Better Auth built-in** (the default): real credential
 *     sign-in against the host's `/__auth` endpoints.
 *     `signInWithEmailAndPassword` POSTs the credentials, exchanges the
 *     session for a JWKS-verifiable JWT at `/__auth/token`, and stores both;
 *     `signInWithPopup(GoogleAuthProvider)` starts the Google social flow
 *     (BYO OAuth client on the host — GOOGLE_CLIENT_ID/SECRET). The API
 *     base comes from NEXT_PUBLIC_FIBUKI_API_URL or `__configureAuthClient`
 *     (same pattern as the sibling firestore/storage client shims).
 *
 * Shared semantics (both modes):
 *   - `onAuthStateChanged(auth, cb)` is the SOLE state source (mirrors
 *     components/auth/auth-provider.tsx). It fires once with the restored
 *     user on subscribe, then on every login / logout / token change.
 *   - `getIdToken()` returns a locally-decodable JWT the host verifies via
 *     JWKS (same token for callables and `/api/*`). It refreshes (session
 *     token in Better Auth mode, refresh_token in OIDC mode) when near
 *     expiry or when `forceRefresh` is passed.
 *   - `getIdTokenResult().claims.admin` is derived from the token: a direct
 *     `admin` claim, or membership of the group named by
 *     NEXT_PUBLIC_OIDC_ADMIN_GROUP (default "fibuki-admin").
 *   - Dev short-circuit: NEXT_PUBLIC_FIBUKI_DEV_UID mints a synthetic signed-in
 *     user with no network at all (pairs with the host's FIBUKI_DEV_UID, which
 *     accepts any bearer token as that uid).
 *
 * MFA / passkey / credential-link / impersonation exports are loud-throw stubs:
 * those pages (sign-in-security, impersonate, registration, device) are
 * excluded from the self-host build, but the modules still compile, so every
 * imported symbol must exist.
 *
 * On load this module wires its token getter into the other three client shims
 * (firestore / storage / functions) via their `__setXClientToken` hooks, so a
 * single Authentik session authenticates every data-plane call.
 */

import { __setFirestoreClientToken } from "./firestore-client";
import { __setStorageClientToken } from "./storage-client";
import { __setFunctionsClientToken } from "./functions-client";
import { startChangeStream, type ChangeStreamClient } from "./change-stream-client";

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

// IMPORTANT: read each NEXT_PUBLIC_* var with a LITERAL `process.env.X` access.
// Next.js only inlines client-side env vars via a textual match of that exact
// member expression; a computed `process.env[name]` is never replaced and would
// evaluate to undefined in the browser bundle (there is no populated
// `process.env` shipped to the client). The sibling shims read the same way.
function or(v: string | undefined, fallback = ""): string {
  return v || fallback;
}

const DEV_UID = or(process.env.NEXT_PUBLIC_FIBUKI_DEV_UID);
const DEV_ADMIN = process.env.NEXT_PUBLIC_FIBUKI_DEV_ADMIN === "true";
const DEV_EMAIL = or(process.env.NEXT_PUBLIC_FIBUKI_DEV_EMAIL, `${DEV_UID}@dev.local`);

const OIDC_ISSUER = or(process.env.NEXT_PUBLIC_OIDC_ISSUER).replace(/\/$/, "");
const OIDC_CLIENT_ID = or(process.env.NEXT_PUBLIC_OIDC_CLIENT_ID);
const OIDC_SCOPE = or(process.env.NEXT_PUBLIC_OIDC_SCOPE, "openid profile email offline_access");
const OIDC_ADMIN_GROUP = or(process.env.NEXT_PUBLIC_OIDC_ADMIN_GROUP, "fibuki-admin");
/** Seconds before `exp` at which a token is treated as stale and refreshed. */
const TOKEN_SKEW_S = 30;
/**
 * Extra staleness, drawn once per module instance — so once per tab.
 *
 * With one fixed threshold every open tab crosses the staleness line in the
 * same instant and they all refresh at once. The cross-tab lock in the token
 * refresh section is what makes a collision safe; this jitter is what keeps it
 * rare. Bounded below TOKEN_SKEW_S, so the worst case is refreshing just under
 * 60s early, well inside any usable id_token lifetime (fork #73).
 */
const TOKEN_SKEW_JITTER_S = Math.floor(Math.random() * TOKEN_SKEW_S);
const TOKEN_SKEW_MS = (TOKEN_SKEW_S + TOKEN_SKEW_JITTER_S) * 1000;

const TOKENS_KEY = "fibuki.oidc.tokens";
const PKCE_KEY = "fibuki.oidc.pkce";
/** Fallback cross-tab refresh lease, used only where Web Locks is unavailable. */
const REFRESH_LEASE_KEY = "fibuki.oidc.refresh-lease";

const OIDC_REDIRECT_URI = or(process.env.NEXT_PUBLIC_OIDC_REDIRECT_URI);

/* ------------------------------------------------------------------ */
/* Better Auth transport (default mode: no external OIDC issuer)       */
/* ------------------------------------------------------------------ */

interface AuthClientTransport {
  apiUrl: string;
}

let _transport: AuthClientTransport | null = null;

/**
 * Point the client at a fibuki-api host — same pattern as
 * __configureFirestoreClient / __configureStorageClient. Tests boot the
 * Better Auth handler over a socket and configure the client here; browsers
 * normally rely on the NEXT_PUBLIC_FIBUKI_API_URL fallback instead.
 */
export function __configureAuthClient(t: AuthClientTransport): void {
  _transport = { apiUrl: t.apiUrl.replace(/\/$/, "") };
}

/** Base URL of the host's Better Auth mount, e.g. "https://api.x/__auth". */
function authApiBase(): string {
  if (_transport) return `${_transport.apiUrl}/__auth`;
  const apiUrl =
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_FIBUKI_API_URL) || "";
  if (apiUrl) return `${apiUrl.replace(/\/$/, "")}/__auth`;
  throw new AuthError(
    "auth/invalid-api-key",
    "Auth client not configured: set NEXT_PUBLIC_FIBUKI_API_URL or call __configureAuthClient().",
  );
}

function redirectUri(): string {
  if (OIDC_REDIRECT_URI) return OIDC_REDIRECT_URI;
  if (typeof window !== "undefined") return `${window.location.origin}/`;
  return "/";
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Mirrors the FirebaseError shape the app checks (`err.code`, `err.name`). */
export class AuthError extends Error {
  readonly name = "FirebaseError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function stub(symbol: string): never {
  throw new AuthError(
    "auth/operation-not-supported-in-this-environment",
    `${symbol} is not available in the self-host build (Authentik handles ` +
      `MFA / passkeys / account linking / impersonation). This page should be ` +
      `excluded from the self-host build.`,
  );
}

/* ------------------------------------------------------------------ */
/* JWT helpers (read-only — the HOST verifies the signature)           */
/* ------------------------------------------------------------------ */

interface IdTokenClaims {
  sub?: string;
  email?: string;
  name?: string;
  picture?: string;
  email_verified?: boolean;
  admin?: boolean;
  groups?: string[];
  exp?: number;
  iat?: number;
  auth_time?: number;
  [k: string]: unknown;
}

function decodeJwt(token: string): IdTokenClaims {
  const seg = token.split(".")[1];
  if (!seg) throw new AuthError("auth/invalid-credential", "Malformed id_token (no payload).");
  // base64url → base64, then decode. atob is available in browsers and Node ≥16.
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/").padEnd(seg.length + ((4 - (seg.length % 4)) % 4), "=");
  const json = typeof atob !== "undefined" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  // Handle UTF-8 (umlauts in name/email) rather than raw binary.
  const bytes = Uint8Array.from(json, (c: string) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as IdTokenClaims;
}

function isAdminClaims(claims: IdTokenClaims): boolean {
  if (claims.admin === true) return true;
  return Array.isArray(claims.groups) && claims.groups.includes(OIDC_ADMIN_GROUP);
}

/* ------------------------------------------------------------------ */
/* Token store (localStorage)                                          */
/* ------------------------------------------------------------------ */

interface StoredTokens {
  id_token: string;
  access_token?: string;
  refresh_token?: string;
  /** Better Auth session token (built-in mode) — re-mints the JWT at
   *  /__auth/token when it goes stale, and revokes the session on signOut. */
  session_token?: string;
  /** ms epoch at which id_token expires (from its `exp`). */
  expires_at: number;
  /**
   * True once the provider has been observed replacing `refresh_token` on a
   * refresh — i.e. it rotates. Rotated tokens are single-use, so from then on
   * a response that omits a replacement is an error rather than a licence to
   * re-present the consumed one (fork #73).
   */
  rotates?: boolean;
}

function loadTokens(): StoredTokens | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(TOKENS_KEY);
    return raw ? (JSON.parse(raw) as StoredTokens) : null;
  } catch {
    return null;
  }
}

function saveTokens(t: StoredTokens): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TOKENS_KEY, JSON.stringify(t));
  } catch {
    /* private-mode / quota — non-fatal, session just won't persist */
  }
}

function clearTokens(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(TOKENS_KEY);
  } catch {
    /* ignore */
  }
}

/** Single answer to "does this set need refreshing?" — jittered per tab. */
function isStale(t: StoredTokens): boolean {
  return Date.now() >= t.expires_at - TOKEN_SKEW_MS;
}

function tokensToExpiry(idToken: string, expiresInS?: number): number {
  const claims = decodeJwt(idToken);
  if (typeof claims.exp === "number") return claims.exp * 1000;
  if (typeof expiresInS === "number") return Date.now() + expiresInS * 1000;
  return Date.now() + 3600_000;
}

/* ------------------------------------------------------------------ */
/* OIDC discovery                                                      */
/* ------------------------------------------------------------------ */

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
}

let _discovery: Discovery | null = null;
let _discoveryInFlight: Promise<Discovery> | null = null;

async function discover(): Promise<Discovery> {
  if (_discovery) return _discovery;
  if (_discoveryInFlight) return _discoveryInFlight;
  if (!OIDC_ISSUER) {
    throw new AuthError(
      "auth/invalid-api-key",
      "NEXT_PUBLIC_OIDC_ISSUER is not set — cannot start the Authentik login flow.",
    );
  }
  _discoveryInFlight = (async () => {
    const res = await fetch(`${OIDC_ISSUER}/.well-known/openid-configuration`);
    if (!res.ok) {
      throw new AuthError("auth/network-request-failed", `OIDC discovery failed (${res.status}).`);
    }
    const d = (await res.json()) as Discovery;
    _discovery = d;
    return d;
  })();
  try {
    return await _discoveryInFlight;
  } finally {
    _discoveryInFlight = null;
  }
}

/* ------------------------------------------------------------------ */
/* PKCE                                                                */
/* ------------------------------------------------------------------ */

function randomString(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return base64url(arr);
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

interface PkceState {
  verifier: string;
  state: string;
  returnTo: string;
}

/* ------------------------------------------------------------------ */
/* User                                                                */
/* ------------------------------------------------------------------ */

/** Firebase `UserInfo` shape — one entry per linked auth provider. */
export interface UserInfo {
  readonly providerId: string;
  readonly uid: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly phoneNumber: string | null;
  readonly photoURL: string | null;
}

export interface User {
  readonly uid: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly displayName: string | null;
  readonly photoURL: string | null;
  readonly phoneNumber: string | null;
  readonly isAnonymous: boolean;
  readonly providerId: string;
  /** Firebase exposes one UserInfo per linked provider; self-host has exactly
   *  one (the OIDC IdP). Present so app code doing `user.providerData.filter()`
   *  doesn't crash. */
  readonly providerData: UserInfo[];
  readonly metadata: { creationTime?: string; lastSignInTime?: string };
  getIdToken(forceRefresh?: boolean): Promise<string>;
  getIdTokenResult(forceRefresh?: boolean): Promise<IdTokenResult>;
  reload(): Promise<void>;
  delete(): Promise<void>;
}

export interface IdTokenResult {
  token: string;
  claims: Record<string, unknown>;
  expirationTime: string;
  issuedAtTime: string;
  authTime: string;
  signInProvider: string | null;
}

/** The concrete user backed by the OIDC id_token in localStorage. */
class OidcUser implements User {
  constructor(private claims: IdTokenClaims) {}

  /** Refresh the claim snapshot in place — keeps the User identity stable
   *  across silent token refreshes (Firebase mutates rather than replaces). */
  _setClaims(claims: IdTokenClaims): void {
    this.claims = claims;
  }

  get uid(): string {
    return this.claims.sub ?? "";
  }
  get email(): string | null {
    return this.claims.email ?? null;
  }
  get emailVerified(): boolean {
    return this.claims.email_verified === true;
  }
  get displayName(): string | null {
    return this.claims.name ?? null;
  }
  get photoURL(): string | null {
    return this.claims.picture ?? null;
  }
  get phoneNumber(): string | null {
    return null;
  }
  readonly isAnonymous = false;
  readonly providerId = "oidc.authentik";
  get providerData(): UserInfo[] {
    return [
      {
        providerId: this.providerId,
        uid: this.uid,
        displayName: this.displayName,
        email: this.email,
        phoneNumber: null,
        photoURL: this.photoURL,
      },
    ];
  }
  get metadata(): { creationTime?: string; lastSignInTime?: string } {
    const t = typeof this.claims.auth_time === "number" ? new Date(this.claims.auth_time * 1000).toUTCString() : undefined;
    return { creationTime: t, lastSignInTime: t };
  }

  async getIdToken(forceRefresh = false): Promise<string> {
    const token = await freshIdToken(forceRefresh);
    // Keep our claim snapshot current so getIdTokenResult reflects a refresh.
    this.claims = decodeJwt(token);
    return token;
  }

  async getIdTokenResult(forceRefresh = false): Promise<IdTokenResult> {
    const token = await this.getIdToken(forceRefresh);
    const claims = this.claims;
    return {
      token,
      claims: { ...claims, admin: isAdminClaims(claims) },
      expirationTime: claims.exp ? new Date(claims.exp * 1000).toUTCString() : "",
      issuedAtTime: claims.iat ? new Date(claims.iat * 1000).toUTCString() : "",
      authTime: claims.auth_time ? new Date(claims.auth_time * 1000).toUTCString() : "",
      signInProvider: this.providerId,
    };
  }

  async reload(): Promise<void> {
    /* no-op: no mutable profile in the self-host build */
  }

  delete(): Promise<void> {
    return stub("User.delete");
  }
}

/** The synthetic dev user (NEXT_PUBLIC_FIBUKI_DEV_UID short-circuit). */
class DevUser implements User {
  readonly uid = DEV_UID;
  readonly email = DEV_EMAIL;
  readonly emailVerified = true;
  readonly displayName = "Dev User";
  readonly photoURL = null;
  readonly phoneNumber = null;
  readonly isAnonymous = false;
  readonly providerId = "dev";
  readonly providerData: UserInfo[] = [
    { providerId: "dev", uid: DEV_UID, displayName: "Dev User", email: DEV_EMAIL, phoneNumber: null, photoURL: null },
  ];
  readonly metadata = { creationTime: undefined, lastSignInTime: undefined };

  async getIdToken(): Promise<string> {
    // Any bearer token is accepted by the host in dev mode (FIBUKI_DEV_UID);
    // send the uid so logs are legible.
    return DEV_UID;
  }
  async getIdTokenResult(): Promise<IdTokenResult> {
    return {
      token: DEV_UID,
      claims: { sub: DEV_UID, email: DEV_EMAIL, admin: DEV_ADMIN },
      expirationTime: "",
      issuedAtTime: "",
      authTime: "",
      signInProvider: "dev",
    };
  }
  async reload(): Promise<void> {}
  delete(): Promise<void> {
    return stub("User.delete");
  }
}

/* ------------------------------------------------------------------ */
/* Auth singleton + listeners                                          */
/* ------------------------------------------------------------------ */

type AuthStateListener = (user: User | null) => void;

export interface Auth {
  currentUser: User | null;
  readonly __fibukiAuth: true;
}

const _auth: Auth & { currentUser: User | null } = {
  currentUser: null,
  __fibukiAuth: true,
};

const _listeners = new Set<AuthStateListener>();

function notify(): void {
  // Follow the session with the realtime stream. This is the one place every auth
  // transition passes through — sign-in, sign-out, token refresh and restore-on-load
  // — so hooking here avoids a stream that outlives its token or never starts after
  // a page reload. Both calls are idempotent.
  if (_auth.currentUser) ensureChangeStream();
  else stopChangeStream();

  for (const cb of _listeners) {
    try {
      cb(_auth.currentUser);
    } catch (e) {
      console.error("[selfhost-auth] onAuthStateChanged listener threw:", e);
    }
  }
}

function setUserFromTokens(tokens: StoredTokens | null): void {
  if (!tokens) {
    _auth.currentUser = null;
    return;
  }
  try {
    const claims = decodeJwt(tokens.id_token);
    const cur = _auth.currentUser;
    // Same user, just a refreshed token → mutate in place so the User instance
    // (and thus React referential equality) stays stable across refreshes.
    if (cur instanceof OidcUser && cur.uid === (claims.sub ?? "")) {
      cur._setClaims(claims);
    } else {
      _auth.currentUser = new OidcUser(claims);
    }
  } catch {
    _auth.currentUser = null;
  }
}

/* ------------------------------------------------------------------ */
/* Cross-tab refresh lock                                              */
/*                                                                     */
/* TOKENS_KEY lives in localStorage, so it is shared by every tab on   */
/* the origin, and a rotating refresh_token is single-use. Two tabs    */
/* refreshing at once therefore replay one token, the provider revokes */
/* it, and the loser used to sign everyone out (fork #73). Mutual      */
/* exclusion has to be origin-wide, which is exactly Web Locks.        */
/* ------------------------------------------------------------------ */

const REFRESH_LOCK_NAME = "fibuki-oidc-refresh";

/** The one method of navigator.locks we use. */
interface LockManagerLike {
  request<T>(name: string, cb: () => Promise<T>): Promise<T>;
}

/**
 * Web Locks is optional at runtime — absent in a non-secure context, on older
 * browsers, and under SSR — while the DOM lib types `navigator` as always
 * present. Reach it through globalThis so the feature test is real rather than
 * a types-only reassurance.
 */
function lockManager(): LockManagerLike | null {
  const nav = (globalThis as { navigator?: { locks?: unknown } }).navigator;
  const locks = nav?.locks as LockManagerLike | undefined;
  return typeof locks?.request === "function" ? locks : null;
}

/* Lease fallback tuning. Where Web Locks is unavailable a localStorage lease
 * stands in: claim it, pause, re-read to confirm nobody overwrote the claim in
 * the same instant.
 *
 * The lease is best-effort by construction — localStorage has no compare-and-set,
 * so a sufficiently unlucky interleaving can still let two tabs through. That is
 * why it is not the only defence: the re-read inside the critical section skips
 * the network call entirely once a peer has stored a token, and the failure path
 * in refreshTokens adopts a peer's set instead of signing out. */
const LEASE_TTL_MS = 10_000; // a crashed holder's lease becomes stealable
const LEASE_CONFIRM_MS = 40; // write-then-re-read settle window
const LEASE_POLL_MS = 120;
const LEASE_MAX_WAIT_MS = 5_000;

interface RefreshLease {
  owner: string;
  at: number;
}

/** Identifies this tab's lease claims. One per module instance. */
const LEASE_OWNER = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function readLease(): RefreshLease | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(REFRESH_LEASE_KEY);
    return raw ? (JSON.parse(raw) as RefreshLease) : null;
  } catch {
    return null;
  }
}

function writeLease(lease: RefreshLease | null): void {
  if (typeof window === "undefined") return;
  try {
    if (lease) window.localStorage.setItem(REFRESH_LEASE_KEY, JSON.stringify(lease));
    else window.localStorage.removeItem(REFRESH_LEASE_KEY);
  } catch {
    /* private-mode / quota — non-fatal, we just lose the cross-tab guard */
  }
}

/** One claim attempt: free (or abandoned) lease → claim, settle, confirm ours. */
async function claimLease(): Promise<boolean> {
  const held = readLease();
  if (held && Date.now() - held.at < LEASE_TTL_MS) return false;
  const mine: RefreshLease = { owner: LEASE_OWNER, at: Date.now() };
  writeLease(mine);
  await delay(LEASE_CONFIRM_MS);
  const after = readLease();
  return after?.owner === mine.owner && after.at === mine.at;
}

async function withLeaseLock<T>(fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LEASE_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    if (await claimLease()) {
      try {
        return await fn();
      } finally {
        if (readLease()?.owner === LEASE_OWNER) writeLease(null);
      }
    }
    await delay(LEASE_POLL_MS);
  }
  // Never acquired. Run unlocked rather than failing the caller: `fn` re-reads
  // storage first, so if the holder did land a token we return it with no
  // network call. Worst case is the pre-fix behavior, never worse.
  return fn();
}

/** Serialise `fn` across every tab on this origin. */
function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = lockManager();
  return locks ? locks.request(REFRESH_LOCK_NAME, fn) : withLeaseLock(fn);
}

/* ------------------------------------------------------------------ */
/* Token refresh                                                       */
/* ------------------------------------------------------------------ */

let _refreshInFlight: Promise<string> | null = null;

/** Returns a non-stale id_token, refreshing via the refresh_token if needed. */
async function freshIdToken(force: boolean): Promise<string> {
  if (DEV_UID) return DEV_UID;

  const tokens = loadTokens();
  if (!tokens) throw new AuthError("auth/user-token-expired", "Not signed in.");

  if (!force && !isStale(tokens)) return tokens.id_token;

  // Dedupe within this tab; refreshUnderLock dedupes across tabs.
  if (_refreshInFlight) return _refreshInFlight;
  _refreshInFlight = refreshUnderLock(force, tokens.id_token).finally(() => {
    _refreshInFlight = null;
  });
  return _refreshInFlight;
}

/**
 * Refresh inside the origin-wide lock, re-reading localStorage once we hold it.
 *
 * The re-read is the actual fix: a tab that queued behind a peer finds the
 * peer's fresh token already stored and makes no network call at all, so the
 * consumed refresh_token is never replayed.
 */
async function refreshUnderLock(force: boolean, startedWith: string): Promise<string> {
  return withRefreshLock(async () => {
    const current = loadTokens();
    if (!current) throw new AuthError("auth/user-token-expired", "Not signed in.");

    // A different id_token means a peer refreshed while we waited. That token
    // is newer than the one the caller was holding, so it satisfies a forced
    // refresh too; without it, only staleness can skip the network call.
    const peerRefreshed = current.id_token !== startedWith;
    if (!isStale(current) && (peerRefreshed || !force)) {
      setUserFromTokens(current);
      notify();
      return current.id_token;
    }
    return refreshTokens(current);
  });
}

/** Built-in mode refresh: re-mint the JWT from the Better Auth session. */
async function refreshViaSession(tokens: StoredTokens): Promise<string> {
  let base: string;
  try {
    base = authApiBase();
  } catch {
    // Unconfigured (test-injected session) — hand back the existing token;
    // the host will 401 once it truly expires.
    return tokens.id_token;
  }
  const res = await fetch(`${base}/token`, {
    headers: { authorization: `Bearer ${tokens.session_token}` },
  });
  if (!res.ok) {
    // Session revoked or expired — sign out cleanly so the UI shows the
    // login screen rather than looping on a dead token.
    clearTokens();
    _auth.currentUser = null;
    notify();
    throw new AuthError("auth/user-token-expired", `Session refresh failed (${res.status}).`);
  }
  const body = (await res.json()) as { token?: string };
  if (!body.token) {
    throw new AuthError("auth/internal-error", "Token refresh response had no token.");
  }
  const next: StoredTokens = {
    ...tokens,
    id_token: body.token,
    expires_at: tokensToExpiry(body.token),
  };
  saveTokens(next);
  setUserFromTokens(next);
  notify();
  return next.id_token;
}

/**
 * OIDC refresh-token grant. Runs inside the cross-tab lock (refreshUnderLock).
 *
 * `attempt` bounds the recovery in the failure path below to a single retry, so
 * a genuinely revoked session still reaches the sign-out branch.
 */
async function refreshTokens(tokens: StoredTokens, attempt = 0): Promise<string> {
  if (tokens.session_token) return refreshViaSession(tokens);
  if (!tokens.refresh_token) {
    // No refresh token (offline_access not granted) — fall back to the
    // existing id_token; the host will 401 once it truly expires and the app's
    // onAuthStateChanged path handles re-login.
    return tokens.id_token;
  }
  const { token_endpoint } = await discover();
  const res = await fetch(token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: OIDC_CLIENT_ID,
      refresh_token: tokens.refresh_token,
    }),
  });
  if (!res.ok) {
    // A lost rotation race and a revoked session look identical from here, and
    // signing out on the former destroys a live one — the token set another tab
    // just wrote. Re-read before deciding (fork #73).
    const current = loadTokens();
    const superseded = !!current && current.refresh_token !== tokens.refresh_token;
    if (current && superseded && !isStale(current)) {
      // A peer won the race and stored a usable set: adopt it, no sign-out.
      setUserFromTokens(current);
      notify();
      return current.id_token;
    }
    if (current && superseded && attempt === 0) {
      // Superseded but itself stale — retry once with the replacement token.
      return refreshTokens(current, attempt + 1);
    }
    // Nothing usable left: sign out cleanly so the UI shows the login screen
    // rather than looping on a dead token.
    clearTokens();
    _auth.currentUser = null;
    notify();
    throw new AuthError("auth/user-token-expired", `Token refresh failed (${res.status}).`);
  }
  const body = (await res.json()) as {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!body.id_token) {
    throw new AuthError("auth/internal-error", "Token refresh response had no id_token.");
  }
  // RFC 6749 §6 makes refresh_token optional in the response, and a provider
  // that never rotates expects the old one to be reused. A provider that DOES
  // rotate has consumed it, so reusing it guarantees the next refresh replays a
  // revoked token. Track which kind we are talking to instead of assuming.
  const rotated = !!body.refresh_token && body.refresh_token !== tokens.refresh_token;
  const rotates = tokens.rotates === true || rotated;
  if (!body.refresh_token && rotates) {
    // Leave the stored set alone: the host will 401 and the app re-authenticates,
    // which beats replaying a consumed token and tripping suspicious_request.
    throw new AuthError(
      "auth/internal-error",
      "Token refresh response omitted a replacement refresh_token on a rotating provider.",
    );
  }
  const next: StoredTokens = {
    id_token: body.id_token,
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? tokens.refresh_token,
    expires_at: tokensToExpiry(body.id_token, body.expires_in),
    ...(rotates ? { rotates: true } : {}),
  };
  saveTokens(next);
  setUserFromTokens(next);
  notify();
  return next.id_token;
}

/* ------------------------------------------------------------------ */
/* Login / callback / logout                                          */
/* ------------------------------------------------------------------ */

async function startLogin(): Promise<never> {
  // Dev short-circuit already has a user — nothing to do, but callers await
  // this, so resolve by navigating nowhere.
  if (DEV_UID) {
    return new Promise<never>(() => {});
  }
  if (typeof window === "undefined") {
    throw new AuthError("auth/operation-not-supported-in-this-environment", "Login requires a browser.");
  }
  const { authorization_endpoint } = await discover();
  const verifier = randomString(32);
  const state = randomString(16);
  const challenge = await pkceChallenge(verifier);

  const pkce: PkceState = {
    verifier,
    state,
    returnTo: window.location.pathname + window.location.search,
  };
  window.sessionStorage.setItem(PKCE_KEY, JSON.stringify(pkce));

  const url = new URL(authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", OIDC_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("scope", OIDC_SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  window.location.assign(url.toString());
  // Navigation is underway; never resolves.
  return new Promise<never>(() => {});
}

/**
 * Detect and complete an OIDC redirect on the current URL. Runs once at module
 * init on any page — the redirect_uri points at the app root, so there is no
 * dedicated callback route to add (keeps the app unmodified). Returns true if a
 * callback was handled.
 */
async function maybeCompleteCallback(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return false;

  let pkce: PkceState | null = null;
  try {
    const raw = window.sessionStorage.getItem(PKCE_KEY);
    pkce = raw ? (JSON.parse(raw) as PkceState) : null;
  } catch {
    pkce = null;
  }
  // Not our callback (no stored PKCE) or a state mismatch (CSRF guard) — leave
  // the URL alone and let the app render normally.
  if (!pkce || pkce.state !== state) return false;
  window.sessionStorage.removeItem(PKCE_KEY);

  try {
    const { token_endpoint } = await discover();
    const res = await fetch(token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: OIDC_CLIENT_ID,
        code,
        redirect_uri: redirectUri(),
        code_verifier: pkce.verifier,
      }),
    });
    if (!res.ok) throw new AuthError("auth/invalid-credential", `Code exchange failed (${res.status}).`);
    const body = (await res.json()) as {
      id_token?: string;
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!body.id_token) throw new AuthError("auth/internal-error", "Code exchange returned no id_token.");
    const tokens: StoredTokens = {
      id_token: body.id_token,
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: tokensToExpiry(body.id_token, body.expires_in),
    };
    saveTokens(tokens);
    setUserFromTokens(tokens);
  } finally {
    // Strip the OIDC params from the URL either way so a reload can't replay
    // the (now spent) code, and restore where the user started.
    const clean = pkce.returnTo && pkce.returnTo !== "" ? pkce.returnTo : window.location.pathname;
    window.history.replaceState({}, "", clean);
  }
  notify();
  return true;
}

/** Query param marking a return from the Better Auth Google social flow. */
const SOCIAL_MARKER = "fibuki_social";

/**
 * Query param marking a return down the ERROR path of that flow — set as our
 * `errorCallbackURL` so a rejected sign-in (chiefly the invite gate blocking a
 * non-invited stranger) bounces back to the app with a marker the login /
 * register page turns into an "access request submitted" banner, instead of a
 * silent dead end. See lib/auth/social-access-request.ts.
 */
const SOCIAL_ERROR_MARKER = "fibuki_social_error";

/**
 * Complete a Google social sign-in (built-in mode). The Better Auth callback
 * on the API host set a session COOKIE there and redirected back to us with
 * the marker param; pick the session up and swap it for the bearer-token
 * world the rest of the client lives in. Cookie pickup only works when app
 * and API share an origin (the standard one-reverse-proxy deployment) — the
 * host deliberately never allows credentialed CORS, so a split-origin
 * Google flow needs an external OIDC front instead.
 */
async function maybeCompleteSocialCallback(): Promise<void> {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  if (!params.get(SOCIAL_MARKER)) return;
  try {
    const base = authApiBase();
    const res = await fetch(`${base}/get-session`, { credentials: "include" });
    if (!res.ok) return;
    // The session body carries the raw session token (get-session responses
    // never emit the bearer plugin's set-auth-token header — that only rides
    // along when a set-cookie is issued, e.g. on sign-in).
    const body = (await res.json()) as { session?: { token?: string } } | null;
    const sessionToken = body?.session?.token;
    if (!sessionToken) return;
    adoptSession(sessionToken, await mintJwt(base, sessionToken));
  } catch {
    /* not signed in — the login screen renders normally */
  } finally {
    // Strip the marker only AFTER the pickup attempt settles — matching the
    // OIDC path (maybeCompleteCallback), which clears its params in a finally
    // too. Stripping it up front opened a gap: a reload while the async
    // get-session / JWT mint was still in flight would find no marker, skip
    // the pickup entirely, and strand a live server session on the login
    // screen (forcing a needless re-login). The pickup is an idempotent GET,
    // so surviving one extra attempt on a mid-flight reload is harmless; a
    // spent marker must still be cleared so a later manual reload doesn't
    // repeat it.
    params.delete(SOCIAL_MARKER);
    const clean = window.location.pathname + (params.toString() ? `?${params.toString()}` : "");
    window.history.replaceState({}, "", clean);
  }
}

async function doSignOut(): Promise<void> {
  const tokens = loadTokens();
  clearTokens();
  _auth.currentUser = null;
  notify();
  // Built-in mode: best-effort server-side sign-out so the SESSION is
  // revoked (which revokes every JWT minted from it — the verifier's sid
  // check), not merely forgotten locally. Fire and forget.
  if (!DEV_UID && !OIDC_ISSUER) {
    if (tokens?.session_token) {
      try {
        const base = authApiBase();
        void fetch(`${base}/sign-out`, {
          method: "POST",
          headers: { authorization: `Bearer ${tokens.session_token}` },
        }).catch(() => undefined);
      } catch {
        /* unconfigured — local sign-out already done */
      }
    }
    return;
  }
  // OIDC mode: best-effort RP-initiated logout so the IdP session ends too.
  if (!DEV_UID && typeof window !== "undefined") {
    try {
      const { end_session_endpoint } = await discover();
      if (end_session_endpoint) {
        const url = new URL(end_session_endpoint);
        url.searchParams.set("client_id", OIDC_CLIENT_ID);
        url.searchParams.set("post_logout_redirect_uri", redirectUri());
        window.location.assign(url.toString());
      }
    } catch {
      /* discovery/logout endpoint unavailable — local sign-out already done */
    }
  }
}

/* ------------------------------------------------------------------ */
/* Module init: restore session, wire token getter, handle callback    */
/* ------------------------------------------------------------------ */

const getToken = async (): Promise<string | null> => {
  try {
    return _auth.currentUser ? await _auth.currentUser.getIdToken() : null;
  } catch {
    return null;
  }
};

// Wire the same Authentik token into every data-plane client shim.
__setFirestoreClientToken(getToken);
__setStorageClientToken(getToken);
__setFunctionsClientToken(getToken);

/**
 * Realtime change stream, started once a user is signed in and stopped on sign-out.
 *
 * Lives here because this module already owns the token lifecycle, and the stream
 * needs a bearer token that stays valid. Browser-only: there is no stream to hold
 * during SSR, and opening one per render would leak connections.
 *
 * Purely additive — if it never connects, onSnapshot keeps polling exactly as
 * before. See change-stream-client.ts.
 */
let _changeStream: ChangeStreamClient | null = null;

function stopChangeStream(): void {
  _changeStream?.stop();
  _changeStream = null;
}

function ensureChangeStream(): void {
  if (typeof window === "undefined") return; // no streams during SSR
  if (_changeStream || DEV_UID) return;
  const apiUrl =
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_FIBUKI_API_URL) || "";
  if (!apiUrl) return; // same-origin/unconfigured deployments simply keep polling
  _changeStream = startChangeStream({
    apiUrl: apiUrl.replace(/\/$/, ""),
    getToken,
  });
}

let _initialized = false;

function initSession(): void {
  if (_initialized) return;
  _initialized = true;

  if (DEV_UID) {
    _auth.currentUser = new DevUser();
    // Defer so a synchronous subscribe in a React effect still sees the fire.
    queueMicrotask(notify);
    return;
  }
  if (typeof window === "undefined") return;

  // Restore any persisted session immediately so the first onAuthStateChanged
  // has the user, then complete a pending callback (which re-notifies) —
  // OIDC code exchange in issuer mode, Google social pickup in built-in mode.
  setUserFromTokens(loadTokens());
  if (OIDC_ISSUER) {
    void maybeCompleteCallback();
  } else {
    void maybeCompleteSocialCallback();
  }

  // Cross-tab sync: a sign-in / sign-out / refresh in another tab writes
  // TOKENS_KEY; mirror it here so this tab doesn't keep operating on a stale
  // session (Firebase Auth syncs across tabs the same way).
  window.addEventListener("storage", (e) => {
    if (e.key !== TOKENS_KEY) return;
    setUserFromTokens(loadTokens());
    notify();
  });
}

initSession();

/* ------------------------------------------------------------------ */
/* Exported `firebase/auth` surface                                    */
/* ------------------------------------------------------------------ */

/** getAuth(app?) — app handle ignored (no Firebase project in self-host). */
export function getAuth(_app?: unknown): Auth {
  return _auth;
}

export function connectAuthEmulator(_auth: unknown, _url: string, _opts?: unknown): void {
  /* no-op: self-host talks to Authentik, never the Firebase auth emulator */
}

/** browserLocalPersistence: a marker; self-host always persists to localStorage. */
export const browserLocalPersistence = { type: "LOCAL" as const };
export const browserSessionPersistence = { type: "SESSION" as const };
export const inMemoryPersistence = { type: "NONE" as const };

export function setPersistence(_auth: unknown, _persistence: unknown): Promise<void> {
  return Promise.resolve();
}

export function onAuthStateChanged(_authArg: unknown, cb: AuthStateListener): () => void {
  _listeners.add(cb);
  // Fire once with the current state, asynchronously (matches Firebase, and
  // lets a subscribe-in-effect run before the first callback).
  queueMicrotask(() => {
    if (_listeners.has(cb)) cb(_auth.currentUser);
  });
  return () => {
    _listeners.delete(cb);
  };
}

// onIdTokenChanged shares the same notify path (token changes re-notify).
export const onIdTokenChanged = onAuthStateChanged;

export interface UserCredential {
  user: User;
  providerId: string | null;
  operationType: "signIn";
}

/** Mint a JWKS-verifiable JWT from a Better Auth session token. */
async function mintJwt(base: string, sessionToken: string): Promise<string> {
  const res = await fetch(`${base}/token`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  if (!res.ok) {
    throw new AuthError("auth/internal-error", `Token mint failed (${res.status}).`);
  }
  const body = (await res.json()) as { token?: string };
  if (!body.token) {
    throw new AuthError("auth/internal-error", "Token endpoint returned no token.");
  }
  return body.token;
}

function adoptSession(sessionToken: string, idToken: string): void {
  const stored: StoredTokens = {
    id_token: idToken,
    session_token: sessionToken,
    expires_at: tokensToExpiry(idToken),
  };
  saveTokens(stored);
  setUserFromTokens(stored);
  notify();
}

/**
 * Email/password sign-in.
 *   - OIDC mode: maps to the IdP redirect (there are no local passwords when
 *     an external issuer owns identity). Credentials ignored; never resolves.
 *   - Built-in mode (default): a REAL credential sign-in against the host's
 *     Better Auth endpoints — session token, then JWT exchange.
 */
export async function signInWithEmailAndPassword(
  _authArg: unknown,
  email: string,
  password: string,
): Promise<UserCredential> {
  if (DEV_UID || OIDC_ISSUER) {
    return startLogin() as unknown as Promise<UserCredential>;
  }
  const base = authApiBase();
  let res: Response;
  try {
    res = await fetch(`${base}/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new AuthError("auth/network-request-failed", "Could not reach the auth backend.");
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new AuthError("auth/invalid-credential", "Invalid email or password.");
  }
  if (res.status === 429) {
    throw new AuthError("auth/too-many-requests", "Too many sign-in attempts — try again later.");
  }
  if (!res.ok) {
    throw new AuthError("auth/internal-error", `Sign-in failed (${res.status}).`);
  }
  const body = (await res.json()) as { token?: string };
  if (!body.token) {
    throw new AuthError("auth/internal-error", "Sign-in response had no session token.");
  }
  adoptSession(body.token, await mintJwt(base, body.token));
  return { user: _auth.currentUser!, providerId: "password", operationType: "signIn" };
}

/**
 * Popup sign-in.
 *   - OIDC mode: the IdP redirect (Authentik shows its own provider list).
 *   - Built-in mode: the Better Auth Google social flow — ask the host for
 *     the authorization URL and navigate to it (a full-page redirect, not an
 *     actual popup; the UserCredential promise never resolves because the
 *     page unloads, same observable behavior as the OIDC path). On return,
 *     module init picks the session up (see maybeCompleteSocialCallback).
 */
export async function signInWithPopup(_authArg: unknown, provider: unknown): Promise<UserCredential> {
  if (DEV_UID || OIDC_ISSUER) {
    return startLogin() as unknown as Promise<UserCredential>;
  }
  if (typeof window === "undefined") {
    throw new AuthError("auth/operation-not-supported-in-this-environment", "Login requires a browser.");
  }
  // Firebase providerId -> Better Auth provider slug. Both are BYO-OAuth: the host
  // registers a provider only when its client id and secret are present
  // (better-auth.ts socialProviders), so an unconfigured one 4xxs rather than
  // half-working.
  //
  // GitHub was previously rejected outright here, which left any GitHub-only
  // account with NO way to sign in on a self-host deployment — one such account
  // exists in the migrated data. That contradicts the standing rule that self-host
  // and cloud ship the same features.
  const PROVIDER_SLUGS: Record<string, string> = {
    "google.com": "google",
    "github.com": "github",
  };
  const providerId = (provider as { providerId?: string } | null)?.providerId;
  const providerSlug = providerId ? PROVIDER_SLUGS[providerId] : undefined;
  if (!providerSlug) {
    throw new AuthError(
      "auth/operation-not-allowed",
      `Provider "${providerId ?? "unknown"}" is not supported in the self-host build ` +
        `(supported: ${Object.keys(PROVIDER_SLUGS).join(", ")}).`,
    );
  }
  const base = authApiBase();
  const cb = new URL(window.location.href);
  cb.searchParams.set(SOCIAL_MARKER, "1");
  // Where Better Auth sends the browser if the callback fails (e.g. the
  // invite gate rejects a non-invited stranger). Better Auth appends its own
  // ?error=…; our marker rides alongside so the app can surface the outcome.
  const errCb = new URL(window.location.href);
  errCb.searchParams.set(SOCIAL_ERROR_MARKER, "access_denied");
  const res = await fetch(`${base}/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // credentials: "include" is REQUIRED, not defensive. Better Auth returns a
    // state cookie on this response and matches it on the provider callback.
    // Cross-origin (fibuki-web on one host, fibuki-api on another) the browser
    // discards that Set-Cookie without it, and the callback then fails with
    // "State mismatch: State not persisted correctly" — which surfaces as the
    // errorCallbackURL below, i.e. as a fake access-request message.
    credentials: "include",
    body: JSON.stringify({
      provider: providerSlug,
      callbackURL: cb.toString(),
      errorCallbackURL: errCb.toString(),
    }),
  });
  if (!res.ok) {
    throw new AuthError(
      "auth/operation-not-allowed",
      `${providerSlug} sign-in unavailable (${res.status}) — is the ${providerSlug.toUpperCase()}_CLIENT_ID / ${providerSlug.toUpperCase()}_CLIENT_SECRET pair set on the host?`,
    );
  }
  const body = (await res.json()) as { url?: string };
  if (!body.url) {
    throw new AuthError("auth/internal-error", "Social sign-in returned no authorization URL.");
  }
  window.location.assign(body.url);
  // Navigation is underway; never resolves.
  return new Promise<never>(() => {});
}

export function signInWithRedirect(_authArg: unknown, provider: unknown): Promise<never> {
  if (DEV_UID || OIDC_ISSUER) return startLogin();
  return signInWithPopup(_authArg, provider) as Promise<never>;
}

export function signOut(_auth?: unknown): Promise<void> {
  return doSignOut();
}

/* --- provider stubs (constructable; only the redirect path is real) --- */

class ProviderStub {
  providerId = "oidc.authentik";
  addScope(_s: string): this {
    return this;
  }
  setCustomParameters(_p: Record<string, unknown>): this {
    return this;
  }
  static credential(..._a: unknown[]): never {
    return stub("AuthProvider.credential");
  }
  static credentialFromError(_e: unknown): null {
    // Called in an OAuth error path (auth-provider.handleOAuthError). Returning
    // null is the documented "no credential recoverable" signal — safe.
    return null;
  }
  static credentialFromResult(_r: unknown): null {
    return null;
  }
}

export class GoogleAuthProvider extends ProviderStub {
  override providerId = "google.com";
}
export class GithubAuthProvider extends ProviderStub {
  override providerId = "github.com";
}
export class OAuthProvider extends ProviderStub {
  constructor(providerId?: string) {
    super();
    if (providerId) this.providerId = providerId;
  }
}

/* --- loud-throw stubs: MFA / passkey / link / custom-token (excluded pages) --- */

export function signInWithCustomToken(_auth: unknown, _token: string): Promise<UserCredential> {
  return stub("signInWithCustomToken");
}
export function linkWithCredential(_user: unknown, _cred: unknown): Promise<UserCredential> {
  return stub("linkWithCredential");
}
export function linkWithPopup(_user: unknown, _provider: unknown): Promise<UserCredential> {
  return stub("linkWithPopup");
}
export function linkWithRedirect(_user: unknown, _provider: unknown): Promise<never> {
  return stub("linkWithRedirect");
}
export function unlink(_user: unknown, _providerId: string): Promise<User> {
  return stub("unlink");
}
export function multiFactor(_user: unknown): never {
  return stub("multiFactor");
}
export function getMultiFactorResolver(_auth: unknown, _error: unknown): never {
  return stub("getMultiFactorResolver");
}

export class MultiFactorError extends AuthError {}
export class MultiFactorResolver {
  hints: unknown[] = [];
  resolveSignIn(): never {
    return stub("MultiFactorResolver.resolveSignIn");
  }
}
export interface MultiFactorInfo {
  uid: string;
  displayName?: string | null;
  factorId: string;
}
export interface TotpSecret {
  secretKey: string;
}

export const TotpMultiFactorGenerator = {
  assertionForEnrollment: (..._a: unknown[]): never => stub("TotpMultiFactorGenerator.assertionForEnrollment"),
  assertionForSignIn: (..._a: unknown[]): never => stub("TotpMultiFactorGenerator.assertionForSignIn"),
  generateSecret: (..._a: unknown[]): never => stub("TotpMultiFactorGenerator.generateSecret"),
  FACTOR_ID: "totp",
};
export const PhoneMultiFactorGenerator = {
  assertion: (..._a: unknown[]): never => stub("PhoneMultiFactorGenerator.assertion"),
  FACTOR_ID: "phone",
};

/* Test/wiring hook: point tests at a booted host without a real Authentik. */
export function __setSelfhostSession(tokens: StoredTokens | null): void {
  if (tokens) {
    saveTokens(tokens);
    setUserFromTokens(tokens);
  } else {
    clearTokens();
    _auth.currentUser = null;
  }
  notify();
}
