/**
 * The Dropbox connect routes (ADR-0009): the callback learns WHO connected from
 * the server-side OAuth state, never from the browser; the grant is stored
 * encrypted; a failed or forged callback creates nothing.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { __resetFirestoreShim, getFirestore } from "../firestore-shim";
import { anonymous, asUser, enableInternalAuth } from "./routes";

const KEY = "a".repeat(64);

beforeAll(() => {
  enableInternalAuth();
  process.env.DROPBOX_APP_KEY = "app-key";
  process.env.DROPBOX_APP_SECRET = "app-secret";
  process.env.DROPBOX_OAUTH_REDIRECT_URI = "https://web.test/api/dropbox/callback";
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY = KEY;
});

beforeEach(async () => {
  await __resetFirestoreShim();
});
afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function stubDropbox(over: { scope?: string; account?: Record<string, unknown> } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("oauth2/token")) {
        return json({
          access_token: "AT",
          refresh_token: "RT-secret",
          scope: over.scope ?? "account_info.read files.metadata.read files.content.read",
          account_id: "dbid:1",
        });
      }
      return json({ account_id: "dbid:1", email: "me@dropbox.test", name: { display_name: "Me" }, ...over.account });
    })
  );
}

async function startFlow(uid: string): Promise<{ state: string }> {
  const { POST } = await import("@/app/api/dropbox/authorize/route");
  const res = await POST(asUser(uid, "/api/dropbox/authorize", { body: {} }));
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  const u = new URL(url);
  expect(u.searchParams.get("token_access_type")).toBe("offline");
  expect(u.searchParams.get("scope")).toBe("account_info.read files.metadata.read files.content.read");
  return { state: u.searchParams.get("state") as string };
}

function callback(state: string | null, cookie: string | null, code = "CODE"): NextRequest {
  const url = new URL("https://web.test/api/dropbox/callback");
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  return new NextRequest(url, { headers: cookie ? { cookie: `dropbox_oauth_state=${cookie}` } : {} });
}

const integrations = async () => (await getFirestore().collection("folderIntegrations").get()).docs;

describe("authorize", () => {
  it("refuses an anonymous caller", async () => {
    const { POST } = await import("@/app/api/dropbox/authorize/route");
    const res = await POST(anonymous("/api/dropbox/authorize", {}));
    expect(res.status).toBe(401);
  });
});

describe("callback", () => {
  it("connects the user the state was issued to, with an encrypted grant", async () => {
    const { GET } = await import("@/app/api/dropbox/callback/route");
    stubDropbox();
    const { state } = await startFlow("user-a");
    const res = await GET(callback(state, state));
    expect(res.headers.get("location")).toContain("success=connected");

    const docs = await integrations();
    expect(docs).toHaveLength(1);
    expect(docs[0].data()).toMatchObject({
      userId: "user-a",
      provider: "dropbox",
      accountEmail: "me@dropbox.test",
      folderPath: null,
      removeConnectedFiles: false,
      isActive: true,
    });
    const tok = (await getFirestore().collection("folderTokens").doc(docs[0].id).get()).data()!;
    expect(tok.userId).toBe("user-a");
    expect(tok.refreshToken).not.toContain("RT-secret");
    expect(JSON.stringify(tok)).not.toContain("RT-secret");
    expect(tok.refreshTokenIv).toBeTruthy();
  });

  it("refuses a callback whose cookie does not match (login CSRF)", async () => {
    const { GET } = await import("@/app/api/dropbox/callback/route");
    stubDropbox();
    const { state } = await startFlow("user-a");
    for (const cookie of [null, "f".repeat(64)]) {
      const res = await GET(callback(state, cookie));
      expect(res.headers.get("location")).toContain("error=invalid_state");
    }
    expect(await integrations()).toHaveLength(0);
  });

  it("a state works exactly once", async () => {
    const { GET } = await import("@/app/api/dropbox/callback/route");
    stubDropbox();
    const { state } = await startFlow("user-a");
    await GET(callback(state, state));
    const replay = await GET(callback(state, state));
    expect(replay.headers.get("location")).toContain("error=invalid_state");
    expect(await integrations()).toHaveLength(1);
  });

  it("a Gmail state cannot be replayed into the Dropbox callback", async () => {
    const { GET } = await import("@/app/api/dropbox/callback/route");
    const { createOAuthState } = await import("@/lib/gmail/oauth-state");
    stubDropbox();
    const gmailState = await createOAuthState("user-a", "gmail");
    const res = await GET(callback(gmailState, gmailState));
    expect(res.headers.get("location")).toContain("error=invalid_state");
    expect(await integrations()).toHaveLength(0);
  });

  it("refuses a grant without content access", async () => {
    const { GET } = await import("@/app/api/dropbox/callback/route");
    stubDropbox({ scope: "account_info.read" });
    const { state } = await startFlow("user-a");
    const res = await GET(callback(state, state));
    expect(res.headers.get("location")).toContain("error=missing_scope");
    expect(await integrations()).toHaveLength(0);
  });

  it("never stores a grant it cannot encrypt", async () => {
    const { GET } = await import("@/app/api/dropbox/callback/route");
    stubDropbox();
    const { state } = await startFlow("user-a");
    const saved = process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
    delete process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
    try {
      const res = await GET(callback(state, state));
      expect(res.headers.get("location")).toContain("error=encryption_not_configured");
    } finally {
      process.env.GMAIL_TOKEN_ENCRYPTION_KEY = saved;
    }
    expect(await integrations()).toHaveLength(0);
    expect((await getFirestore().collection("folderTokens").get()).size).toBe(0);
  });

  it("reconnecting the same Dropbox account keeps the folder and settings", async () => {
    const { GET } = await import("@/app/api/dropbox/callback/route");
    stubDropbox();
    const first = await startFlow("user-a");
    await GET(callback(first.state, first.state));
    const [doc] = await integrations();
    await doc.ref.update({ folderPath: "/Belege", removeConnectedFiles: true, needsReauth: true, isActive: false });

    const second = await startFlow("user-a");
    await GET(callback(second.state, second.state));
    const after = await integrations();
    expect(after).toHaveLength(1);
    expect(after[0].data()).toMatchObject({
      folderPath: "/Belege",
      removeConnectedFiles: true,
      needsReauth: false,
      isActive: true,
    });
  });

  it("two users connecting the same Dropbox account get separate integrations", async () => {
    const { GET } = await import("@/app/api/dropbox/callback/route");
    stubDropbox();
    const a = await startFlow("user-a");
    await GET(callback(a.state, a.state));
    const b = await startFlow("user-b");
    await GET(callback(b.state, b.state));
    const docs = await integrations();
    expect(docs.map((d) => d.data().userId).sort()).toEqual(["user-a", "user-b"]);
  });
});
