/**
 * Authentik (OIDC) token verifier for the fibuki-api host.
 *
 * Production auth: the browser gets an id_token from Authentik (SPA code+PKCE,
 * see lib/selfhost/auth-client.ts) and sends it as `Authorization: Bearer`.
 * This verifier validates that token's signature against Authentik's JWKS,
 * checks issuer/audience/expiry, maps `sub` -> uid, and derives `admin` from
 * membership of a configured Authentik group. It plugs into the host as its
 * `TokenVerifier` (host.ts), replacing the FIBUKI_DEV_UID bypass in production.
 *
 * A verification failure (bad signature, wrong issuer, expired, no sub) returns
 * null — the host answers 401, same contract as the fake verifier in tests.
 */

import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from "jose";
import type { TokenVerifier } from "./host";
import type { AuthData } from "./https-shim";

/** A resolved verification key or JWKS resolver, as jose's jwtVerify accepts. */
type KeyInput = Parameters<typeof jwtVerify>[1];

export interface OidcVerifierConfig {
  /** OIDC issuer URL (Authentik provider issuer), e.g. https://auth.../application/o/fibuki/ */
  issuer: string;
  /** Explicit JWKS URI. If omitted, discovered from the issuer's OIDC config. */
  jwksUri?: string;
  /** Expected audience (the OIDC client id). Omit to skip the aud check. */
  audience?: string;
  /** Authentik group whose members get token.admin === true. Omit → never admin. */
  adminGroup?: string;
  /** Claim holding the user's group list (Authentik default: "groups"). */
  groupsClaim?: string;
  /**
   * Pre-resolved key / JWKS resolver. When set, discovery + JWKS fetch are
   * skipped (used by tests, or to pin a key). Normally left unset.
   */
  jwks?: KeyInput;
  /** Injectable fetch (tests). Defaults to the global fetch (Node 20+). */
  fetchImpl?: typeof fetch;
}

async function discoverJwksUri(issuer: string, fetchImpl: typeof fetch): Promise<string> {
  const base = issuer.endsWith("/") ? issuer : `${issuer}/`;
  const url = new URL(".well-known/openid-configuration", base).toString();
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status}) at ${url}`);
  const doc = (await res.json()) as { jwks_uri?: string };
  if (!doc.jwks_uri) throw new Error(`OIDC discovery at ${url} exposed no jwks_uri`);
  return doc.jwks_uri;
}

function deriveAdmin(payload: JWTPayload, groupsClaim: string, adminGroup?: string): boolean {
  if (!adminGroup) return false;
  const groups = payload[groupsClaim];
  if (Array.isArray(groups)) return groups.includes(adminGroup);
  if (typeof groups === "string") return groups === adminGroup;
  return false;
}

export function createOidcVerifier(cfg: OidcVerifierConfig): TokenVerifier {
  const groupsClaim = cfg.groupsClaim ?? "groups";
  const fetchImpl = cfg.fetchImpl ?? fetch;

  // Resolve the key once (JWKS fetch is cached inside createRemoteJWKSet).
  let keyPromise: Promise<KeyInput> | null = null;
  const getKey = (): Promise<KeyInput> => {
    if (!keyPromise) {
      keyPromise = (async () => {
        if (cfg.jwks) return cfg.jwks;
        const uri = cfg.jwksUri ?? (await discoverJwksUri(cfg.issuer, fetchImpl));
        // Route the JWKS fetch through the same fetch impl (tests inject one;
        // production uses the global fetch), so discovery and key retrieval agree.
        return createRemoteJWKSet(new URL(uri), { [customFetch]: fetchImpl });
      })();
    }
    return keyPromise;
  };

  return async (token: string): Promise<AuthData | null> => {
    try {
      const key = await getKey();
      const { payload } = await jwtVerify(token, key, {
        issuer: cfg.issuer,
        ...(cfg.audience ? { audience: cfg.audience } : {}),
      });
      const uid = typeof payload.sub === "string" ? payload.sub : undefined;
      if (!uid) return null;
      const admin = deriveAdmin(payload, groupsClaim, cfg.adminGroup);
      return { uid, token: { ...payload, admin } };
    } catch {
      // Any verification failure → unauthenticated (host answers 401).
      return null;
    }
  };
}
