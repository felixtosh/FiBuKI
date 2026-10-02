import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import { store, createMockFirestore } from "../test/setup";

vi.mock("firebase-admin/firestore", () => {
  class FakeInstant {
    constructor(private readonly ms: number) {}
    static fromDate(d: Date) {
      return new FakeInstant(d.getTime());
    }
    static fromMillis(ms: number) {
      return new FakeInstant(ms);
    }
    static now() {
      return new FakeInstant(Date.now());
    }
    toDate() {
      return new Date(this.ms);
    }
    toMillis() {
      return this.ms;
    }
    valueOf() {
      return this.ms;
    }
  }
  return {
    getFirestore: () => createMockFirestore(),
    FieldValue: { serverTimestamp: () => new Date(), increment: (n: number) => n },
    Timestamp: FakeInstant,
  };
});

const store_ = await import("./oauthStore");
const { validateApiKey } = await import("../api-keys");
const db = createMockFirestore() as never;

const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const USER = "user-oauth";
const verifier = "v".repeat(50);
const challenge = createHash("sha256").update(verifier).digest("base64url");

async function client(redirectUris = [REDIRECT], clientName = "ChatGPT") {
  return store_.registerClient(db, { clientName, redirectUris });
}

function request(clientId: string, extra: Record<string, unknown> = {}) {
  return {
    clientId,
    redirectUri: REDIRECT,
    responseType: "code",
    scope: "fibuki",
    state: "xyz",
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    resource: "https://fibuki.com/api/mcp/sse",
    ...extra,
  };
}

async function authorize(clientId: string) {
  const valid = await store_.validateAuthorizeRequest(db, request(clientId));
  return store_.createAuthorizationCode(db, USER, valid);
}

const exchange = (clientId: string, code: string, extra: Record<string, unknown> = {}) =>
  store_.exchangeAuthorizationCode(db, { code, clientId, redirectUri: REDIRECT, codeVerifier: verifier, ...extra });

beforeEach(() => store.clear());

describe("validateAuthorizeRequest", () => {
  it("accepts a well-formed request and says which app is asking", async () => {
    const c = await client();
    const valid = await store_.validateAuthorizeRequest(db, request(c.id));
    expect(valid).toMatchObject({ scope: "fibuki", state: "xyz", app: { origin: "chatgpt", verified: true, host: "chatgpt.com" } });
  });

  it("errors about the client or redirect URI are never redirectable", async () => {
    const c = await client();
    for (const bad of [
      request("oc_unknown"),
      request(c.id, { redirectUri: "https://evil.example/cb" }),
      request(c.id, { redirectUri: undefined }),
      request("", {}),
    ]) {
      const err = await store_.validateAuthorizeRequest(db, bad).catch((e) => e);
      expect(err.redirectable).toBe(false);
    }
  });

  it("every other error is redirectable, and PKCE is mandatory", async () => {
    const c = await client();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ responseType: "token" }, "unsupported_response_type"],
      [{ codeChallenge: undefined }, "invalid_request"],
      [{ codeChallengeMethod: "plain" }, "invalid_request"],
      [{ scope: "fibuki admin" }, "invalid_scope"],
      [{ resource: "https://elsewhere.example/mcp" }, "invalid_target"],
    ];
    for (const [extra, code] of cases) {
      const err = await store_.validateAuthorizeRequest(db, request(c.id, extra)).catch((e) => e);
      expect(err).toMatchObject({ code, redirectable: true });
    }
  });

  it("a request without a resource parameter is fine", async () => {
    const c = await client();
    await expect(store_.validateAuthorizeRequest(db, request(c.id, { resource: undefined }))).resolves.toBeTruthy();
  });
});

describe("buildClientRedirect", () => {
  it("carries code, state and the issuer (RFC 9207), or an error", () => {
    const ok = new URL(store_.buildClientRedirect(`${REDIRECT}?x=1`, { code: "abc" }, "s1"));
    expect(Object.fromEntries(ok.searchParams)).toMatchObject({ x: "1", code: "abc", state: "s1", iss: "https://fibuki.com" });

    const no = new URL(store_.buildClientRedirect(REDIRECT, { error: "access_denied" }));
    expect(no.searchParams.get("error")).toBe("access_denied");
    expect(no.searchParams.has("state")).toBe(false);
    expect(no.searchParams.get("iss")).toBe("https://fibuki.com");
  });
});

