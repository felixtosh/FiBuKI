/**
 * Unit coverage for the Authentik OIDC verifier. Mints tokens with a locally
 * generated RSA keypair (no network) and drives createOidcVerifier via its
 * `jwks` injection seam, so the JWKS fetch/discovery is bypassed. Discovery
 * itself is covered separately with an injected fetch.
 */

import { SignJWT, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createOidcVerifier } from "./oidc-verifier";

const ISSUER = "https://auth.example.test/application/o/fibuki/";
const AUDIENCE = "fibuki-web";
const ADMIN_GROUP = "fibuki-admins";

let privateKey: CryptoKey;
let publicJwk: JWK;

async function mint(claims: Record<string, unknown>, opts?: { issuer?: string; audience?: string; expiresIn?: string }) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(opts?.issuer ?? ISSUER)
    .setAudience(opts?.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts?.expiresIn ?? "5m")
    .sign(privateKey);
}

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  privateKey = kp.privateKey;
  publicJwk = await exportJWK(kp.publicKey);
  publicJwk.alg = "RS256";
});

/** A verifier wired to verify against our local public key. */
async function verifierFor(overrides?: Partial<Parameters<typeof createOidcVerifier>[0]>) {
  const key = await importJWK(publicJwk, "RS256");
  return createOidcVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    adminGroup: ADMIN_GROUP,
    jwks: key,
    ...overrides,
  });
}

describe("createOidcVerifier", () => {
  it("accepts a valid token and maps sub -> uid", async () => {
    const verify = await verifierFor();
    const token = await mint({ sub: "user-123", email: "a@b.test" });
    const auth = await verify(token);
    expect(auth?.uid).toBe("user-123");
    expect(auth?.token?.email).toBe("a@b.test");
    expect(auth?.token?.admin).toBe(false);
  });

  it("sets token.admin when the user is in the admin group", async () => {
    const verify = await verifierFor();
    const token = await mint({ sub: "u1", groups: ["users", ADMIN_GROUP] });
    const auth = await verify(token);
    expect(auth?.token?.admin).toBe(true);
  });

  it("does NOT set admin for a non-member", async () => {
    const verify = await verifierFor();
    const token = await mint({ sub: "u1", groups: ["users"] });
    expect((await verify(token))?.token?.admin).toBe(false);
  });

  it("supports a string (single) groups claim", async () => {
    const verify = await verifierFor();
    expect((await verify(await mint({ sub: "u1", groups: ADMIN_GROUP })))?.token?.admin).toBe(true);
  });

  it("honours a custom groupsClaim", async () => {
    const verify = await verifierFor({ groupsClaim: "roles" });
    const token = await mint({ sub: "u1", roles: [ADMIN_GROUP] });
    expect((await verify(token))?.token?.admin).toBe(true);
  });

  it("rejects a token with the wrong issuer", async () => {
    const verify = await verifierFor();
    const token = await mint({ sub: "u1" }, { issuer: "https://evil.test/" });
    expect(await verify(token)).toBeNull();
  });

  it("rejects a token with the wrong audience", async () => {
    const verify = await verifierFor();
    const token = await mint({ sub: "u1" }, { audience: "some-other-client" });
    expect(await verify(token)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const verify = await verifierFor();
    const token = await new SignJWT({ sub: "u1" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(0)
      .setExpirationTime(1) // 1970
      .sign(privateKey);
    expect(await verify(token)).toBeNull();
  });

  it("rejects a token signed by a different key (bad signature)", async () => {
    const verify = await verifierFor();
    const other = await generateKeyPair("RS256");
    const forged = await new SignJWT({ sub: "u1" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(other.privateKey);
    expect(await verify(forged)).toBeNull();
  });

  it("rejects a token missing sub", async () => {
    const verify = await verifierFor();
    const token = await new SignJWT({ email: "a@b.test" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    expect(await verify(token)).toBeNull();
  });

  it("skips the audience check when no audience is configured", async () => {
    const verify = await verifierFor({ audience: undefined });
    const token = await mint({ sub: "u1" }, { audience: "anything" });
    expect((await verify(token))?.uid).toBe("u1");
  });

  it("discovers jwks_uri from the issuer when no key is injected", async () => {
    // Injected fetch serves the OIDC discovery doc and the JWKS.
    const jwksUri = `${ISSUER}jwks/`;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return new Response(JSON.stringify({ jwks_uri: jwksUri }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === jwksUri) {
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const verify = createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE, adminGroup: ADMIN_GROUP, fetchImpl });
    const token = await mint({ sub: "user-9", groups: [ADMIN_GROUP] });
    const auth = await verify(token);
    expect(auth?.uid).toBe("user-9");
    expect(auth?.token?.admin).toBe(true);
  });
});
