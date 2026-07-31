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
});
