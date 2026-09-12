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
  /**
   * Clients this describe loaded, so `afterEach` can sign them out.
   *
   * Module init starts a ChangeStreamClient as soon as a session is adopted
   * (auth-client's `ensureChangeStream`), and that client reconnects on a
   * backoff timer for the life of the worker process. Nothing else holds a
   * handle to it, so a client left signed in keeps calling `getToken()` — and
   * `getToken()` reads whatever `window` a LATER test installed, finds a stale
   * token set there, and takes the OIDC refresh lock inside that test. That is
   * what made the lock test below flaky (#150).
   */
  const loaded: AuthClient[] = [];

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
    const client = (await import("../../../lib/selfhost/auth-client")) as AuthClient;
    loaded.push(client);
    return client;
  }

  afterEach(async () => {
    // Sign out before unstubbing, so the (fire-and-forget) revoke call still
    // hits the stubbed host rather than the network. signOut clears the user
    // and notifies, which is what stops the change stream.
    for (const client of loaded.splice(0)) {
      await client.signOut(client.getAuth()).catch(() => undefined);
    }
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
    // session is alive; the pre-fix code cleared storage and dropped the user
    // on the login screen.
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
    // #279 changed the second half of this expectation. The SET still survives
    // — that is this test — but rt-1 no longer survives for replay: a 503 can
    // equally be an answer that was issued, and so spent it, and then died in
    // the proxy, so it is marked unconfirmed exactly as a lost response is.
    expect(readStored(w)).toMatchObject({ refresh_token: "rt-1", refresh_unconfirmed: "rt-1" });
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
    // Same change as the 503 above (#279): keeping the session is not the same
    // as keeping the token presentable, and an unparseable 502 says nothing
    // about whether the grant was issued before the proxy gave up.
    expect(readStored(w)).toMatchObject({ refresh_token: "rt-1", refresh_unconfirmed: "rt-1" });
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
    // #279 marks a 5xx but deliberately not this: a 4xx is the provider
    // answering ABOUT the grant, and this code says it never got that far, so
    // nothing was spent and rt-1 stays presentable.
    expect(readStored(w)?.refresh_unconfirmed).toBeUndefined();
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

    // Measure the locks taken BY THIS REFRESH, not every lock taken over the
    // tab's lifetime. Anything else alive in the worker shares one globalThis,
    // so the lifetime form counted other modules' locks too (#150).
    const takenBefore = inside.length;
    await expect(tab.getAuth().currentUser!.getIdToken()).resolves.toBe(nextIdToken);
    // Exactly one lock, held around the refresh — not the lease fallback.
    expect(inside.slice(takenBefore)).toEqual(["fibuki-oidc-refresh"]);
    expect(request).toHaveBeenCalledTimes(takenBefore + 1);
    expect(readStored(w)).toMatchObject({ refresh_token: "rt-2", rotates: true });
  });

  /* ---------------------------------------------------------------- */
  /* #216 — the refresh whose response never arrives                   */
  /*                                                                   */
  /* A rotating provider consumes the presented refresh_token when it  */
  /* ISSUES the response, not when the client reads it. So a fetch     */
  /* that REJECTS (connection dropped, TLS reset, laptop suspended     */
  /* mid-flight) leaves a token that is already dead server-side       */
  /* stored as if it were current. Every later refresh replayed it —   */
  /* one suspicious_request per attempt, until the session died.       */
  /* ---------------------------------------------------------------- */

  const LEASE_KEY = "fibuki.oidc.refresh-lease";

  /** A token endpoint whose answer never arrives, recording what was spent. */
  function lostResponseFetch(spent: string[], onGrant?: () => void): typeof fetch {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return discoveryResponse();
      if (url === TOKEN_ENDPOINT) {
        spent.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "");
        onGrant?.();
        // What a browser gives you when the connection dies mid-flight.
        throw new TypeError("Failed to fetch");
      }
      return new Response("unexpected", { status: 404 });
    }) as unknown as typeof fetch;
  }

  it("a rejecting fetch is caught, and marks the token it presented", async () => {
    const spent: string[] = [];
    const w = installOidcEnv(lostResponseFetch(spent));
    seedTokens(w, staleSet("rt-1", { rotates: true }));

    const tab = await openTab();
    await tick();

    // Pre-fix the raw TypeError escaped the refresh routine, past every
    // recovery path, and the token-saving step below it never ran.
    await expect(tab.getAuth().currentUser!.getIdToken()).rejects.toMatchObject({
      name: "FirebaseError",
      code: "auth/network-request-failed",
    });
    // A lost response says nothing about the session (fork #77), so keep it —
    // but record that rt-1 went out unanswered.
    expect(tab.getAuth().currentUser?.uid).toBe(UID);
    expect(readStored(w)).toMatchObject({ refresh_token: "rt-1", refresh_unconfirmed: "rt-1" });
    expect(spent).toEqual(["rt-1"]);
  });

  it("honours the mark after a reload, so a fresh tab does not replay it either", async () => {
    // The mark lives in localStorage precisely so it outlives the tab that made
    // it: a reload, or any other tab on this origin, has to refuse the same
    // token too, or the replay just moves to whichever tab looks next.
    const spent: string[] = [];
    const w = installOidcEnv(lostResponseFetch(spent));
    seedTokens(w, staleSet("rt-1", { rotates: true, refresh_unconfirmed: "rt-1" }));

    const reloaded = await openTab();
    await tick();

    await expect(reloaded.getAuth().currentUser!.getIdToken()).rejects.toMatchObject({
      code: "auth/user-token-expired",
    });
    expect(spent).toEqual([]);
    expect(reloaded.getAuth().currentUser).toBeNull();
    expect(readStored(w)).toBeNull();
  });

  it("a rejecting discovery fetch fails as an auth error, not a raw TypeError", async () => {
    const rejectingFetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const w = installOidcEnv(rejectingFetch);
    seedTokens(w, staleSet("rt-1", { rotates: true }));

    const tab = await openTab();
    await tick();

    // Discovery is the other fetch on the refresh path. Nothing was presented,
    // so there is nothing to mark — but the rejection still must not escape.
    await expect(tab.getAuth().currentUser!.getIdToken()).rejects.toMatchObject({
      name: "FirebaseError",
      code: "auth/network-request-failed",
    });
    expect(readStored(w)).toMatchObject({ refresh_token: "rt-1" });
    expect(readStored(w)?.refresh_unconfirmed).toBeUndefined();
  });

  it("a second refresh after a lost response re-authenticates instead of replaying", async () => {
    const spent: string[] = [];
    const w = installOidcEnv(lostResponseFetch(spent));
    seedTokens(w, staleSet("rt-1", { rotates: true }));

    const tab = await openTab();
    await tick();

    await expect(tab.getAuth().currentUser!.getIdToken()).rejects.toMatchObject({
      code: "auth/network-request-failed",
    });
    // Nothing newer was written by a peer, and the id_token is stale: the only
    // honest move left is the login screen.
    await expect(tab.getAuth().currentUser!.getIdToken()).rejects.toMatchObject({
      code: "auth/user-token-expired",
    });
    // The whole ticket in one assertion — rt-1 went out exactly once, ever.
    expect(spent).toEqual(["rt-1"]);
    expect(tab.getAuth().currentUser).toBeNull();
    expect(readStored(w)).toBeNull();
  });

  it("a forced refresh on a marked set hands back the still-valid id_token", async () => {
    // auth-provider forces a refresh on every visibilitychange. A network blip
    // must not spend the marked token, and must not sign the user out while the
    // id_token they hold is still good.
    const spent: string[] = [];
    const w = installOidcEnv(lostResponseFetch(spent));
    const liveIdToken = makeJwt({ sub: UID, email: "stefan@example.test", exp: IN_AN_HOUR() });
    seedTokens(w, {
      id_token: liveIdToken,
      refresh_token: "rt-1",
      expires_at: Date.now() + 3_600_000,
      rotates: true,
      refresh_unconfirmed: "rt-1",
    });

    const tab = await openTab();
    await tick();

    await expect(tab.getAuth().currentUser!.getIdToken(true)).resolves.toBe(liveIdToken);
    expect(spent).toEqual([]);
    expect(tab.getAuth().currentUser?.uid).toBe(UID);
  });

  it("adopts a peer's set written while our lost refresh was in flight", async () => {
    const peerIdToken = makeJwt({ sub: UID, email: "stefan@example.test", exp: IN_AN_HOUR() });
    const spent: string[] = [];
    let w!: FakeWindow;

    // The peer rotated and stored a good set; our answer never came back.
    const fetchImpl = lostResponseFetch(spent, () => {
      seedTokens(w, {
        id_token: peerIdToken,
        refresh_token: "rt-2",
        expires_at: Date.now() + 3_600_000,
        rotates: true,
      });
    });

    w = installOidcEnv(fetchImpl);
    seedTokens(w, staleSet("rt-1", { rotates: true }));

    const tab = await openTab();
    await tick();

    await expect(tab.getAuth().currentUser!.getIdToken()).resolves.toBe(peerIdToken);
    expect(tab.getAuth().currentUser?.uid).toBe(UID);
    // The peer's set is the truth now, so our doubt must not be stamped on it.
    const stored = readStored(w);
    expect(stored).toMatchObject({ refresh_token: "rt-2" });
    expect(stored?.refresh_unconfirmed).toBeUndefined();
  });

  it("adopts a peer's newer set stored after our response was lost", async () => {
    const rotatedIdToken = makeJwt({ sub: UID, email: "stefan@example.test", exp: IN_AN_HOUR() });
    const spent: string[] = [];

    // rt-1's answer never arrives; anything else the provider answers normally.
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return discoveryResponse();
      if (url === TOKEN_ENDPOINT) {
        const rt = new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
        spent.push(rt);
        if (rt === "rt-1") throw new TypeError("Failed to fetch");
        return new Response(
          JSON.stringify({ id_token: rotatedIdToken, refresh_token: "rt-3", expires_in: 3600 }),
          { status: 200 },
        );
      }
      return new Response("unexpected", { status: 404 });
    }) as unknown as typeof fetch;

    const w = installOidcEnv(fetchImpl);
    seedTokens(w, staleSet("rt-1", { rotates: true }));

    const tab = await openTab();
    await tick();

    await expect(tab.getAuth().currentUser!.getIdToken()).rejects.toMatchObject({
      code: "auth/network-request-failed",
    });

    // A peer refreshes afterwards and stores its set — itself stale again by
    // the time we come back, so we really do have to refresh from it.
    seedTokens(w, staleSet("rt-2", { rotates: true }));

    await expect(tab.getAuth().currentUser!.getIdToken()).resolves.toBe(rotatedIdToken);
    // The peer's token was spent; ours was never spent twice.
    expect(spent).toEqual(["rt-1", "rt-2"]);
    expect(tab.getAuth().currentUser?.uid).toBe(UID);
    expect(readStored(w)).toMatchObject({ refresh_token: "rt-3", rotates: true });
  });

  it("fails the caller when the lease lock times out, rather than refreshing unlocked", async () => {
    const spent: string[] = [];
    const w = installOidcEnv(lostResponseFetch(spent));
    seedTokens(w, staleSet("rt-1", { rotates: true }));
    // A peer holds the lease with a claim that never ages past LEASE_TTL_MS, so
    // no amount of polling can steal it. (No navigator.locks here, so the
    // localStorage lease is the lock — the fallback path.)
    w.localStorage.setItem(
      LEASE_KEY,
      JSON.stringify({ owner: "peer-tab", at: Date.now() + 3_600_000 }),
    );

    const tab = await openTab();
    await tick();

    vi.useFakeTimers();
    try {
      const pending = tab.getAuth().currentUser!.getIdToken();
      const settled = expect(pending).rejects.toMatchObject({ code: "auth/timeout" });
      await vi.advanceTimersByTimeAsync(13_000); // past LEASE_MAX_WAIT_MS (#280 widened it past LEASE_TTL_MS)
      await settled;
    } finally {
      vi.useRealTimers();
    }

    // Pre-fix the timeout ran the refresh unguarded — the unserialised replay
    // this ticket exists to remove. Nothing was spent, nothing was lost.
    expect(spent).toEqual([]);
    expect(tab.getAuth().currentUser?.uid).toBe(UID);
    expect(readStored(w)).toMatchObject({ refresh_token: "rt-1" });
  });

  it("#280: steals a stale lease left by a holder that crashed before releasing it", async () => {
    // Unlike the pinned-forever lease above, this claim ages exactly like a
    // real one: nothing ever touches it again after the initial write, so it
    // is stealable the moment LEASE_TTL_MS has actually elapsed. Pre-fix,
    // LEASE_MAX_WAIT_MS (5s) was shorter than LEASE_TTL_MS (10s), so a waiting
    // peer always gave up with auth/timeout before that moment arrived.
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
    seedTokens(w, staleSet("rt-1", { rotates: true }));
    w.localStorage.setItem(LEASE_KEY, JSON.stringify({ owner: "peer-tab", at: Date.now() }));

    const tab = await openTab();
    await tick();

    vi.useFakeTimers();
    try {
      const pending = tab.getAuth().currentUser!.getIdToken();
      const settled = expect(pending).resolves.toBe(nextIdToken);
      // Past LEASE_TTL_MS (10s), comfortably inside LEASE_MAX_WAIT_MS: long
      // enough for the peer's claim to go stale and for our own poll to
      // notice and steal it before we'd give up.
      await vi.advanceTimersByTimeAsync(10_500);
      await settled;
    } finally {
      vi.useRealTimers();
    }

    expect(tab.getAuth().currentUser?.uid).toBe(UID);
    expect(readStored(w)).toMatchObject({ refresh_token: "rt-2", rotates: true });
  });

  it("#280: still times out against a peer that keeps its lease continuously fresh", async () => {
    // The fail-shut behaviour #216 added must survive #280's wider wait: a
    // peer that is genuinely alive and re-claims its lease well inside
    // LEASE_TTL_MS never goes stale, so the timeout still has to fire.
    const spent: string[] = [];
    const w = installOidcEnv(lostResponseFetch(spent));
    seedTokens(w, staleSet("rt-1", { rotates: true }));
    w.localStorage.setItem(LEASE_KEY, JSON.stringify({ owner: "peer-tab", at: Date.now() }));

    const tab = await openTab();
    await tick();

    vi.useFakeTimers();
    try {
      const pending = tab.getAuth().currentUser!.getIdToken();
      const settled = expect(pending).rejects.toMatchObject({ code: "auth/timeout" });
      // Re-claim every 4s — well under LEASE_TTL_MS (10s) — for longer than
      // LEASE_MAX_WAIT_MS, so the lease is never once stale.
      for (let elapsed = 0; elapsed < 14_000; elapsed += 4_000) {
        w.localStorage.setItem(LEASE_KEY, JSON.stringify({ owner: "peer-tab", at: Date.now() }));
        await vi.advanceTimersByTimeAsync(4_000);
      }
      await settled;
    } finally {
      vi.useRealTimers();
    }

    expect(spent).toEqual([]);
    expect(tab.getAuth().currentUser?.uid).toBe(UID);
    expect(readStored(w)).toMatchObject({ refresh_token: "rt-1" });
  });

  /* ---------------------------------------------------------------- */
  /* #279 — the refresh answered with a 5xx                           */
  /*                                                                   */
  /* Same ambiguity as #216 reached through a different door: the IdP  */
  /* rotates the refresh_token when it ISSUES the response, and that   */
  /* response can die in the proxy on the way back. A 502/503/504 is   */
  /* therefore no proof that the grant never happened, so the token it */
  /* presented is marked and never presented again. A 4xx IS an answer */
  /* about the grant and stays unmarked (fork #77 keeps the session    */
  /* either way — that part is unchanged).                             */
  /* ---------------------------------------------------------------- */

  /** A token endpoint that answers every grant with `status`, recording spends. */
  function failingGrantFetch(status: number, spent: string[], onGrant?: () => void): typeof fetch {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return discoveryResponse();
      if (url === TOKEN_ENDPOINT) {
        spent.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "");
        onGrant?.();
        return new Response("upstream unavailable", { status });
      }
      return new Response("unexpected", { status: 404 });
    }) as unknown as typeof fetch;
  }

  it("#279: a 502 on the grant marks the token it presented", async () => {
    const spent: string[] = [];
    const w = installOidcEnv(failingGrantFetch(502, spent));
    seedTokens(w, staleSet("rt-1", { rotates: true }));

    const tab = await openTab();
    await tick();

    await expect(tab.getAuth().currentUser!.getIdToken()).rejects.toMatchObject({
      name: "FirebaseError",
      code: "auth/network-request-failed",
    });
    // The session is kept, as fork #77 decided — but rt-1 is now "presented,
    // outcome unknown", the same state a lost response leaves it in (#216).
    expect(tab.getAuth().currentUser?.uid).toBe(UID);
    expect(readStored(w)).toMatchObject({ refresh_token: "rt-1", refresh_unconfirmed: "rt-1" });
    expect(spent).toEqual(["rt-1"]);
  });

  for (const status of [502, 503, 504]) {
    it(`#279: a second refresh after a ${status} re-authenticates instead of replaying`, async () => {
      const spent: string[] = [];
      const w = installOidcEnv(failingGrantFetch(status, spent));
      seedTokens(w, staleSet("rt-1", { rotates: true }));

      const tab = await openTab();
      await tick();

      await expect(tab.getAuth().currentUser!.getIdToken()).rejects.toMatchObject({
        code: "auth/network-request-failed",
      });
      expect(readStored(w)).toMatchObject({ refresh_unconfirmed: "rt-1" });

      // Nothing newer was written by a peer and the id_token is stale, so the
      // only honest move left is the login screen — not another POST of a token
      // the provider may already have revoked.
      await expect(tab.getAuth().currentUser!.getIdToken()).rejects.toMatchObject({
        code: "auth/user-token-expired",
      });
      // The whole ticket in one assertion — rt-1 went out exactly once, ever.
      expect(spent).toEqual(["rt-1"]);
      expect(tab.getAuth().currentUser).toBeNull();
      expect(readStored(w)).toBeNull();
    });
  }

  it("#279: a 400 the provider answered with leaves the token presentable", async () => {
    // temporarily_unavailable in a 4xx: the provider talking about itself, so
    // fork #77 keeps the session — and it ANSWERED, so nothing was spent. This
    // is the case #279 must NOT widen to: the second attempt still presents it.
    const spent: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return discoveryResponse();
      if (url === TOKEN_ENDPOINT) {
        spent.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "");
        return new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 400 });
      }
      return new Response("unexpected", { status: 404 });
    }) as unknown as typeof fetch;

    const w = installOidcEnv(fetchImpl);
    seedTokens(w, staleSet("rt-1", { rotates: true }));

    const tab = await openTab();
    await tick();

    for (let i = 0; i < 2; i++) {
      await expect(tab.getAuth().currentUser!.getIdToken()).rejects.toMatchObject({
        code: "auth/network-request-failed",
      });
    }
    expect(spent).toEqual(["rt-1", "rt-1"]);
    expect(readStored(w)?.refresh_unconfirmed).toBeUndefined();
    expect(tab.getAuth().currentUser?.uid).toBe(UID);
  });

  it("#279: a 429 is the provider throttling, not an answer that went missing", async () => {
    // The other way into the transient branch from below the 5xx line, and a
    // different code path to the 400 above: isSessionRefused short-circuits on
    // the status, without reading a body. The provider declined to look at the
    // grant, so nothing was spent and rt-1 is presented again — this pins the
    // bottom edge of the `>= 500` gate (#279).
    const spent: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return discoveryResponse();
      if (url === TOKEN_ENDPOINT) {
        spent.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "");
        return new Response("slow down", { status: 429 });
      }
      return new Response("unexpected", { status: 404 });
    }) as unknown as typeof fetch;

    const w = installOidcEnv(fetchImpl);
    seedTokens(w, staleSet("rt-1", { rotates: true }));

    const tab = await openTab();
    await tick();

    for (let i = 0; i < 2; i++) {
      await expect(tab.getAuth().currentUser!.getIdToken()).rejects.toMatchObject({
        code: "auth/network-request-failed",
      });
    }
    expect(spent).toEqual(["rt-1", "rt-1"]);
    expect(readStored(w)?.refresh_unconfirmed).toBeUndefined();
    expect(tab.getAuth().currentUser?.uid).toBe(UID);
  });

  it("#279: a 401 is a definite refusal — no mark, and the session ends as before", async () => {
    const spent: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return discoveryResponse();
      if (url === TOKEN_ENDPOINT) {
        spent.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "");
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 });
      }
      return new Response("unexpected", { status: 404 });
    }) as unknown as typeof fetch;

    const w = installOidcEnv(fetchImpl);
    seedTokens(w, staleSet("rt-1", { rotates: true }));

    const tab = await openTab();
    await tick();

    // The IdP looked at rt-1 and refused it. There is no doubt to record: the
    // existing handling signs out, which is still the right answer (#279).
    await expect(tab.getAuth().currentUser!.getIdToken()).rejects.toMatchObject({
      code: "auth/user-token-expired",
    });
    expect(spent).toEqual(["rt-1"]);
    expect(tab.getAuth().currentUser).toBeNull();
    expect(readStored(w)).toBeNull();
  });

  it("#279: a peer that refreshed during the 502 still wins, and takes no mark", async () => {
    const peerIdToken = makeJwt({ sub: UID, email: "stefan@example.test", exp: IN_AN_HOUR() });
    const spent: string[] = [];
    let w!: FakeWindow;

    // The peer rotated to rt-2 and stored a usable set while our grant was in
    // flight; ours came back 502.
    const fetchImpl = failingGrantFetch(502, spent, () => {
      seedTokens(w, {
        id_token: peerIdToken,
        refresh_token: "rt-2",
        expires_at: Date.now() + 3_600_000,
        rotates: true,
      });
    });

    w = installOidcEnv(fetchImpl);
    seedTokens(w, staleSet("rt-1", { rotates: true }));

    const tab = await openTab();
    await tick();

    await expect(tab.getAuth().currentUser!.getIdToken()).resolves.toBe(peerIdToken);
    expect(tab.getAuth().currentUser?.uid).toBe(UID);
    // The peer's set is the truth now, so our doubt about rt-1 must not land on
    // it — markRefreshUnconfirmed only stamps the set still carrying the token
    // it names, and this is that no-op seen from the 5xx door.
    const stored = readStored(w);
    expect(stored).toMatchObject({ refresh_token: "rt-2" });
    expect(stored?.refresh_unconfirmed).toBeUndefined();
    expect(spent).toEqual(["rt-1"]);
  });

  it("#279: a 502 after another tab signed out leaves storage empty", async () => {
    // The other half of markRefreshUnconfirmed's no-op, seen from the 5xx door:
    // a peer signed out while our grant was in flight, so there is no set left
    // to stamp. Writing the mark anyway would resurrect the very tokens the
    // sign-out just removed.
    const spent: string[] = [];
    let w!: FakeWindow;

    const fetchImpl = failingGrantFetch(502, spent, () => {
      w.localStorage.removeItem(TOKENS_KEY);
    });

    w = installOidcEnv(fetchImpl);
    seedTokens(w, staleSet("rt-1", { rotates: true }));

    const tab = await openTab();
    await tick();

    await expect(tab.getAuth().currentUser!.getIdToken()).rejects.toMatchObject({
      code: "auth/network-request-failed",
    });
    expect(spent).toEqual(["rt-1"]);
    expect(readStored(w)).toBeNull();
  });

  it("#279: a refresh that finally succeeds clears the mark a 5xx left", async () => {
    // rt-1 was marked by a 502 and a peer has since rotated us to rt-2. The
    // mark is seeded alongside rt-2 on purpose: a peer writing its own set
    // would have dropped it already, and the assertion here is that OUR
    // successful grant writes a clean set rather than carrying doubt forward.
    const nextIdToken = makeJwt({ sub: UID, email: "stefan@example.test", exp: IN_AN_HOUR() });
    const spent: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return discoveryResponse();
      if (url === TOKEN_ENDPOINT) {
        spent.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "");
        return new Response(
          JSON.stringify({ id_token: nextIdToken, refresh_token: "rt-3", expires_in: 3600 }),
          { status: 200 },
        );
      }
      return new Response("unexpected", { status: 404 });
    }) as unknown as typeof fetch;

    const w = installOidcEnv(fetchImpl);
    seedTokens(w, staleSet("rt-2", { rotates: true, refresh_unconfirmed: "rt-1" }));

    const tab = await openTab();
    await tick();

    await expect(tab.getAuth().currentUser!.getIdToken()).resolves.toBe(nextIdToken);
    expect(spent).toEqual(["rt-2"]);
    const stored = readStored(w);
    expect(stored).toMatchObject({ refresh_token: "rt-3", rotates: true });
    expect(stored?.refresh_unconfirmed).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Built-in-mode session refresh: a 5xx on the JWT mint (#279)         */
/*                                                                     */
/* The narrower sibling of the grant path: refreshViaSession presents  */
/* the Better Auth session token at /__auth/token and takes the same   */
/* "transient, keep the session" branch on a 5xx. What differs is what */
/* is at stake — a session token is not single-use, so a reply that    */
/* died on the way back cannot have spent it (#216). The mark is for   */
/* the single-use credential, and only a set that carries one gets it. */
/* ------------------------------------------------------------------ */

describe("selfhost auth-client — built-in-mode session refresh (#279)", () => {
  const API = "https://app.selfhost.test/api";
  const AUTH_BASE = `${API}/__auth`;
  const TOKENS_KEY = "fibuki.oidc.tokens";

  /** A set whose id_token is inside the staleness window, so getIdToken refreshes. */
  const staleSessionSet = (extra: Record<string, unknown> = {}) => ({
    id_token: makeJwt({ sub: UID, email: "stefan@example.test", exp: Math.floor(Date.now() / 1000) + 5 }),
    session_token: "sess-1",
    expires_at: Date.now() + 5_000,
    ...extra,
  });

  /** Built-in mode (no issuer), one tab, tokens already in storage. */
  async function loadBuiltIn(
    fetchImpl: typeof fetch,
    stored: Record<string, unknown>,
  ): Promise<AuthClient> {
    vi.resetModules();
    fakeWindow = installWindow();
    for (const k of [
      "NEXT_PUBLIC_FIBUKI_DEV_UID",
      "NEXT_PUBLIC_FIBUKI_DEV_ADMIN",
      "NEXT_PUBLIC_OIDC_ISSUER",
      "NEXT_PUBLIC_OIDC_CLIENT_ID",
      "NEXT_PUBLIC_FIBUKI_API_URL",
    ]) {
      delete process.env[k];
    }
    fakeWindow.localStorage.setItem(TOKENS_KEY, JSON.stringify(stored));
    vi.stubGlobal("fetch", fetchImpl);
    const client = (await import("../../../lib/selfhost/auth-client")) as AuthClient;
    // Configure the API base rather than exporting NEXT_PUBLIC_FIBUKI_API_URL:
    // authApiBase() resolves either way, but the env var also starts a change
    // stream that outlives the test and reconnects into later ones (#150).
    client.__configureAuthClient({ apiUrl: API });
    return client;
  }

  function readStored(): Record<string, unknown> | null {
    const raw = fakeWindow.localStorage.getItem(TOKENS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  }

  /** The host's JWT mint, answering every call with `status`, recording presents. */
  function failingMintFetch(status: number, presented: string[]): typeof fetch {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${AUTH_BASE}/token`) {
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        presented.push(auth.replace(/^Bearer /, ""));
        return new Response("bad gateway", { status });
      }
      return new Response("unexpected", { status: 404 });
    }) as unknown as typeof fetch;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("#279: a 502 on the mint keeps the session and never marks the session token", async () => {
    const presented: string[] = [];
    const client = await loadBuiltIn(failingMintFetch(502, presented), staleSessionSet());
    await tick();

    await expect(client.getAuth().currentUser!.getIdToken()).rejects.toMatchObject({
      name: "FirebaseError",
      code: "auth/network-request-failed",
    });
    // fork #77 unchanged: the backend having a moment is not a revoked session.
    expect(client.getAuth().currentUser?.uid).toBe(UID);
    expect(presented).toEqual(["sess-1"]);
    // And nothing is marked: a session token is not single-use, so a lost or
    // 5xx-shaped answer cannot have spent it — re-presenting it costs nothing
    // and refusing to would sign the user out over a proxy hiccup (#216, #279).
    expect(readStored()).toMatchObject({ session_token: "sess-1" });
    expect(readStored()?.refresh_unconfirmed).toBeUndefined();
  });

  it("#279: a 502 on the mint marks a refresh_token the same set carries", async () => {
    // The mark keys on the credential that CAN be spent, not on the mode: if a
    // set reaches this branch carrying a refresh_token, the 5xx leaves that one
    // in the same "presented, outcome unknown" state the grant path records.
    const presented: string[] = [];
    const client = await loadBuiltIn(
      failingMintFetch(503, presented),
      staleSessionSet({ refresh_token: "rt-1", rotates: true }),
    );
    await tick();

    await expect(client.getAuth().currentUser!.getIdToken()).rejects.toMatchObject({
      code: "auth/network-request-failed",
    });
    expect(client.getAuth().currentUser?.uid).toBe(UID);
    expect(readStored()).toMatchObject({ refresh_token: "rt-1", refresh_unconfirmed: "rt-1" });
  });

  it("#279: a 401 from the mint is a revoked session, not a lost answer", async () => {
    const presented: string[] = [];
    const client = await loadBuiltIn(
      failingMintFetch(401, presented),
      staleSessionSet({ refresh_token: "rt-1" }),
    );
    await tick();

    // The host looked at the session and refused it: sign out, as before, and
    // nothing is left in storage to mark.
    await expect(client.getAuth().currentUser!.getIdToken()).rejects.toMatchObject({
      code: "auth/user-token-expired",
    });
    expect(client.getAuth().currentUser).toBeNull();
    expect(readStored()).toBeNull();
  });
});
