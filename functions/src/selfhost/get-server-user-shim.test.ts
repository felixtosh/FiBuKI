/**
 * The self-host server-auth shim, driven with REAL EdDSA tokens.
 *
 * This is the fix for "every app/api route answers 401 on self-host": the upstream
 * helper verifies Firebase RS256 tokens, while Better Auth signs EdDSA. The claim
 * worth pinning is not "it parses a JWT" but "a token this stack actually issues is
 * accepted, and one it did not issue is refused" — so the tests mint against a real
 * generated Ed25519 key and serve a real JWKS document.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";

import {
  getServerUserIdWithFallback,
  isServerUserAdmin,
  unauthorizedResponse,
  UnauthorizedError,
  __resetJwksCache,
} from "../../../lib/selfhost/get-server-user-shim";

let server: http.Server;
let base: string;
let signKey: CryptoKey;
let otherKey: CryptoKey;

/** A request carrying a bearer token, which is all the shim reads. */
function req(token?: string): Request {
  return new Request("https://web.test/api/whatever", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

async function mint(
  key: CryptoKey,
  claims: Record<string, unknown>,
  opts: { issuer?: string; audience?: string; expired?: boolean } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer(opts.issuer ?? base)
    .setAudience(opts.audience ?? base)
    .setIssuedAt(opts.expired ? now - 7200 : now)
    .setExpirationTime(opts.expired ? now - 3600 : now + 3600)
    .sign(key);
}

beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const other = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  signKey = pair.privateKey;
  otherKey = other.privateKey;

  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), alg: "EdDSA", kid: "test-key" };

  const app = express();
  // Same path the host serves: Better Auth's jwt plugin under /__auth.
  app.get("/__auth/jwks", (_req, res) => res.json({ keys: [jwk] }));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.NEXT_PUBLIC_FIBUKI_API_URL = base;
});

