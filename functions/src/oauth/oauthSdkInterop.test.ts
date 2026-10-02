/**
 * Interop: the official MCP SDK's own OAuth client against our endpoints. It does what
 * ChatGPT, Claude and Codex do: hit the MCP URL without a token, follow the 401 challenge to
 * the protected-resource metadata, find the authorization server, register itself, send the
 * user to authorize with PKCE, exchange the code, call a tool, and later refresh.
 *
 * The only thing played by hand is the user in the browser: the authorize URL is read, and the
 * consent callable (what the authorize page calls) stands in for the click on Allow.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { store, createMockFirestore, createTestContext } from "../test/setup";

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
  }
  return {
    getFirestore: () => createMockFirestore(),
    FieldValue: { serverTimestamp: () => new Date(), increment: (n: number) => n },
    Timestamp: FakeInstant,
  };
});
vi.mock("../utils/createCallable", () => ({
  createCallable: <TReq, TRes>(_c: unknown, handler: (ctx: unknown, data: TReq) => Promise<TRes>) => handler,
  HttpsError: class HttpsError extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
}));
vi.mock("../mcp-api/handlers", () => ({
  handleToolInternal: vi.fn(async (userId: string) => ({ sources: [], asUser: userId })),
}));

const { oauthMetadata, oauthRegister, oauthToken } = await import("./oauthHttp");
const { createOAuthAuthorizationCallable } = await import("./oauthCallable");
const { mcpSse } = await import("../mcp-api/mcp-sse");
const express = (await import("express")).default;
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { UnauthorizedError } = await import("@modelcontextprotocol/sdk/client/auth.js");
type OAuthClientProvider = import("@modelcontextprotocol/sdk/client/auth.js").OAuthClientProvider;

const USER = "user-interop";
let server: Server;
let origin = "";

/** The routes the Next proxies expose on the public origin, mapped onto the functions behind them. */
function buildApp() {
  const app = express();
  const run = (fn: unknown, extra: Record<string, string> = {}) => (req: never, res: never) => {
    const r = req as { query: Record<string, unknown> };
    r.query = { ...r.query, ...extra };
    return (fn as (a: unknown, b: unknown) => unknown)(req, res);
  };
  app.get("/.well-known/oauth-protected-resource/api/mcp/sse", run(oauthMetadata, { doc: "protected-resource" }));
  app.get("/.well-known/oauth-protected-resource", run(oauthMetadata, { doc: "protected-resource" }));
  app.get("/.well-known/oauth-authorization-server", run(oauthMetadata, { doc: "authorization-server" }));
  app.post("/api/oauth/register", express.json(), run(oauthRegister));
  app.post("/api/oauth/token", express.urlencoded({ extended: true }), express.json(), run(oauthToken));
  app.all("/api/mcp/sse", express.json(), (req, res) => mcpSse(req as never, res as never));
  return app;
}

/** An in-memory OAuth client: what Claude, ChatGPT or Codex keeps between steps. */
function memoryProvider() {
  const memory: { client?: unknown; tokens?: unknown; verifier?: string; authorizationUrl?: URL } = {};
  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return "https://chatgpt.com/connector_platform_oauth_redirect";
    },
    get clientMetadata() {
      return {
        client_name: "ChatGPT",
        redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    state: () => "state-from-the-app",
    clientInformation: () => memory.client as never,
    saveClientInformation: (info) => void (memory.client = info),
    tokens: () => memory.tokens as never,
    saveTokens: (tokens) => void (memory.tokens = tokens),
    redirectToAuthorization: (url) => void (memory.authorizationUrl = url),
    saveCodeVerifier: (v) => void (memory.verifier = v),
    codeVerifier: () => memory.verifier ?? "",
  };
  return { provider, memory };
}

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = buildApp().listen(0, "127.0.0.1", () => resolve(s));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.FIBUKI_WEB_ORIGIN = origin; // issuer and resource are this server
});
afterAll(async () => {
  delete process.env.FIBUKI_WEB_ORIGIN;
  await new Promise((resolve) => server.close(resolve));
});

