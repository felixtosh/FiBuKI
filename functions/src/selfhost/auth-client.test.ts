/**
 * W1 (Better Auth) — client shim surface suite for lib/selfhost/auth-client.ts.
 *
 * Closes the named Phase-0 gap (858 LOC, zero tests) by pinning the
 * `firebase/auth` surface the aliased frontend actually consumes, measured
 * across every `from "firebase/auth"` import in app/, components/, hooks/,
 * lib/ (9 files, 25 symbols — see handoffs/2026-07-21-w1-better-auth-impl.md).
 *
 * Two kinds of test:
 *  - Characterization (plain `it`): behavior the Better Auth rewrite MUST
 *    preserve. Mechanism-agnostic on purpose — no OIDC/Authentik specifics
 *    are pinned, only the module surface, session semantics, and error
 *    shapes the app observes.
 *  - Acceptance (previously `it.fails` xfail): behavior the W1 rewrite
 *    ADDED — real credential sign-in against a booted Better Auth handler.
 *    All marks were removed by chunk 4; the whole suite is plain green.
 *
 * auth-client is browser code; there is no DOM package in this tree, so a
 * minimal hand-rolled `window` (localStorage/sessionStorage/location/history/
 * storage events — the only APIs the module touches) is installed before the
 * module loads. That keeps the suite runnable under the plain Node profile.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { toNodeHandler } from "better-auth/node";
import { createSelfhostAuth } from "./better-auth";
import { getFirestore, __rawSqlForTest } from "./firestore-shim";
import { getTenantId } from "./db/tenant";

type AuthClient = typeof import("../../../lib/selfhost/auth-client");

/* ------------------------------------------------------------------ */
/* Minimal browser environment                                         */
/* ------------------------------------------------------------------ */

class FakeStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
}

interface FakeWindow {
  localStorage: FakeStorage;
  sessionStorage: FakeStorage;
  location: {
    origin: string;
    pathname: string;
    search: string;
    href: string;
    assign: (url: string) => void;
    assigned: string[];
  };
  history: { replaceState: (data: unknown, unused: string, url?: string) => void };
  addEventListener: (type: string, cb: (e: unknown) => void) => void;
  removeEventListener: (type: string, cb: (e: unknown) => void) => void;
  __listeners: Map<string, Array<(e: unknown) => void>>;
}

function installWindow(): FakeWindow {
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  const w: FakeWindow = {
    localStorage: new FakeStorage(),
    sessionStorage: new FakeStorage(),
    location: {
      origin: "https://app.selfhost.test",
      pathname: "/transactions",
      search: "",
      href: "https://app.selfhost.test/transactions",
      assigned: [],
      assign(url: string) {
        this.assigned.push(url);
      },
    },
    history: { replaceState: () => undefined },
    addEventListener(type, cb) {
      listeners.set(type, [...(listeners.get(type) ?? []), cb]);
    },
    removeEventListener(type, cb) {
      listeners.set(type, (listeners.get(type) ?? []).filter((l) => l !== cb));
    },
    __listeners: listeners,
  };
  (globalThis as Record<string, unknown>).window = w;
  return w;
}

/* ------------------------------------------------------------------ */
/* Fake session tokens                                                 */
/*                                                                     */
/* The client never verifies signatures (the HOST does); it only needs */
/* a decodable payload. The rewrite keeps this property: getIdToken()  */
/* returns a JWT-shaped token whose claims the client can read.        */
/* ------------------------------------------------------------------ */

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeJwt(claims: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  return `${header}.${payload}.fakesig`;
}

const UID = "Kx7RgQ2mNpZcW3vYtLb8HdFs4A2q"; // Firebase-shaped 28-char uid
const IN_AN_HOUR = () => Math.floor(Date.now() / 1000) + 3600;

function sessionTokens(extra: Record<string, unknown> = {}) {
  const id_token = makeJwt({
    sub: UID,
    email: "stefan@example.test",
    name: "Stefan Test",
    email_verified: true,
    exp: IN_AN_HOUR(),
    iat: Math.floor(Date.now() / 1000),
    ...extra,
  });
  return { id_token, expires_at: Date.now() + 3600_000 };
}

/** Wait for queued microtasks (onAuthStateChanged notifies via microtask). */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/* ------------------------------------------------------------------ */
/* Module loading (env is read at import time)                         */
/* ------------------------------------------------------------------ */

let fakeWindow: FakeWindow;
let client: AuthClient;