afterAll(async () => {
  delete process.env.NEXT_PUBLIC_FIBUKI_API_URL;
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

beforeEach(() => __resetJwksCache());

describe("selfhost get-server-user shim", () => {
  it("accepts a real EdDSA token and returns the uid — the case firebase-admin rejected", async () => {
    const token = await mint(signKey, { sub: "user-1", sid: "sess-1" });
    await expect(getServerUserIdWithFallback(req(token))).resolves.toBe("user-1");
  });

  it("throws UnauthorizedError with no Authorization header", async () => {
    await expect(getServerUserIdWithFallback(req())).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("refuses a token signed by a key that is not in the JWKS", async () => {
    // The forgery case: right shape, right claims, wrong signer.
    const forged = await mint(otherKey, { sub: "attacker", sid: "s" });
    await expect(getServerUserIdWithFallback(req(forged))).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("refuses an expired token", async () => {
    const stale = await mint(signKey, { sub: "user-1", sid: "s" }, { expired: true });
    await expect(getServerUserIdWithFallback(req(stale))).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("refuses a token minted for a different issuer", async () => {
    // Guards against a token from another deployment being replayed here.
    const foreign = await mint(signKey, { sub: "user-1", sid: "s" }, {
      issuer: "https://someone-else.example",
    });
    await expect(getServerUserIdWithFallback(req(foreign))).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("refuses a token whose audience is not this API", async () => {
    const foreign = await mint(signKey, { sub: "user-1", sid: "s" }, {
      audience: "https://someone-else.example",
    });
    await expect(getServerUserIdWithFallback(req(foreign))).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("reads admin from the VERIFIED claim, and only when true", async () => {
    const admin = await mint(signKey, { sub: "u", sid: "s", admin: true });
    const plain = await mint(signKey, { sub: "u", sid: "s" });
    const spoofish = await mint(signKey, { sub: "u", sid: "s", admin: "true" });

    await expect(isServerUserAdmin(req(admin))).resolves.toBe(true);
    await expect(isServerUserAdmin(req(plain))).resolves.toBe(false);
    // A string "true" must not read as admin — strict equality, not truthiness.
    await expect(isServerUserAdmin(req(spoofish))).resolves.toBe(false);
  });

  it("is not admin without a valid token at all", async () => {
    await expect(isServerUserAdmin(req())).resolves.toBe(false);
    await expect(isServerUserAdmin(req("not-a-jwt"))).resolves.toBe(false);
  });

  it("unauthorizedResponse answers 401 for UnauthorizedError and passes others through", async () => {
    const res = unauthorizedResponse(new UnauthorizedError());
    expect(res?.status).toBe(401);
    // Must not leak internal error text — routes pass arbitrary errors in.
    await expect(res?.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(unauthorizedResponse(new Error("database exploded"))).toBeNull();
  });

  it("fails closed when the API base is unconfigured", async () => {
    const saved = process.env.NEXT_PUBLIC_FIBUKI_API_URL;
    delete process.env.NEXT_PUBLIC_FIBUKI_API_URL;
    __resetJwksCache();
    const token = await mint(signKey, { sub: "u", sid: "s" });
    // No JWKS to check against must mean "unauthenticated", never "allowed".
    await expect(getServerUserIdWithFallback(req(token))).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    process.env.NEXT_PUBLIC_FIBUKI_API_URL = saved;
  });

  it("fetches the JWKS from NEXT_PUBLIC_FUNCTIONS_URL when set, keeping the public base as issuer", async () => {
    // The deployed shape: the public hostname is unreachable from inside the
    // compose network, the api's service URL is not. Tokens still carry the
    // public issuer/audience, so those must not follow the fetch base.
    const saved = process.env.NEXT_PUBLIC_FIBUKI_API_URL;
    process.env.NEXT_PUBLIC_FIBUKI_API_URL = "https://api.public.example";
    process.env.NEXT_PUBLIC_FUNCTIONS_URL = base;
    __resetJwksCache();
    try {
      const token = await mint(signKey, { sub: "user-1", sid: "s" }, {
        issuer: "https://api.public.example",
        audience: "https://api.public.example",
      });
      await expect(getServerUserIdWithFallback(req(token))).resolves.toBe("user-1");
      // A token minted for the internal base is NOT valid — issuer stays public.
      const internal = await mint(signKey, { sub: "user-1", sid: "s" });
      await expect(getServerUserIdWithFallback(req(internal))).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
    } finally {
      delete process.env.NEXT_PUBLIC_FUNCTIONS_URL;
      process.env.NEXT_PUBLIC_FIBUKI_API_URL = saved;
      __resetJwksCache();
    }
  });
});

/**
 * External-IdP mode. The api selects it from OIDC_ISSUER (server.ts); this shim
 * must follow, or the browser holds an IdP token the api accepts and every
 * app/api route refuses it — which is what a deployment on Authentik saw:
 * "Token verification failed: request timed out" against a /__auth/jwks path
 * that only exists in built-in mode.
 */
describe("selfhost get-server-user shim — OIDC mode", () => {
  let idp: http.Server;
  let idpBase: string;
  let idpJwk: JWK;
  let idpKey: CryptoKey;
  const ISSUER = "https://auth.public.example/application/o/fibuki/";
  const CLIENT_ID = "fibuki-web";

  beforeAll(async () => {
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    idpKey = pair.privateKey;
    idpJwk = { ...(await exportJWK(pair.publicKey)), alg: "EdDSA", kid: "idp-key" };
    const app = express();
    // Authentik's shapes: discovery under the issuer, JWKS wherever it says.
    app.get("/application/o/fibuki/.well-known/openid-configuration", (_req, res) =>
      res.json({ issuer: ISSUER, jwks_uri: `${idpBase}/application/o/fibuki/jwks/` }),
    );
    app.get("/application/o/fibuki/jwks/", (_req, res) => res.json({ keys: [idpJwk] }));
    idp = http.createServer(app);
    await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
    idpBase = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((res, rej) => idp.close((e) => (e ? rej(e) : res())));
  });

  const OIDC_VARS = ["OIDC_ISSUER", "OIDC_JWKS_URI", "OIDC_AUDIENCE", "OIDC_ADMIN_GROUP", "OIDC_GROUPS_CLAIM"];
  beforeEach(() => {
    for (const v of OIDC_VARS) delete process.env[v];
    __resetJwksCache();
  });
  afterAll(() => {
    for (const v of OIDC_VARS) delete process.env[v];
    __resetJwksCache();
  });

  async function mintIdp(claims: Record<string, unknown>, opts: { issuer?: string; audience?: string } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "EdDSA", kid: "idp-key" })
      .setIssuer(opts.issuer ?? ISSUER)
      .setAudience(opts.audience ?? CLIENT_ID)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(idpKey);
  }

  it("accepts an IdP token via OIDC_JWKS_URI while the public issuer stays unreachable", async () => {
    // Exactly the CT-999 layout: public issuer hostname does not resolve from
    // here; the JWKS is reachable on the internal network.
    process.env.OIDC_ISSUER = ISSUER;
    process.env.OIDC_JWKS_URI = `${idpBase}/application/o/fibuki/jwks/`;
    process.env.OIDC_AUDIENCE = CLIENT_ID;
    const token = await mintIdp({ sub: "5d5b-authentik-sub" });
    await expect(getServerUserIdWithFallback(req(token))).resolves.toBe("5d5b-authentik-sub");
  });

  it("discovers the JWKS from the issuer when OIDC_JWKS_URI is blank", async () => {
    // Discovery has to happen against a reachable issuer; use the test IdP's.
    process.env.OIDC_ISSUER = `${idpBase}/application/o/fibuki/`;
    const token = await mintIdp({ sub: "u" }, { issuer: `${idpBase}/application/o/fibuki/` });
    await expect(getServerUserIdWithFallback(req(token))).resolves.toBe("u");
  });

  it("does not consult the built-in /__auth/jwks path in OIDC mode", async () => {
    // A Better-Auth-shaped token (signed by the api's key, api-base issuer) is
    // NOT valid once the deployment runs on an external IdP.
    process.env.OIDC_ISSUER = ISSUER;
    process.env.OIDC_JWKS_URI = `${idpBase}/application/o/fibuki/jwks/`;
    const builtin = await mint(signKey, { sub: "u", sid: "s" });
    await expect(getServerUserIdWithFallback(req(builtin))).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("enforces OIDC_AUDIENCE when set and skips the check when blank", async () => {
    process.env.OIDC_ISSUER = ISSUER;
    process.env.OIDC_JWKS_URI = `${idpBase}/application/o/fibuki/jwks/`;
    process.env.OIDC_AUDIENCE = CLIENT_ID;
    const other = await mintIdp({ sub: "u" }, { audience: "some-other-client" });
    await expect(getServerUserIdWithFallback(req(other))).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    delete process.env.OIDC_AUDIENCE;
    __resetJwksCache();
    await expect(getServerUserIdWithFallback(req(other))).resolves.toBe("u");
  });

  it("derives admin from group membership, ignoring a user-set admin claim", async () => {
    process.env.OIDC_ISSUER = ISSUER;
    process.env.OIDC_JWKS_URI = `${idpBase}/application/o/fibuki/jwks/`;
    process.env.OIDC_ADMIN_GROUP = "fibuki-admins";
    const member = await mintIdp({ sub: "u", groups: ["staff", "fibuki-admins"] });
    const outsider = await mintIdp({ sub: "u", groups: ["staff"] });
    const spoof = await mintIdp({ sub: "u", groups: ["staff"], admin: true });
    await expect(isServerUserAdmin(req(member))).resolves.toBe(true);
    await expect(isServerUserAdmin(req(outsider))).resolves.toBe(false);
    await expect(isServerUserAdmin(req(spoof))).resolves.toBe(false);
  });

  it("is never admin when OIDC_ADMIN_GROUP is unset", async () => {
    process.env.OIDC_ISSUER = ISSUER;
    process.env.OIDC_JWKS_URI = `${idpBase}/application/o/fibuki/jwks/`;
    const member = await mintIdp({ sub: "u", groups: ["fibuki-admins"] });
    await expect(isServerUserAdmin(req(member))).resolves.toBe(false);
  });
});
