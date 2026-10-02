/**
 * The endpoints a connecting app talks to, and the callable the authorize page calls.
 * Driven as the apps drive them: discover, register, authorize, exchange, refresh.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
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

const http = await import("./oauthHttp");
const { createOAuthAuthorizationCallable } = await import("./oauthCallable");
const { validateApiKey } = await import("../api-keys");

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
}

async function call(fn: unknown, method: string, opts: { query?: Record<string, unknown>; body?: unknown } = {}): Promise<FakeRes> {
  const out: FakeRes = { statusCode: 200, headers: {}, body: undefined };
  const res = {
    set(h: Record<string, string>) {
      for (const [k, v] of Object.entries(h)) out.headers[k.toLowerCase()] = v;
      return res;
    },
    setHeader(k: string, v: string) {
      out.headers[k.toLowerCase()] = v;
      return res;
    },
    status(c: number) {
      out.statusCode = c;
      return res;
    },
    json(b: unknown) {
      out.body = b;
      return res;
    },
    send(b: unknown) {
      out.body = b;
      return res;
    },
    end() {
      return res;
    },
  };
  await (fn as (req: unknown, res: unknown) => Promise<void>)({ method, query: opts.query ?? {}, body: opts.body, headers: {} }, res);
  return out;
}

const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const verifier = "q".repeat(60);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const USER = "user-ep";

async function registerChatGpt() {
  const res = await call(http.oauthRegister, "POST", {
    body: { client_name: "ChatGPT", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" },
  });
  return (res.body as { client_id: string }).client_id;
}

const authorizeBody = (clientId: string, extra: Record<string, unknown> = {}) => ({
  clientId,
  redirectUri: REDIRECT,
  responseType: "code",
  scope: "fibuki",
  state: "st-1",
  codeChallenge: challenge,
  codeChallengeMethod: "S256",
  resource: "https://fibuki.com/api/mcp/sse",
  decision: "allow" as const,
  ...extra,
});

const consent = (data: ReturnType<typeof authorizeBody>, userId = USER) =>
  (createOAuthAuthorizationCallable as unknown as (ctx: unknown, d: unknown) => Promise<{ redirectUrl: string }>)(
    createTestContext(userId),
    data
  );

beforeEach(() => store.clear());

describe("discovery", () => {
  it("serves both documents, with CORS, and 404s anything else", async () => {
    const as = await call(http.oauthMetadata, "GET", { query: { doc: "authorization-server" } });
    expect(as.statusCode).toBe(200);
    expect(as.headers["access-control-allow-origin"]).toBe("*");
    expect(as.body).toMatchObject({ issuer: "https://fibuki.com", code_challenge_methods_supported: ["S256"] });

    const pr = await call(http.oauthMetadata, "GET", { query: { doc: "protected-resource" } });
    expect(pr.body).toMatchObject({ resource: "https://fibuki.com/api/mcp/sse", authorization_servers: ["https://fibuki.com"] });

    expect((await call(http.oauthMetadata, "GET", { query: { doc: "nope" } })).statusCode).toBe(404);
  });

  it("answers preflight and refuses the wrong method", async () => {
    expect((await call(http.oauthToken, "OPTIONS")).statusCode).toBe(204);
    const wrong = await call(http.oauthToken, "GET");
    expect(wrong.statusCode).toBe(405);
    expect(wrong.headers.allow).toBe("POST");
  });
});

describe("registration", () => {
  it("registers a public client (201) and echoes what it stored", async () => {
    const res = await call(http.oauthRegister, "POST", { body: { client_name: "Codex", redirect_uris: ["http://127.0.0.1:4321/cb"] } });
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ client_name: "Codex", token_endpoint_auth_method: "none", response_types: ["code"] });
    expect((res.body as { client_id: string }).client_id).toMatch(/^oc_/);
  });

  it("refuses an unsafe redirect URI and a confidential client, in RFC 7591 terms", async () => {
    const bad = await call(http.oauthRegister, "POST", { body: { redirect_uris: ["http://evil.example/cb"] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toMatchObject({ error: "invalid_redirect_uri" });

    const secret = await call(http.oauthRegister, "POST", { body: { redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post" } });
    expect(secret.body).toMatchObject({ error: "invalid_client_metadata" });
  });
});

describe("client info (what the authorize page asks first)", () => {
  const query = (clientId: string, extra: Record<string, unknown> = {}) => ({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-1",
    ...extra,
  });

  it("describes a valid request: who is asking and whether the callback host is trusted", async () => {
    const id = await registerChatGpt();
    const res = await call(http.oauthClientInfo, "GET", { query: query(id) });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ valid: true, clientName: "ChatGPT", redirectHost: "chatgpt.com", verified: true, app: "chatgpt", scope: "fibuki" });
  });

  it("an unknown client or unregistered redirect is invalid and gives nowhere to redirect to", async () => {
    const id = await registerChatGpt();
    const unknown = await call(http.oauthClientInfo, "GET", { query: query("oc_nope") });
    expect(unknown.body).toMatchObject({ valid: false, error: "invalid_client" });
    expect((unknown.body as { redirectUrl?: string }).redirectUrl).toBeUndefined();

    const wrongUri = await call(http.oauthClientInfo, "GET", { query: query(id, { redirect_uri: "https://evil.example/cb" }) });
    expect(wrongUri.body).toMatchObject({ valid: false, error: "invalid_request" });
    expect((wrongUri.body as { redirectUrl?: string }).redirectUrl).toBeUndefined();
  });

  it("any other mistake comes with the URL that returns the error to the app", async () => {
    const id = await registerChatGpt();
    const res = await call(http.oauthClientInfo, "GET", { query: query(id, { scope: "admin" }) });
    const body = res.body as { valid: boolean; error: string; redirectUrl: string };
    expect(body).toMatchObject({ valid: false, error: "invalid_scope" });
    const url = new URL(body.redirectUrl);
    expect(url.origin + url.pathname).toBe(REDIRECT);
    expect(url.searchParams.get("error")).toBe("invalid_scope");
    expect(url.searchParams.get("state")).toBe("st-1");
  });
});

describe("the whole flow, as ChatGPT runs it", () => {
  it("register, user consents, code for tokens, MCP access, refresh", async () => {
    const clientId = await registerChatGpt();

    const { redirectUrl } = await consent(authorizeBody(clientId));
    const back = new URL(redirectUrl);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("st-1");
    expect(back.searchParams.get("iss")).toBe("https://fibuki.com");
    const code = back.searchParams.get("code")!;

    // Form-encoded body, as the spec has it (the host parses it into an object).
    const token = await call(http.oauthToken, "POST", {
      body: { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier, resource: "https://fibuki.com/api/mcp/sse" },
    });
    expect(token.statusCode).toBe(200);
    expect(token.headers["cache-control"]).toBe("no-store");
    const t = token.body as { access_token: string; refresh_token: string; token_type: string; expires_in: number };
    expect(t).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    await expect(validateApiKey(t.access_token)).resolves.toMatchObject({ userId: USER });

    const refreshed = await call(http.oauthToken, "POST", {
      body: { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: clientId },
    });
    expect(refreshed.statusCode).toBe(200);
    await expect(validateApiKey((refreshed.body as { access_token: string }).access_token)).resolves.toMatchObject({ userId: USER });
  });

  it("token errors use RFC 6749 names and statuses", async () => {
    const clientId = await registerChatGpt();
    const badGrant = await call(http.oauthToken, "POST", { body: { grant_type: "authorization_code", code: "nope", client_id: clientId, code_verifier: verifier } });
    expect(badGrant.statusCode).toBe(400);
    expect(badGrant.body).toMatchObject({ error: "invalid_grant" });

    const unknownClient = await call(http.oauthToken, "POST", { body: { grant_type: "authorization_code", code: "x", client_id: "oc_nope" } });
    expect(unknownClient.statusCode).toBe(401);
    expect(unknownClient.body).toMatchObject({ error: "invalid_client" });

    const password = await call(http.oauthToken, "POST", { body: { grant_type: "password" } });
    expect(password.body).toMatchObject({ error: "unsupported_grant_type" });
  });
});

describe("consent", () => {
  it("denying sends access_denied back to the app, with state", async () => {
    const clientId = await registerChatGpt();
    const { redirectUrl } = await consent(authorizeBody(clientId, { decision: "deny" }));
    const url = new URL(redirectUrl);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("st-1");
    expect(url.searchParams.has("code")).toBe(false);
    expect(store.getCollection("oauthCodes").size).toBe(0);
  });

  it("a redirectable mistake goes back to the app as an error, a non-redirectable one is refused outright", async () => {
    const clientId = await registerChatGpt();
    const { redirectUrl } = await consent(authorizeBody(clientId, { scope: "admin" }));
    expect(new URL(redirectUrl).searchParams.get("error")).toBe("invalid_scope");

    await expect(consent(authorizeBody(clientId, { redirectUri: "https://evil.example/cb" }))).rejects.toMatchObject({ code: "invalid-argument" });
    await expect(consent(authorizeBody("oc_nope"))).rejects.toMatchObject({ code: "invalid-argument" });
    await expect(consent({ ...authorizeBody(clientId), decision: "maybe" as never })).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("a user who connects through ChatGPT is recorded as coming from ChatGPT, once", async () => {
    const clientId = await registerChatGpt();
    await consent(authorizeBody(clientId));
    const doc = store.getDoc(`users/${USER}/settings`, "onboarding");
    expect(doc).toMatchObject({ origin: "chatgpt", isComplete: false, welcomeSeen: false });

    // Another connection later does not rewrite where they came from.
    const claude = (await call(http.oauthRegister, "POST", { body: { client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] } })).body as { client_id: string };
    await consent({ ...authorizeBody(claude.client_id), redirectUri: "https://claude.ai/api/mcp/auth_callback" });
    expect(store.getDoc(`users/${USER}/settings`, "onboarding")?.origin).toBe("chatgpt");
  });

  it("an existing user keeps their onboarding as it is", async () => {
    store.setDoc(`users/${USER}/settings`, "onboarding", { isComplete: true, origin: "web", currentStep: "attach_file", completedSteps: {} });
    const clientId = await registerChatGpt();
    await consent(authorizeBody(clientId));
    expect(store.getDoc(`users/${USER}/settings`, "onboarding")).toMatchObject({ isComplete: true, origin: "web" });
  });
});
