/**
 * The outgoing half of the self-host Google social flow
 * (lib/selfhost/auth-client.ts `signInWithPopup`): it must ask the host for
 * BOTH a success `callbackURL` and an `errorCallbackURL`, so a rejected
 * sign-in (the invite gate blocking a stranger) bounces back with the marker
 * the login / register page turns into an "access request submitted" banner.
 *
 * Standalone minimal window (the fuller harness lives in auth-client.test.ts);
 * this only needs location.href + a stubbed fetch to inspect the request body.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

type AuthClient = typeof import("../../../lib/selfhost/auth-client");

function fakeStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
}

function installWindow(href: string): void {
  const u = new URL(href);
  (globalThis as Record<string, unknown>).window = {
    localStorage: fakeStore(),
    sessionStorage: fakeStore(),
    location: { origin: u.origin, pathname: u.pathname, search: u.search, href, assign: () => undefined },
    history: { replaceState: () => undefined },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

async function loadClient(): Promise<AuthClient> {
  vi.resetModules();
  for (const k of ["NEXT_PUBLIC_FIBUKI_DEV_UID", "NEXT_PUBLIC_OIDC_ISSUER", "NEXT_PUBLIC_OIDC_CLIENT_ID"]) {
    delete process.env[k];
  }
  return import("../../../lib/selfhost/auth-client");
}

describe("selfhost auth-client — Google social sign-in request", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>).window;
  });

  it("requests both callbackURL and errorCallbackURL from the host", async () => {
    installWindow("https://app.selfhost.test/login");
    const client = await loadClient();
    client.__configureAuthClient({ apiUrl: "https://app.selfhost.test/api" });

    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify({ url: "https://accounts.google.com/o/oauth2/v2/auth" }), {
          status: 200,
        });
      }),
    );

    // Built-in mode navigates on success and never resolves — don't await;
    // the request has already gone out by the next microtask.
    void client.signInWithPopup(client.getAuth(), new client.GoogleAuthProvider());
    await new Promise((r) => setTimeout(r, 0));

    expect(body.provider).toBe("google");
    expect(String(body.callbackURL)).toContain("fibuki_social=1");
    expect(String(body.errorCallbackURL)).toContain("fibuki_social_error");
  });
});