async function loadClient(env: Record<string, string | undefined> = {}): Promise<AuthClient> {
  vi.resetModules();
  fakeWindow = installWindow();
  const keys = [
    "NEXT_PUBLIC_FIBUKI_DEV_UID",
    "NEXT_PUBLIC_FIBUKI_DEV_ADMIN",
    "NEXT_PUBLIC_OIDC_ISSUER",
    "NEXT_PUBLIC_OIDC_CLIENT_ID",
  ];
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  return import("../../../lib/selfhost/auth-client");
}

describe("selfhost auth-client — firebase/auth surface (W1 spec)", () => {
  beforeAll(async () => {
    client = await loadClient();
  });

  afterEach(async () => {
    // Sign out between tests so session state can't leak.
    client.__setSelfhostSession(null);
    await tick();
  });

  /* ---------------- module surface ---------------- */

  describe("exports consumed by the aliased frontend", () => {
    it("exposes every value symbol the app imports from firebase/auth", () => {
      // Measured 2026-07-21 across the 9 importing files. Type-only imports
      // (User, MultiFactorInfo, TotpSecret) compile against this module and
      // are covered by the functions tsc job.
      const fns = [
        "getAuth",
        "connectAuthEmulator",
        "setPersistence",
        "onAuthStateChanged",
        "signOut",
        "signInWithEmailAndPassword",
        "signInWithPopup",
        "signInWithCustomToken",
        "getMultiFactorResolver",
        "multiFactor",
        "linkWithCredential",
        "linkWithPopup",
        "linkWithRedirect",
        "unlink",
      ] as const;
      for (const name of fns) expect(typeof client[name], name).toBe("function");

      const classes = ["GoogleAuthProvider", "GithubAuthProvider", "OAuthProvider", "MultiFactorError", "MultiFactorResolver"] as const;
      for (const name of classes) expect(typeof client[name], name).toBe("function");

      expect(client.browserLocalPersistence).toBeTruthy();
      expect(typeof client.PhoneMultiFactorGenerator.assertion).toBe("function");
      expect(typeof client.TotpMultiFactorGenerator.generateSecret).toBe("function");
      expect(client.TotpMultiFactorGenerator.FACTOR_ID).toBe("totp");
    });

    it("getAuth() returns a stable singleton starting signed out", () => {
      const a = client.getAuth();
      expect(client.getAuth()).toBe(a);
      expect(a.currentUser).toBeNull();
    });

    it("connectAuthEmulator and setPersistence are safe no-ops", async () => {
      expect(() => client.connectAuthEmulator(client.getAuth(), "http://x")).not.toThrow();
      await expect(client.setPersistence(client.getAuth(), client.browserLocalPersistence)).resolves.toBeUndefined();
    });
  });

  /* ---------------- error contract ---------------- */

  describe("error contract (app checks err.name / err.code)", () => {
    it("unavailable operations throw FirebaseError-shaped AuthError with an auth/ code", () => {
      try {
        client.multiFactor({});
        expect.unreachable("multiFactor should throw in the selfhost build");
      } catch (e) {
        const err = e as { name: string; code: string; message: string };
        expect(err.name).toBe("FirebaseError");
        expect(err.code).toMatch(/^auth\//);
      }
    });

    it("excluded-page entry points fail loudly (throw or reject) with a FirebaseError", async () => {
      // Sync throw vs async reject is not part of the contract — the pages
      // wrap these in try/catch either way. Both must surface a FirebaseError.
      const expectFailure = async (fn: () => unknown) => {
        try {
          await fn();
          expect.unreachable("expected a FirebaseError");
        } catch (e) {
          expect((e as { name: string }).name).toBe("FirebaseError");
        }
      };
      await expectFailure(() => client.signInWithCustomToken(client.getAuth(), "tok"));
      await expectFailure(() => client.linkWithPopup({}, new client.GoogleAuthProvider()));
      await expectFailure(() => client.TotpMultiFactorGenerator.generateSecret());
    });
  });

  /* ---------------- provider stubs ---------------- */

  describe("provider classes (constructed by auth-provider.tsx and sign-in-security)", () => {
    it("are constructable with the Firebase providerIds and chainable config", () => {
      const g = new client.GoogleAuthProvider();
      expect(g.providerId).toBe("google.com");
      expect(g.addScope("email")).toBe(g);
      expect(g.setCustomParameters({ prompt: "select_account" })).toBe(g);
      expect(new client.GithubAuthProvider().providerId).toBe("github.com");
      expect(new client.OAuthProvider("apple.com").providerId).toBe("apple.com");
    });

    it("credentialFromError returns null (auth-provider's OAuth error path)", () => {
      expect(client.GoogleAuthProvider.credentialFromError(new Error("x"))).toBeNull();
      expect(client.GoogleAuthProvider.credentialFromResult({})).toBeNull();
    });
  });

  /* ---------------- session semantics ---------------- */

  describe("session restore and the User surface", () => {
    it("onAuthStateChanged fires asynchronously once with the current state", async () => {
      const seen: unknown[] = [];
      const unsub = client.onAuthStateChanged(client.getAuth(), (u) => seen.push(u));
      expect(seen).toHaveLength(0); // async like Firebase, never sync
      await tick();
      expect(seen).toEqual([null]);
      unsub();
    });

    it("a restored session yields a User with the mapped profile", async () => {
      client.__setSelfhostSession(sessionTokens());
      await tick();
      const user = client.getAuth().currentUser;
      expect(user).not.toBeNull();
      expect(user!.uid).toBe(UID);
      expect(user!.email).toBe("stefan@example.test");
      expect(user!.displayName).toBe("Stefan Test");
      expect(user!.emailVerified).toBe(true);
      expect(user!.isAnonymous).toBe(false);
      // app code filters user.providerData — exactly one linked provider
      expect(user!.providerData).toHaveLength(1);
      expect(user!.providerData[0].uid).toBe(UID);
    });

    it("getIdToken() resolves a JWT-shaped bearer for the data plane", async () => {
      const tokens = sessionTokens();
      client.__setSelfhostSession(tokens);
      await tick();
      const token = await client.getAuth().currentUser!.getIdToken();
      expect(token).toBe(tokens.id_token);
      expect(token.split(".")).toHaveLength(3);
    });

    it("getIdTokenResult().claims.admin reflects an admin session", async () => {
      client.__setSelfhostSession(sessionTokens({ admin: true }));
      await tick();
      const res = await client.getAuth().currentUser!.getIdTokenResult();
      expect(res.claims.admin).toBe(true);
      expect(res.signInProvider).toBeTruthy();
    });

    it("a non-admin session has no admin claim", async () => {
      client.__setSelfhostSession(sessionTokens());
      await tick();
      const res = await client.getAuth().currentUser!.getIdTokenResult();
      expect(res.claims.admin).not.toBe(true);
    });

    it("keeps the User identity stable across a token update (React refs)", async () => {
      client.__setSelfhostSession(sessionTokens());
      await tick();
      const before = client.getAuth().currentUser;
      client.__setSelfhostSession(sessionTokens()); // same uid, fresh token
      await tick();
      expect(client.getAuth().currentUser).toBe(before);
    });

    it("notifies subscribed listeners on sign-in and sign-out", async () => {
      const seen: Array<string | null> = [];
      const unsub = client.onAuthStateChanged(client.getAuth(), (u) => seen.push(u ? u.uid : null));
      await tick();
      client.__setSelfhostSession(sessionTokens());
      await tick();
      client.__setSelfhostSession(null);
      await tick();
      expect(seen).toEqual([null, UID, null]);
      unsub();
    });

    it("signOut() clears the session, the user, and persisted tokens", async () => {
      client.__setSelfhostSession(sessionTokens());
      await tick();
      const persistedKeys = fakeWindow.localStorage.keys();
      expect(persistedKeys.length).toBeGreaterThan(0);
      await client.signOut(client.getAuth());
      await tick();
      expect(client.getAuth().currentUser).toBeNull();
      for (const k of persistedKeys) expect(fakeWindow.localStorage.getItem(k)).toBeNull();
    });

    it("mirrors a session written by another tab (storage event)", async () => {
      // Contract, not mechanism: whatever key the client persists under,
      // a cross-tab write to that key must be picked up.
      client.__setSelfhostSession(sessionTokens());
      await tick();
      const [key] = fakeWindow.localStorage.keys();
      expect(key).toBeTruthy();
      // Simulate the other tab: replace the stored session, fire the event.
      const other = "Ab3dEf6hIj9kLm2nOp5qRs8tUv1w"; // another Firebase-shaped uid
      fakeWindow.localStorage.setItem(
        key,
        JSON.stringify({ id_token: makeJwt({ sub: other, exp: IN_AN_HOUR() }), expires_at: Date.now() + 3600_000 }),
      );
      for (const cb of fakeWindow.__listeners.get("storage") ?? []) cb({ key });
      await tick();
      expect(client.getAuth().currentUser?.uid).toBe(other);
    });
  });

  /* ---------------- Better Auth acceptance ---------------- */

  describe("Better Auth acceptance — real handler over a socket", () => {
    // The integration shape the W1 handoff prescribes: boot the REAL
    // createSelfhostAuth().handler over a listening socket (like
    // firestore-client.test.ts boots the data plane) and point the client
    // at it with __configureAuthClient.
    //
    // The provisioned user is unique PER RUN (uid still Firebase-shaped):
    // the compose CI job runs every suite against ONE shared Postgres, so a
    // fixed uid here would collide with better-auth.test.ts's fixture on
    // the (tenant_id, id) primary key.
    const UID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const REAL_UID = Array.from(
      { length: 28 },
      () => UID_ALPHABET[Math.floor(Math.random() * UID_ALPHABET.length)],
    ).join("");
    const REAL_EMAIL = `w1-client-${Date.now()}@example.test`;
    let server: http.Server;
    let base: string;

    beforeAll(async () => {
      // PGlite's emscripten loader browser-detects on a `window` global and
      // then tries to fetch its wasm from the fake origin — hide the fake
      // window while the database boots; queries after init don't re-detect.
      const g = globalThis as Record<string, unknown>;
      const savedWindow = g.window;
      delete g.window;
      let auth: Awaited<ReturnType<typeof createSelfhostAuth>>;
      try {
        auth = await createSelfhostAuth();
        await getFirestore()
          .collection("allowedEmails")
          .add({ email: REAL_EMAIL, createdAt: new Date() });
        await auth.provisionUser({
          uid: REAL_UID,
          email: REAL_EMAIL,
          password: "correct horse",
          displayName: "Stefan Test",
        });
      } finally {
        g.window = savedWindow;
      }
      server = http.createServer(toNodeHandler(auth.handler));
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    });

    it("exposes __configureAuthClient like the sibling data-plane shims", async () => {
      // The rewrite points the client at the selfhost auth backend the same
      // way firestore-client/storage-client are pointed at fibuki-api
      // (__configureFirestoreClient / __configureStorageClient).
      const hook = (client as unknown as Record<string, unknown>).__configureAuthClient;
      expect(typeof hook).toBe("function");
    });

    it("signInWithEmailAndPassword authenticates with the given credentials", async () => {
      // Before W1 the credentials were IGNORED and the browser redirected to
      // an external IdP (never resolved). Under Better Auth this is a real
      // credential sign-in resolving a UserCredential whose uid is the
      // server-side (Firebase-preserved) user id. The race guards the old
      // never-resolves failure mode; the generous timeout only covers
      // password hashing on a slow box, not the contract.
      client.__configureAuthClient({ apiUrl: base });
      const cred = await Promise.race([
        client.signInWithEmailAndPassword(client.getAuth(), REAL_EMAIL, "correct horse"),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("sign-in did not resolve")), 10_000)),
      ]);
      expect(cred.user.uid).toBe(REAL_UID);
      expect(cred.operationType).toBe("signIn");
    });

    it("wrong credentials reject with auth/invalid-credential instead of redirecting", async () => {
      client.__configureAuthClient({ apiUrl: base });
      await expect(
        Promise.race([
          client.signInWithEmailAndPassword(client.getAuth(), REAL_EMAIL, "wrong"),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("sign-in did not settle")), 10_000)),
        ]),
      ).rejects.toMatchObject({ name: "FirebaseError", code: "auth/invalid-credential" });
    });

    it("signOut() after a real sign-in revokes the server-side session too", async () => {
      client.__configureAuthClient({ apiUrl: base });
      await client.signInWithEmailAndPassword(client.getAuth(), REAL_EMAIL, "correct horse");
      await tick();
      const token = await client.getAuth().currentUser!.getIdToken();
      const sid = (JSON.parse(
        Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
      ) as { sid?: string }).sid;
      expect(typeof sid).toBe("string");

      await client.signOut(client.getAuth());
      await tick();
      expect(client.getAuth().currentUser).toBeNull();
      // Give the fire-and-forget sign-out a beat, then prove the session row
      // is gone — deleting it is what revokes every JWT minted from it.
      await new Promise((r) => setTimeout(r, 200));
      const rows = await __rawSqlForTest(
        `SELECT 1 FROM auth_sessions WHERE id = $1`,
        [sid],
        getTenantId(),
      );
      expect(rows.rows).toHaveLength(0);
    });
  });

  /* ---------------- dev short-circuit ---------------- */

  describe("dev short-circuit (NEXT_PUBLIC_FIBUKI_DEV_UID)", () => {
    it("mints a signed-in dev user with no network", async () => {
      const dev = await loadClient({ NEXT_PUBLIC_FIBUKI_DEV_UID: "dev-user-1" });
      const seen: Array<string | null> = [];
      dev.onAuthStateChanged(dev.getAuth(), (u) => seen.push(u ? u.uid : null));
      await tick();
      expect(seen).toEqual(["dev-user-1"]);
      await expect(dev.getAuth().currentUser!.getIdToken()).resolves.toBeTruthy();
      // restore the default module for the rest of the file
      client = await loadClient();
    });
  });
});