describe("authorization code exchange", () => {
  it("issues tokens for a valid code, and the access token works as an API key", async () => {
    const c = await client();
    const tokens = await exchange(c.id, await authorize(c.id));

    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "fibuki" });
    expect(tokens.access_token).toMatch(/^fk_/);
    expect(tokens.refresh_token).toBeTruthy();

    const validated = await validateApiKey(tokens.access_token);
    expect(validated).toMatchObject({ userId: USER, scopes: ["all"] });
  });

  it("the grant appears in the user's key list under the app's name", async () => {
    const c = await client([REDIRECT], "ChatGPT");
    await exchange(c.id, await authorize(c.id));
    const keys = [...store.getCollection("apiKeys").values()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ userId: USER, name: "ChatGPT (connected app)", revokedAt: null, oauthClientId: c.id });
  });

  it("stores only hashes: the code, the access token and the refresh token never rest in the database", async () => {
    const c = await client();
    const code = await authorize(c.id);
    const tokens = await exchange(c.id, code);
    const dump = JSON.stringify([...store.getCollection("oauthCodes").entries(), ...store.getCollection("apiKeys").entries()]);
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(tokens.access_token);
    expect(dump).not.toContain(tokens.refresh_token);
  });

  it("a wrong verifier is refused, and burns the code", async () => {
    const c = await client();
    const code = await authorize(c.id);
    await expect(exchange(c.id, code, { codeVerifier: "w".repeat(50) })).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(exchange(c.id, code)).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("refuses a different redirect URI, a different client, an unknown code and an expired code", async () => {
    const c = await client();
    const other = await client();
    await expect(exchange(c.id, await authorize(c.id), { redirectUri: "https://chatgpt.com/other" })).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(exchange(other.id, await authorize(c.id))).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(exchange(c.id, "no-such-code")).rejects.toMatchObject({ code: "invalid_grant" });

    const code = await authorize(c.id);
    const hash = createHash("sha256").update(code).digest("hex");
    const row = store.getDoc("oauthCodes", hash)!;
    store.setDoc("oauthCodes", hash, { ...row, expiresAt: { toMillis: () => Date.now() - 1000 } });
    await expect(exchange(c.id, code)).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("a code used twice revokes what the first use handed out", async () => {
    const c = await client();
    const code = await authorize(c.id);
    const tokens = await exchange(c.id, code);
    await expect(validateApiKey(tokens.access_token)).resolves.toBeTruthy();

    await expect(exchange(c.id, code)).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(validateApiKey(tokens.access_token)).resolves.toBeNull();
  });

  it("a resource that is not ours is refused", async () => {
    const c = await client();
    await expect(exchange(c.id, await authorize(c.id), { resource: "https://elsewhere.example" })).rejects.toMatchObject({ code: "invalid_target" });
  });

  it("asks for the right parameters", async () => {
    await expect(store_.exchangeAuthorizationCode(db, {})).rejects.toMatchObject({ code: "invalid_request" });
    await expect(store_.exchangeAuthorizationCode(db, { code: "x", clientId: "oc_nope" })).rejects.toMatchObject({ code: "invalid_client" });
  });
});

describe("refresh", () => {
  it("rotates: a new pair, the old refresh token spent, the old access token replaced", async () => {
    const c = await client();
    const first = await exchange(c.id, await authorize(c.id));
    const second = await store_.refreshGrant(db, { refreshToken: first.refresh_token, clientId: c.id });

    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    await expect(validateApiKey(second.access_token)).resolves.toMatchObject({ userId: USER });
    await expect(validateApiKey(first.access_token)).resolves.toBeNull();
    expect([...store.getCollection("apiKeys").values()]).toHaveLength(1); // one grant, rotated in place
  });

  it("a spent refresh token revokes the whole grant (it was copied)", async () => {
    const c = await client();
    const first = await exchange(c.id, await authorize(c.id));
    const second = await store_.refreshGrant(db, { refreshToken: first.refresh_token, clientId: c.id });

    await expect(store_.refreshGrant(db, { refreshToken: first.refresh_token, clientId: c.id })).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(validateApiKey(second.access_token)).resolves.toBeNull();
    await expect(store_.refreshGrant(db, { refreshToken: second.refresh_token, clientId: c.id })).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("refuses another client's use, an expired refresh token, a revoked grant and garbage", async () => {
    const c = await client();
    const other = await client();
    const tokens = await exchange(c.id, await authorize(c.id));

    await expect(store_.refreshGrant(db, { refreshToken: tokens.refresh_token, clientId: other.id })).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(store_.refreshGrant(db, { refreshToken: "garbage", clientId: c.id })).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(store_.refreshGrant(db, {})).rejects.toMatchObject({ code: "invalid_request" });

    const [id, key] = [...store.getCollection("apiKeys").entries()][0];
    store.setDoc("apiKeys", id, { ...key, oauthRefreshExpiresAt: { toMillis: () => Date.now() - 1 } });
    await expect(store_.refreshGrant(db, { refreshToken: tokens.refresh_token, clientId: c.id })).rejects.toMatchObject({ code: "invalid_grant" });

    store.setDoc("apiKeys", id, { ...key, revokedAt: { toMillis: () => Date.now() } });
    await expect(store_.refreshGrant(db, { refreshToken: tokens.refresh_token, clientId: c.id })).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("revoking the key in Settings ends the grant", async () => {
    const c = await client();
    const tokens = await exchange(c.id, await authorize(c.id));
    const [id, key] = [...store.getCollection("apiKeys").entries()][0];
    store.setDoc("apiKeys", id, { ...key, revokedAt: { toMillis: () => Date.now() } });

    await expect(validateApiKey(tokens.access_token)).resolves.toBeNull();
    await expect(store_.refreshGrant(db, { refreshToken: tokens.refresh_token, clientId: c.id })).rejects.toMatchObject({ code: "invalid_grant" });
  });
});
