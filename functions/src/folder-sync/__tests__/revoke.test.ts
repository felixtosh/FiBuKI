import { describe, expect, it, vi } from "vitest";
import { revokeGrant } from "../revoke";
import type { FolderRunnerSecrets } from "../folderSyncRunner";

const secrets: FolderRunnerSecrets = {
  dropboxAppKey: "k",
  dropboxAppSecret: "s",
  googleClientId: "gid",
  googleClientSecret: "gs",
  encryptionKey: "a".repeat(64),
};
const res = (status: number, body = "") => new Response(body, { status });
const asFetch = (f: unknown) => f as typeof fetch;

describe("revokeGrant: Google Drive", () => {
  it("revokes the refresh token itself", async () => {
    const f = vi.fn(async () => res(200));
    expect(await revokeGrant("gdrive", "RT", secrets, asFetch(f))).toBe("revoked");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/revoke");
    expect(String(init.body)).toBe("token=RT");
  });

  it("a token Google no longer knows is already revoked, not a failure", async () => {
    const f = vi.fn(async () => res(400, '{"error":"invalid_token"}'));
    expect(await revokeGrant("gdrive", "RT", secrets, asFetch(f))).toBe("already-invalid");
  });

  it("any other error is a failure, and never throws", async () => {
    expect(await revokeGrant("gdrive", "RT", secrets, asFetch(vi.fn(async () => res(500))))).toBe("failed");
    expect(
      await revokeGrant("gdrive", "RT", secrets, asFetch(vi.fn(async () => { throw new Error("offline"); })))
    ).toBe("failed");
  });
});

describe("revokeGrant: Dropbox", () => {
  it("mints an access token, then revokes with it", async () => {
    const f = vi.fn(async (url: string) =>
      url.includes("oauth2/token")
        ? new Response(JSON.stringify({ access_token: "AT" }), { status: 200 })
        : res(200, "null")
    );
    expect(await revokeGrant("dropbox", "RT", secrets, asFetch(f))).toBe("revoked");
    const [url, init] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.dropboxapi.com/2/auth/token/revoke");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer AT");
  });

  it("a refresh token Dropbox already refuses means the grant is gone", async () => {
    const f = vi.fn(async () => res(400, '{"error":"invalid_grant"}'));
    expect(await revokeGrant("dropbox", "RT", secrets, asFetch(f))).toBe("already-invalid");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a revoke call that fails is reported, not thrown", async () => {
    const f = vi.fn(async (url: string) =>
      url.includes("oauth2/token")
        ? new Response(JSON.stringify({ access_token: "AT" }), { status: 200 })
        : res(500)
    );
    expect(await revokeGrant("dropbox", "RT", secrets, asFetch(f))).toBe("failed");
  });
});