describe("the official MCP SDK client, end to end", () => {
  it("discovers, registers, authorizes with PKCE, calls a tool as the user, and refreshes", async () => {
    const { provider, memory } = memoryProvider();
    const mcpUrl = new URL(`${origin}/api/mcp/sse`);

    // 1. No token: the server answers 401 with the challenge; the SDK discovers the rest and
    //    registers itself, then asks to send the user to the authorization endpoint.
    const first = new Client({ name: "chatgpt-like", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
    await expect(first.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);

    const authorizationUrl = memory.authorizationUrl!;
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(`${origin}/oauth/authorize`);
    const q = authorizationUrl.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toMatch(/^oc_/);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toBeTruthy();
    expect(q.get("redirect_uri")).toBe("https://chatgpt.com/connector_platform_oauth_redirect");
    expect(q.get("resource")).toBe(`${origin}/api/mcp/sse`);
    expect(q.get("state")).toBe("state-from-the-app");

    // 2. The user, in the browser: the authorize page's Allow calls this.
    const { redirectUrl } = await (createOAuthAuthorizationCallable as unknown as (c: unknown, d: unknown) => Promise<{ redirectUrl: string }>)(
      createTestContext(USER),
      {
        clientId: q.get("client_id"),
        redirectUri: q.get("redirect_uri"),
        responseType: q.get("response_type"),
        scope: q.get("scope") ?? undefined,
        state: q.get("state") ?? undefined,
        codeChallenge: q.get("code_challenge"),
        codeChallengeMethod: q.get("code_challenge_method"),
        resource: q.get("resource") ?? undefined,
        decision: "allow",
      }
    );
    const back = new URL(redirectUrl);
    expect(back.searchParams.get("state")).toBe(q.get("state"));
    expect(back.searchParams.get("iss")).toBe(origin);

    // 3. The app exchanges the code (with its PKCE verifier) for tokens.
    await transport.finishAuth(back.searchParams.get("code")!);
    expect((memory.tokens as { access_token: string }).access_token).toMatch(/^fk_/);

    // 4. With the token it can use the tools, as the user who consented.
    const second = new Client({ name: "chatgpt-like", version: "1.0.0" });
    await second.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider }));
    const result = await second.callTool({ name: "list_sources", arguments: {} });
    expect(result.structuredContent).toMatchObject({ asUser: USER });
    await second.close();

    // 5. The access token expires; the SDK refreshes on the next 401 and carries on.
    const before = (memory.tokens as { access_token: string; refresh_token: string }).access_token;
    const grantId = [...store.getCollection("apiKeys").keys()][0];
    const grant = store.getDoc("apiKeys", grantId)!;
    store.setDoc("apiKeys", grantId, { ...grant, expiresAt: { toDate: () => new Date(Date.now() - 1000), toMillis: () => Date.now() - 1000 } });

    const third = new Client({ name: "chatgpt-like", version: "1.0.0" });
    await third.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider }));
    expect(await third.callTool({ name: "list_sources", arguments: {} })).toMatchObject({ structuredContent: { asUser: USER } });
    await third.close();

    const after = (memory.tokens as { access_token: string }).access_token;
    expect(after).not.toBe(before);
    expect([...store.getCollection("apiKeys").keys()]).toHaveLength(1); // the same grant, rotated
  });

  it("a user who says no gives the app an access_denied, not a token", async () => {
    const { provider, memory } = memoryProvider();
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp/sse`), { authProvider: provider });
    await expect(new Client({ name: "c", version: "1" }).connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);

    const q = memory.authorizationUrl!.searchParams;
    const { redirectUrl } = await (createOAuthAuthorizationCallable as unknown as (c: unknown, d: unknown) => Promise<{ redirectUrl: string }>)(
      createTestContext(USER),
      {
        clientId: q.get("client_id"), redirectUri: q.get("redirect_uri"), responseType: "code", state: q.get("state"),
        codeChallenge: q.get("code_challenge"), codeChallengeMethod: "S256", resource: q.get("resource"), decision: "deny",
      }
    );
    expect(new URL(redirectUrl).searchParams.get("error")).toBe("access_denied");
    expect(memory.tokens).toBeUndefined();
  });

  it("the 401 tells a client without a token where to start", async () => {
    const res = await fetch(`${origin}/api/mcp/sse`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer realm="fibuki", resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp/sse"`);
  });
});