/* ------------------------------------------------------------------ */
/* Google social callback pickup (built-in mode)                       */
/*                                                                     */
/* The host's Better Auth callback set a session cookie and redirected  */
/* back to the app with ?fibuki_social=1; module-init picks that up,    */
/* swaps the cookie session for the bearer-token world, and clears the  */
/* marker. Regression net for the mid-pickup-reload strand.             */
/* ------------------------------------------------------------------ */

describe("selfhost auth-client — Google social callback pickup (built-in mode)", () => {
  const API = "https://app.selfhost.test/api";
  const AUTH_BASE = `${API}/__auth`;

  /**
   * Load the client as if the browser just returned from the Google flow:
   * the social marker is already on the URL and the API base is configured,
   * so module-init's fire-and-forget maybeCompleteSocialCallback runs the real
   * pickup against `fetchImpl` (a stubbed host serving get-session + token).
   */
  async function loadAfterSocialReturn(
    fetchImpl: typeof fetch,
    onReplaceState: (url?: string) => void,
  ): Promise<AuthClient> {
    vi.resetModules();
    fakeWindow = installWindow();
    fakeWindow.location.pathname = "/login";
    fakeWindow.location.search = "?fibuki_social=1";
    fakeWindow.location.href = "https://app.selfhost.test/login?fibuki_social=1";
    fakeWindow.history.replaceState = (_data, _unused, url) => onReplaceState(url);
    for (const k of [
      "NEXT_PUBLIC_FIBUKI_DEV_UID",
      "NEXT_PUBLIC_FIBUKI_DEV_ADMIN",
      "NEXT_PUBLIC_OIDC_ISSUER",
      "NEXT_PUBLIC_OIDC_CLIENT_ID",
    ]) {
      delete process.env[k];
    }
    process.env.NEXT_PUBLIC_FIBUKI_API_URL = API;
    vi.stubGlobal("fetch", fetchImpl);
    return import("../../../lib/selfhost/auth-client");
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NEXT_PUBLIC_FIBUKI_API_URL;
  });

  it("picks up the server session, adopts it, then strips the spent marker", async () => {
    const replaced: Array<string | undefined> = [];
    const idToken = makeJwt({ sub: UID, email: "stefan@example.test", exp: IN_AN_HOUR() });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${AUTH_BASE}/get-session`) {
        return new Response(JSON.stringify({ session: { token: "sess-abc" } }), { status: 200 });
      }
      if (url === `${AUTH_BASE}/token`) {
        return new Response(JSON.stringify({ token: idToken }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const c = await loadAfterSocialReturn(fetchImpl, (url) => replaced.push(url));
    for (let i = 0; i < 6; i++) await tick();

    expect(c.getAuth().currentUser?.uid).toBe(UID);
    // Marker cleared once the pickup landed — back to a clean /login, no query.
    expect(replaced).toContain("/login");
  });

  it("keeps the marker until the pickup settles — a mid-pickup reload can retry (regression)", async () => {
    // The bug: the marker was stripped up front, before the async
    // get-session / JWT mint. A reload during that window found no marker,
    // skipped the pickup, and stranded a live server session on the login
    // screen. Pin the fix: nothing is stripped while the pickup is in flight.
    let releaseSession!: () => void;
    const gate = new Promise<void>((r) => (releaseSession = r));
    const replaced: Array<string | undefined> = [];
    const idToken = makeJwt({ sub: UID, exp: IN_AN_HOUR() });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${AUTH_BASE}/get-session`) {
        await gate; // stall the pickup mid-flight
        return new Response(JSON.stringify({ session: { token: "sess-xyz" } }), { status: 200 });
      }
      if (url === `${AUTH_BASE}/token`) {
        return new Response(JSON.stringify({ token: idToken }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const c = await loadAfterSocialReturn(fetchImpl, (url) => replaced.push(url));
    for (let i = 0; i < 4; i++) await tick();

    // Pickup is parked on the stalled get-session: the marker must NOT have
    // been touched yet (pre-fix code would already have stripped it here).
    expect(replaced).toHaveLength(0);
    expect(c.getAuth().currentUser).toBeNull();

    releaseSession();
    for (let i = 0; i < 6; i++) await tick();

    // Now the session is adopted AND the spent marker is finally cleared.
    expect(c.getAuth().currentUser?.uid).toBe(UID);
    expect(replaced).toContain("/login");
  });
});

/* ------------------------------------------------------------------ */
/* OIDC refresh: cross-tab serialisation (fork #73)                    */
/*                                                                     */
/* The bug: `_refreshInFlight` is module-scoped, so it dedupes within  */
/* one tab while the refresh_token it protects lives in localStorage,  */
/* shared by every tab. Two tabs replayed one single-use rotating      */
/* token, the provider revoked it, and the loser's clearTokens() threw */
/* away the session the winner had just stored — signing every tab out.*/
/*                                                                     */
/* "Two tabs" here = two module instances over ONE fake window, which  */
/* is exactly the real asymmetry: module state is per-tab, localStorage*/
/* is per-origin. The Node env has no navigator.locks, so these tests  */
/* exercise the localStorage-lease fallback; the last test pins that   */
/* Web Locks is preferred when the browser has it.                     */
/* ------------------------------------------------------------------ */

describe("selfhost auth-client — OIDC refresh serialisation (fork #73)", () => {
  const ISSUER = "https://id.selfhost.test/application/o/fibuki";
  const TOKEN_ENDPOINT = `${ISSUER}/token/`;
  const TOKENS_KEY = "fibuki.oidc.tokens";

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  function discoveryResponse(): Response {
    return new Response(
      JSON.stringify({
        authorization_endpoint: `${ISSUER}/authorize/`,
        token_endpoint: TOKEN_ENDPOINT,
      }),
      { status: 200 },
    );
  }

  /** Install one window + issuer-mode env, and route all fetches at `fetchImpl`. */
  function installOidcEnv(fetchImpl: typeof fetch): FakeWindow {
    const w = installWindow();
    for (const k of [
      "NEXT_PUBLIC_FIBUKI_DEV_UID",
      "NEXT_PUBLIC_FIBUKI_DEV_ADMIN",
      "NEXT_PUBLIC_FIBUKI_API_URL",
    ]) {
      delete process.env[k];
    }
    process.env.NEXT_PUBLIC_OIDC_ISSUER = ISSUER;
    process.env.NEXT_PUBLIC_OIDC_CLIENT_ID = "fibuki-selfhost";
    vi.stubGlobal("fetch", fetchImpl);
    return w;
  }

  /** Seed the shared token set every "tab" restores from on load. */
  function seedTokens(w: FakeWindow, t: Record<string, unknown>): void {
    w.localStorage.setItem(TOKENS_KEY, JSON.stringify(t));
  }

  function readStored(w: FakeWindow): Record<string, unknown> | null {
    const raw = w.localStorage.getItem(TOKENS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  }

  /** A fresh module instance over the already-installed window — one "tab". */
  async function openTab(): Promise<AuthClient> {
    vi.resetModules();
    return import("../../../lib/selfhost/auth-client");
  }

  /** A set well inside the staleness window (jitter tops out at 60s). */
  const staleSet = (refresh: string, extra: Record<string, unknown> = {}) => ({
    id_token: makeJwt({ sub: UID, email: "stefan@example.test", exp: Math.floor(Date.now() / 1000) + 5 }),
    refresh_token: refresh,
    expires_at: Date.now() + 5_000,
    ...extra,
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NEXT_PUBLIC_OIDC_ISSUER;
    delete process.env.NEXT_PUBLIC_OIDC_CLIENT_ID;
  });

  it("two tabs refreshing at once spend the refresh_token exactly once", async () => {
    const spent: string[] = [];
    let release!: () => void;
    const winnerHeld = new Promise<void>((r) => (release = r));
    const rotatedIdToken = makeJwt({ sub: UID, email: "stefan@example.test", exp: IN_AN_HOUR() });

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return discoveryResponse();
      if (url === TOKEN_ENDPOINT) {
        spent.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "");
        await winnerHeld; // hold the winner inside the lock so the peer must queue
        return new Response(
          JSON.stringify({ id_token: rotatedIdToken, refresh_token: "rt-2", expires_in: 3600 }),
          { status: 200 },
        );
      }
      return new Response("unexpected", { status: 404 });
    }) as unknown as typeof fetch;

    const w = installOidcEnv(fetchImpl);
    seedTokens(w, staleSet("rt-1"));

    const tabA = await openTab();
    const tabB = await openTab();
    await tick();

    const pA = tabA.getAuth().currentUser!.getIdToken();
    const pB = tabB.getAuth().currentUser!.getIdToken();

    // One tab wins the lock and reaches the network; the other is parked on it.
    while (spent.length === 0) await sleep(10);
    await sleep(300);
    expect(spent).toEqual(["rt-1"]);

    release();
    const [a, b] = await Promise.all([pA, pB]);

    // Pre-fix, the loser POSTed "rt-1" a second time, got "Revoked refresh token
    // was used", and cleared the shared token set.
    expect(spent).toEqual(["rt-1"]);
    expect(a).toBe(rotatedIdToken);
    expect(b).toBe(rotatedIdToken);
    expect(readStored(w)).toMatchObject({ refresh_token: "rt-2", rotates: true });
  });

  it("adopts a peer's newer token set instead of signing out on a lost race", async () => {
    const peerIdToken = makeJwt({ sub: UID, email: "stefan@example.test", exp: IN_AN_HOUR() });
    let w!: FakeWindow;

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return discoveryResponse();
      if (url === TOKEN_ENDPOINT) {
        // The peer won while we were in flight: it rotated the token and stored
        // a good set. Our copy is now the revoked one.
        seedTokens(w, {
          id_token: peerIdToken,
          refresh_token: "rt-2",
          expires_at: Date.now() + 3_600_000,
          rotates: true,
        });
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return new Response("unexpected", { status: 404 });
    }) as unknown as typeof fetch;

    w = installOidcEnv(fetchImpl);
    seedTokens(w, staleSet("rt-1", { rotates: true }));

    const tab = await openTab();
    await tick();

    await expect(tab.getAuth().currentUser!.getIdToken()).resolves.toBe(peerIdToken);
    // Still signed in, and the winner's set survived — this is the whole bug.
    expect(tab.getAuth().currentUser?.uid).toBe(UID);
    expect(readStored(w)).toMatchObject({ refresh_token: "rt-2" });
  });

  it("adopts a peer's set on a transient failure even when the token never rotated", async () => {
    // Non-rotating provider: refresh_token stays "rt-1", so only the id_token
    // distinguishes the peer's newer set. A 503 must not clear it.
    const peerIdToken = makeJwt({ sub: UID, email: "stefan@example.test", exp: IN_AN_HOUR() });
    let w!: FakeWindow;

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return discoveryResponse();
      if (url === TOKEN_ENDPOINT) {
        seedTokens(w, {
          id_token: peerIdToken,
          refresh_token: "rt-1",
          expires_at: Date.now() + 3_600_000,
        });
        return new Response("upstream unavailable", { status: 503 });
      }
      return new Response("unexpected", { status: 404 });
    }) as unknown as typeof fetch;

    w = installOidcEnv(fetchImpl);
    seedTokens(w, staleSet("rt-1"));

    const tab = await openTab();
    await tick();

    await expect(tab.getAuth().currentUser!.getIdToken()).resolves.toBe(peerIdToken);
    expect(tab.getAuth().currentUser?.uid).toBe(UID);
    expect(readStored(w)).toMatchObject({ id_token: peerIdToken, refresh_token: "rt-1" });
  });

  it("still signs out when a refresh fails and nothing newer is stored", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return discoveryResponse();
      if (url === TOKEN_ENDPOINT) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return new Response("unexpected", { status: 404 });
    }) as unknown as typeof fetch;

    const w = installOidcEnv(fetchImpl);
    seedTokens(w, staleSet("rt-1"));

    const tab = await openTab();
    await tick();

    await expect(tab.getAuth().currentUser!.getIdToken()).rejects.toMatchObject({
      code: "auth/user-token-expired",
    });
    expect(tab.getAuth().currentUser).toBeNull();
    expect(readStored(w)).toBeNull();
  });

  it("#77: a 503 from the provider keeps the session instead of signing out", async () => {
    // Authentik restarting, or the proxy in front of it answering for it. The
    // refresh_token is untouched and the session is alive; the pre-fix code
    // cleared storage and dropped the user on the login screen.
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return discoveryResponse();
      if (url === TOKEN_ENDPOINT) return new Response("service unavailable", { status: 503 });
      return new Response("unexpected", { status: 404 });
    }) as unknown as typeof fetch;

    const w = installOidcEnv(fetchImpl);
    seedTokens(w, staleSet("rt-1"));

    const tab = await openTab();
    await tick();

    await expect(tab.getAuth().currentUser!.getIdToken()).rejects.toMatchObject({
      code: "auth/network-request-failed",
    });
    expect(tab.getAuth().currentUser?.uid).toBe(UID);
    expect(readStored(w)).toMatchObject({ refresh_token: "rt-1" });
  });

  it("#77: a 502 with an HTML body from the proxy keeps the session", async () => {
    // Nothing parseable comes back, so the OAuth error code is unknowable —
    // and an unknowable reason is not proof that the session was revoked.
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return discoveryResponse();
      if (url === TOKEN_ENDPOINT) {
        return new Response("<html><body>502 Bad Gateway</body></html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("unexpected", { status: 404 });
    }) as unknown as typeof fetch;

    const w = installOidcEnv(fetchImpl);
    seedTokens(w, staleSet("rt-1"));

    const tab = await openTab();
    await tick();

    await expect(tab.getAuth().currentUser!.getIdToken()).rejects.toMatchObject({
      code: "auth/network-request-failed",
    });
    expect(tab.getAuth().currentUser?.uid).toBe(UID);
    expect(readStored(w)).toMatchObject({ refresh_token: "rt-1" });
  });

  it("#77: a 400 temporarily_unavailable is the provider talking, not the grant", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return discoveryResponse();
      if (url === TOKEN_ENDPOINT) {
        return new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 400 });
      }
      return new Response("unexpected", { status: 404 });
    }) as unknown as typeof fetch;

    const w = installOidcEnv(fetchImpl);
    seedTokens(w, staleSet("rt-1"));

    const tab = await openTab();
    await tick();

    await expect(tab.getAuth().currentUser!.getIdToken()).rejects.toMatchObject({
      code: "auth/network-request-failed",
    });
    expect(readStored(w)).toMatchObject({ refresh_token: "rt-1" });
  });

  it("refuses to re-present a consumed refresh_token when the provider rotates", async () => {
    const nextIdToken = makeJwt({ sub: UID, email: "stefan@example.test", exp: IN_AN_HOUR() });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return discoveryResponse();
      if (url === TOKEN_ENDPOINT) {
        // Rotating provider, yet no replacement in the body. Writing "rt-1"
        // back would guarantee the NEXT refresh replays a revoked token.
        return new Response(JSON.stringify({ id_token: nextIdToken, expires_in: 3600 }), {
          status: 200,
        });
      }
      return new Response("unexpected", { status: 404 });
    }) as unknown as typeof fetch;

    const w = installOidcEnv(fetchImpl);
    seedTokens(w, staleSet("rt-1", { rotates: true }));

    const tab = await openTab();
    await tick();

    await expect(tab.getAuth().currentUser!.getIdToken()).rejects.toMatchObject({
      code: "auth/internal-error",
    });
    // The stored set is left untouched: the host 401s and the app re-authenticates,
    // which beats replaying a consumed token.
    expect(readStored(w)).toMatchObject({ refresh_token: "rt-1", rotates: true });
  });

  it("keeps reusing the refresh_token on a provider that never rotates", async () => {
    const nextIdToken = makeJwt({ sub: UID, email: "stefan@example.test", exp: IN_AN_HOUR() });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return discoveryResponse();
      if (url === TOKEN_ENDPOINT) {
        // RFC 6749 §6: refresh_token is optional in the response, and a
        // non-rotating provider expects the client to keep the one it has.
        return new Response(JSON.stringify({ id_token: nextIdToken, expires_in: 3600 }), {
          status: 200,
        });
      }
      return new Response("unexpected", { status: 404 });
    }) as unknown as typeof fetch;

    const w = installOidcEnv(fetchImpl);
    seedTokens(w, staleSet("rt-1"));

    const tab = await openTab();
    await tick();

    await expect(tab.getAuth().currentUser!.getIdToken()).resolves.toBe(nextIdToken);
    const stored = readStored(w);
    expect(stored).toMatchObject({ refresh_token: "rt-1" });
    expect(stored?.rotates).toBeUndefined();
  });

  it("serialises through navigator.locks when the browser provides it", async () => {
    const nextIdToken = makeJwt({ sub: UID, email: "stefan@example.test", exp: IN_AN_HOUR() });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return discoveryResponse();
      if (url === TOKEN_ENDPOINT) {
        return new Response(
          JSON.stringify({ id_token: nextIdToken, refresh_token: "rt-2", expires_in: 3600 }),
          { status: 200 },
        );
      }
      return new Response("unexpected", { status: 404 });
    }) as unknown as typeof fetch;

    const w = installOidcEnv(fetchImpl);
    const inside: string[] = [];
    const request = vi.fn(async (name: string, cb: () => Promise<unknown>) => {
      inside.push(name);
      return cb();
    });
    vi.stubGlobal("navigator", { locks: { request } });
    seedTokens(w, staleSet("rt-1"));

    const tab = await openTab();
    await tick();

    await expect(tab.getAuth().currentUser!.getIdToken()).resolves.toBe(nextIdToken);
    // Exactly one lock, held around the refresh — not the lease fallback.
    expect(inside).toEqual(["fibuki-oidc-refresh"]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(readStored(w)).toMatchObject({ refresh_token: "rt-2", rotates: true });
  });
});
