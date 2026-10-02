import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import {
  appIdentityFor,
  authorizationServerMetadata,
  bearerChallenge,
  generateAccessToken,
  isAcceptableRedirectUri,
  normalizeScope,
  OAuthRequestError,
  parseClientRegistration,
  protectedResourceMetadata,
  webOrigin,
  redirectUriMatches,
  resourceMetadataUrl,
  resourceUrl,
  verifyPkce,
} from "./oauthCore";

const verifier = "a".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");

describe("PKCE", () => {
  it("accepts the verifier that made the challenge", () => {
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });

  it("rejects another verifier, a missing one, and one that is too short or has bad characters", () => {
    expect(verifyPkce("b".repeat(43), challenge)).toBe(false);
    expect(verifyPkce(undefined, challenge)).toBe(false);
    expect(verifyPkce("short", challenge)).toBe(false);
    expect(verifyPkce("a".repeat(42) + "!", challenge)).toBe(false);
  });
});

describe("redirect URIs", () => {
  it("registers https and loopback http only, without fragments or credentials", () => {
    expect(isAcceptableRedirectUri("https://chatgpt.com/connector_platform_oauth_redirect")).toBe(true);
    expect(isAcceptableRedirectUri("http://127.0.0.1:8123/callback")).toBe(true);
    expect(isAcceptableRedirectUri("http://localhost/cb")).toBe(true);
    expect(isAcceptableRedirectUri("http://[::1]:9/cb")).toBe(true);

    expect(isAcceptableRedirectUri("http://evil.example/cb")).toBe(false);
    expect(isAcceptableRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isAcceptableRedirectUri("myapp://callback")).toBe(false);
    expect(isAcceptableRedirectUri("https://a.example/cb#frag")).toBe(false);
    expect(isAcceptableRedirectUri("https://user:pw@a.example/cb")).toBe(false);
    expect(isAcceptableRedirectUri("not a url")).toBe(false);
    expect(isAcceptableRedirectUri(42)).toBe(false);
  });

  it("matches exactly, except that a loopback redirect may use any port", () => {
    const registered = ["https://claude.ai/api/mcp/auth_callback", "http://127.0.0.1:5000/callback"];
    expect(redirectUriMatches(registered, "https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(redirectUriMatches(registered, "https://claude.ai/api/mcp/auth_callback/")).toBe(false);
    expect(redirectUriMatches(registered, "https://claude.ai/other")).toBe(false);
    expect(redirectUriMatches(registered, "http://127.0.0.1:61234/callback")).toBe(true);
    expect(redirectUriMatches(registered, "http://127.0.0.1:61234/other")).toBe(false);
    expect(redirectUriMatches(registered, "http://localhost:5000/callback")).toBe(false);
    // The port freedom is for loopback only.
    expect(redirectUriMatches(["https://a.example:8443/cb"], "https://a.example:9443/cb")).toBe(false);
  });
});

describe("client registration", () => {
  it("accepts a public client and cleans its name", () => {
    const reg = parseClientRegistration({
      client_name: "  Chat<script>GPT\u0007  ",
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect", "https://chatgpt.com/connector_platform_oauth_redirect"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    });
    expect(reg.clientName).toBe("ChatscriptGPT");
    expect(reg.redirectUris).toHaveLength(1);
  });

  it("falls back to a neutral name", () => {
    expect(parseClientRegistration({ redirect_uris: ["https://a.example/cb"] }).clientName).toBe("Connected app");
  });

  it.each([
    [{}],
    [{ redirect_uris: [] }],
    [{ redirect_uris: ["http://evil.example/cb"] }],
    [{ redirect_uris: Array.from({ length: 11 }, (_, i) => `https://a.example/${i}`) }],
    [{ redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "client_secret_basic" }],
    [{ redirect_uris: ["https://a.example/cb"], grant_types: ["password"] }],
  ])("refuses %j", (body) => {
    expect(() => parseClientRegistration(body)).toThrow(OAuthRequestError);
  });
});

describe("scope", () => {
  it("defaults to the one scope and refuses unknown ones", () => {
    expect(normalizeScope(undefined)).toBe("fibuki");
    expect(normalizeScope("")).toBe("fibuki");
    expect(normalizeScope("fibuki fibuki")).toBe("fibuki");
    expect(() => normalizeScope("fibuki admin")).toThrow(/Supported scopes/);
  });
});

describe("which app is asking", () => {
  it("verifies callbacks on ChatGPT's and Claude's hosts only", () => {
    expect(appIdentityFor("https://chatgpt.com/connector_platform_oauth_redirect")).toEqual({ origin: "chatgpt", host: "chatgpt.com", verified: true });
    expect(appIdentityFor("https://claude.ai/api/mcp/auth_callback")).toMatchObject({ origin: "claude", verified: true });
    expect(appIdentityFor("https://claude.com/api/mcp/auth_callback")).toMatchObject({ origin: "claude", verified: true });
  });

  it("does not trust look-alike hosts or loopback apps", () => {
    expect(appIdentityFor("https://chatgpt.com.evil.example/cb")).toMatchObject({ origin: "api", verified: false });
    expect(appIdentityFor("https://evil-claude.ai/cb")).toMatchObject({ origin: "api", verified: false });
    expect(appIdentityFor("http://127.0.0.1:1234/callback")).toMatchObject({ origin: "api", verified: false, host: "127.0.0.1" });
    expect(appIdentityFor("http://chatgpt.com/cb")).toMatchObject({ verified: false });
  });
});

describe("discovery documents", () => {
  const origin = "https://fibuki.com";

  it("agree with each other and with the MCP resource", () => {
    const as = authorizationServerMetadata(origin);
    const pr = protectedResourceMetadata(origin);
    expect(as.issuer).toBe(origin);
    expect(pr.authorization_servers).toEqual([as.issuer]);
    expect(pr.resource).toBe(resourceUrl(origin));
    expect(pr.resource).toBe("https://fibuki.com/api/mcp/sse");
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.authorization_response_iss_parameter_supported).toBe(true);
    expect(as.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(as.registration_endpoint).toBe("https://fibuki.com/api/oauth/register");
    expect(as.authorization_endpoint).toBe("https://fibuki.com/oauth/authorize");
  });

  it("the 401 challenge names the metadata document for the MCP endpoint", () => {
    expect(resourceMetadataUrl(origin)).toBe("https://fibuki.com/.well-known/oauth-protected-resource/api/mcp/sse");
    expect(bearerChallenge(undefined, origin)).toBe(
      'Bearer realm="fibuki", resource_metadata="https://fibuki.com/.well-known/oauth-protected-resource/api/mcp/sse"'
    );
    expect(bearerChallenge("invalid_token", origin)).toMatch(/error="invalid_token"$/);
  });

  it("the public origin is the first real web origin, never a wildcard", () => {
    expect(webOrigin({ FIBUKI_WEB_ORIGIN: "https://app.example.org/, https://other.example" } as never)).toBe("https://app.example.org");
    expect(webOrigin({ FIBUKI_WEB_ORIGIN: "*, https://x.example" } as never)).toBe("https://x.example");
    expect(webOrigin({} as never)).toBe("https://fibuki.com");
  });
});

describe("access tokens", () => {
  it("are API keys, so the MCP endpoint accepts them", () => {
    const { token, hash, prefix } = generateAccessToken();
    expect(token).toMatch(/^fk_[0-9a-f]{32}$/);
    expect(hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(prefix).toBe(token.slice(0, 11));
  });
});
