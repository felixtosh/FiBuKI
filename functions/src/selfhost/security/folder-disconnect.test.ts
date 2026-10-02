/**
 * Disconnecting a Folder Integration ends FiBuKI's access at the provider too
 * (ADR-0009), keeps the imported Files, and still disconnects when the
 * provider cannot be reached.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __resetFirestoreShim, getFirestore, Timestamp } from "../firestore-shim";
import { encrypt } from "../../utils/encryption";

const KEY = "b".repeat(64);
const AUTH = (uid: string) => ({ uid, token: { email: `${uid}@x.test`, email_verified: true } });

type Callable = { run: (req: { data: unknown; auth?: unknown }) => Promise<Record<string, unknown>> };

beforeEach(async () => {
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY = KEY;
  process.env.GOOGLE_CLIENT_ID = "gid";
  process.env.GOOGLE_CLIENT_SECRET = "gs";
  process.env.DROPBOX_APP_KEY = "dk";
  process.env.DROPBOX_APP_SECRET = "ds";
  await __resetFirestoreShim();
});
afterEach(() => vi.unstubAllGlobals());

async function seed(provider: "gdrive" | "dropbox", owner = "u1") {
  const db = getFirestore();
  const now = Timestamp.now();
  const { encrypted, iv } = encrypt("REFRESH-SECRET", KEY);
  await db.doc("folderIntegrations/i1").set({ userId: owner, provider, isActive: true, accountEmail: "a@b.test", createdAt: now, updatedAt: now });
  await db.doc("folderTokens/i1").set({ userId: owner, refreshToken: encrypted, refreshTokenIv: iv, cursor: "c" });
  await db.doc("folderEntries/i1_e1").set({ userId: owner, integrationId: "i1", externalId: "x", status: "imported", fileId: "f1" });
  await db.doc("files/f1").set({ userId: owner, fileName: "a.pdf", sourceType: provider });
}

async function disconnect(uid = "u1") {
  const { disconnectFolderIntegrationCallable } = await import("../../folder-sync/folderIntegrationCallables");
  return (disconnectFolderIntegrationCallable as unknown as Callable).run({ data: { integrationId: "i1" }, auth: AUTH(uid) });
}

describe("disconnectFolderIntegration", () => {
  it("revokes the Drive grant at Google, then deletes token and sync state, keeping the Files", async () => {
    await seed("gdrive");
    const f = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", f);

    const res = await disconnect();
    expect(res).toMatchObject({ success: true, revoked: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/revoke");
    expect(String(init.body)).toBe("token=REFRESH-SECRET");

    const db = getFirestore();
    expect((await db.doc("folderTokens/i1").get()).exists).toBe(false);
    expect((await db.doc("folderEntries/i1_e1").get()).exists).toBe(false);
    expect((await db.doc("folderIntegrations/i1").get()).data()?.isActive).toBe(false);
    expect((await db.doc("files/f1").get()).exists).toBe(true);
  });

  it("still disconnects when the provider is unreachable, and says it could not revoke", async () => {
    await seed("gdrive");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));

    const res = await disconnect();
    expect(res).toMatchObject({ success: true, revoked: false });
    const db = getFirestore();
    expect((await db.doc("folderTokens/i1").get()).exists).toBe(false);
    expect((await db.doc("folderIntegrations/i1").get()).data()?.isActive).toBe(false);
  });

  it("a grant the provider already killed counts as revoked", async () => {
    await seed("gdrive");
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"invalid_token"}', { status: 400 })));
    expect(await disconnect()).toMatchObject({ success: true, revoked: true });
  });

  it("revokes a Dropbox grant through a fresh access token", async () => {
    await seed("dropbox");
    const f = vi.fn(async (url: string) =>
      url.includes("oauth2/token") ? new Response(JSON.stringify({ access_token: "AT" })) : new Response("null")
    );
    vi.stubGlobal("fetch", f);
    expect(await disconnect()).toMatchObject({ success: true, revoked: true });
    expect(f.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual([
      "https://api.dropboxapi.com/oauth2/token",
      "https://api.dropboxapi.com/2/auth/token/revoke",
    ]);
  });

  it("never revokes, or touches, another user's integration", async () => {
    await seed("gdrive", "victim");
    const f = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", f);

    await expect(disconnect("attacker")).rejects.toThrow(/not found/i);
    expect(f).not.toHaveBeenCalled();
    const db = getFirestore();
    expect((await db.doc("folderTokens/i1").get()).exists).toBe(true);
    expect((await db.doc("folderIntegrations/i1").get()).data()?.isActive).toBe(true);
  });
});

describe("revokeUserFolderGrants (account deletion)", () => {
  const secrets = {
    dropboxAppKey: "dk",
    dropboxAppSecret: "ds",
    googleClientId: "gid",
    googleClientSecret: "gs",
    encryptionKey: KEY,
  };

  it("revokes every grant the user holds, and only theirs", async () => {
    const { revokeUserFolderGrants } = await import("../../folder-sync/revoke");
    await seed("gdrive", "u1");
    const db = getFirestore();
    const now = Timestamp.now();
    const { encrypted, iv } = encrypt("OTHER-USER-SECRET", KEY);
    await db.doc("folderIntegrations/i2").set({ userId: "someone-else", provider: "gdrive", isActive: true, createdAt: now, updatedAt: now });
    await db.doc("folderTokens/i2").set({ userId: "someone-else", refreshToken: encrypted, refreshTokenIv: iv });

    const f = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", f);

    expect(await revokeUserFolderGrants(db as never, "u1", secrets)).toBe(1);
    const bodies = f.mock.calls.map((c) => String(((c as unknown as [string, RequestInit])[1]).body));
    expect(bodies).toEqual(["token=REFRESH-SECRET"]);
  });

  it("without secrets it revokes nothing and does not throw", async () => {
    const { revokeUserFolderGrants } = await import("../../folder-sync/revoke");
    await seed("gdrive", "u1");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await revokeUserFolderGrants(getFirestore() as never, "u1", null)).toBe(0);
    expect(f).not.toHaveBeenCalled();
  });

  it("one failing provider does not stop the others", async () => {
    const { revokeUserFolderGrants } = await import("../../folder-sync/revoke");
    await seed("gdrive", "u1");
    const db = getFirestore();
    const now = Timestamp.now();
    const { encrypted, iv } = encrypt("SECOND", KEY);
    await db.doc("folderIntegrations/i2").set({ userId: "u1", provider: "gdrive", isActive: true, createdAt: now, updatedAt: now });
    await db.doc("folderTokens/i2").set({ userId: "u1", refreshToken: encrypted, refreshTokenIv: iv });
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (n++ === 0) throw new Error("offline");
      return new Response("", { status: 200 });
    }));
    expect(await revokeUserFolderGrants(db as never, "u1", secrets)).toBe(2);
  });
});
