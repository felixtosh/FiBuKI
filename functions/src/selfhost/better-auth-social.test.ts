/**
 * Google / social sign-in acceptance for the selfhost build — the one auth
 * path with zero coverage before this suite, and the migration path for the
 * existing Google user. It is the regression net for a better-auth version
 * bump: it drives the REAL `google` provider (id_token signature verified
 * against a stubbed Google JWKS) and the REAL create path
 * (handleOAuthUserInfo -> createOAuthUser -> the `user.create.before`
 * database hook -> assertInvited), all through the public `handler` seam.
 *
 * Determinism: the only network call the flow makes is Google's certs URL
 * (https://www.googleapis.com/oauth2/v3/certs); we stub globalThis.fetch to
 * serve a locally-generated RS256 public key and sign our own id_token with
 * its private half (the same jose trick oidc-verifier.test.ts uses). No
 * state cookie, no token-endpoint round-trip — the id_token branch of
 * /sign-in/social reaches the create hook directly.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { getFirestore, __rawSqlForTest } from "./firestore-shim";
import { getTenantId } from "./db/tenant";
import { createSelfhostAuth } from "./better-auth";

const ISSUER = "http://fibuki-selfhost.internal"; // createSelfhostAuth's default — keep stable
const GOOGLE_CLIENT_ID = "test-google-client.apps.googleusercontent.com";
const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const KID = "test-google-key-1";

let seq = 0;
const uniqueEmail = (tag: string) => `gsi-${tag}-${++seq}-${Date.now()}@example.test`;

let privateKey: CryptoKey;
let publicJwk: JWK;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  privateKey = kp.privateKey;
  publicJwk = { ...(await exportJWK(kp.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  process.env.GOOGLE_CLIENT_ID = GOOGLE_CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
});

afterAll(() => {
  // Don't leak the social config into other selfhost suites sharing the worker.
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});

afterEach(() => vi.unstubAllGlobals());

/** Serve ONLY Google's JWKS; the id_token branch fetches nothing else. */
function stubGoogleJwks(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === GOOGLE_CERTS_URL) {
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

async function mintGoogleIdToken(email: string, sub = `google-sub-${++seq}`): Promise<string> {
  // Fresh iat/exp every call so the provider's 1h maxTokenAge never lapses.
  return new SignJWT({
    email,
    email_verified: true,
    name: "Google Test User",
    picture: "https://example.test/avatar.png",
  })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer("https://accounts.google.com")
    .setAudience(GOOGLE_CLIENT_ID)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

function socialSignIn(body: Record<string, unknown>): Request {
  // No cookie/origin header -> better-auth's origin check early-returns.
  return new Request(`${ISSUER}/__auth/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "google", ...body }),
  });
}

async function countUsers(email: string): Promise<number> {
  const { rows } = await __rawSqlForTest(
    `SELECT count(*)::int AS n FROM auth_users WHERE lower(email) = $1`,
    [email.toLowerCase()],
    getTenantId(),
  );
  return Number(rows[0]?.n ?? 0);
}

async function allowEmail(email: string): Promise<void> {
  await getFirestore().collection("allowedEmails").add({ email, createdAt: new Date() });
}

describe("Google social sign-in — provider wiring + invite gate on the auto-create path", () => {
  it("registers google with the right client_id and redirect_uri when env is set", async () => {
    const auth = await createSelfhostAuth();
    const res = await auth.handler(socialSignIn({ disableRedirect: true }));
    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as { url: string }).url);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(GOOGLE_CLIENT_ID);
    // The redirect_uri doubles as the OAuth callback base — server.ts warns
    // when the issuer isn't set precisely because a wrong value dies at the
    // consent screen. Pin it.
    expect(url.searchParams.get("redirect_uri")).toBe(`${ISSUER}/__auth/callback/google`);
  });

  it("does not register google when the env is absent", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    try {
      const auth = await createSelfhostAuth();
      const res = await auth.handler(socialSignIn({ disableRedirect: true }));
      expect(res.status).toBe(404); // PROVIDER_NOT_FOUND
    } finally {
      process.env.GOOGLE_CLIENT_ID = GOOGLE_CLIENT_ID;
      process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
    }
  });

  it("rejects a non-invited Google sign-in — the create hook gates auto-signup", async () => {
    // Google auto-creates a user on first login; the invite gate lives in the
    // `user.create.before` DB hook precisely so this social path can't bypass
    // invite-only. A stranger must be refused BEFORE any row is written.
    stubGoogleJwks();
    const auth = await createSelfhostAuth();
    const email = uniqueEmail("stranger");
    const res = await auth.handler(socialSignIn({ idToken: { token: await mintGoogleIdToken(email) } }));
    expect(res.status).toBe(401); // OAUTH_LINK_ERROR — hook threw
    expect(await countUsers(email)).toBe(0);
  });

  it("auto-creates an invited Google user and issues a JWKS-verifiable JWT", async () => {
    stubGoogleJwks();
    const auth = await createSelfhostAuth();
    const email = uniqueEmail("invited");
    await allowEmail(email);

    const res = await auth.handler(socialSignIn({ idToken: { token: await mintGoogleIdToken(email) } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { redirect?: boolean; token?: string };
    expect(body.redirect).toBe(false);
    expect(typeof body.token).toBe("string");
    expect(await countUsers(email)).toBe(1);

    // The social response carries a SESSION token; exchange it for the
    // JWKS-verifiable JWT via the bearer-accepting /token route (same
    // machinery signInEmail uses), then run it through the real verifier.
    const tokenRes = await auth.handler(
      new Request(`${ISSUER}/__auth/token`, {
        method: "GET",
        headers: { authorization: `Bearer ${body.token}` },
      }),
    );
    expect(tokenRes.status).toBe(200);
    const { token } = (await tokenRes.json()) as { token: string };
    const authData = await auth.verifier(token);
    expect(authData?.uid).toBeTruthy();
    expect(authData?.token?.email).toBe(email.toLowerCase());
  });
});
