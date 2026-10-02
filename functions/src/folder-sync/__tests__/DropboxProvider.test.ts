import { describe, expect, it, vi } from "vitest";
import {
  DropboxAuthError,
  DropboxProvider,
  FolderMissingError,
  refreshDropboxAccessToken,
} from "../dropbox/DropboxProvider";
import { FolderCursorResetError } from "../types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const make = (fetchImpl: typeof fetch, refresh = vi.fn(async () => "fresh")) => ({
  provider: new DropboxProvider({ accessToken: "old", refreshAccessToken: refresh, fetchImpl }),
  refresh,
});

describe("DropboxProvider", () => {
  it("lists recursively and maps files, folders and deletions", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        cursor: "c1",
        has_more: false,
        entries: [
          { ".tag": "file", id: "id:1", name: "A.pdf", path_lower: "/b/a.pdf", path_display: "/B/A.pdf", rev: "r1", size: 10, server_modified: "2026-01-02T03:04:05Z" },
          { ".tag": "folder", id: "id:2", name: "sub", path_lower: "/b/sub", path_display: "/B/sub" },
          { ".tag": "deleted", name: "x.pdf", path_lower: "/b/x.pdf", path_display: "/B/x.pdf" },
        ],
      })
    ) as unknown as typeof fetch;
    const { provider } = make(fetchImpl);
    const page = await provider.listFolder("/B");

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.dropboxapi.com/2/files/list_folder");
    expect(JSON.parse(init.body)).toMatchObject({ path: "/B", recursive: true });
    expect(init.headers.Authorization).toBe("Bearer old");
    expect(page.cursor).toBe("c1");
    expect(page.entries[0]).toMatchObject({ id: "id:1", rev: "r1", size: 10, isFolder: false, isDeleted: false });
    expect(page.entries[1].isFolder).toBe(true);
    expect(page.entries[2]).toMatchObject({ id: null, isDeleted: true, pathLower: "/b/x.pdf" });
  });

  it("refreshes the token once on a 401 and retries", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(json({ cursor: "c", has_more: false, entries: [] })) as unknown as typeof fetch;
    const { provider, refresh } = make(fetchImpl);
    await provider.listFolder("");
    expect(refresh).toHaveBeenCalledTimes(1);
    const retry = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1][1];
    expect(retry.headers.Authorization).toBe("Bearer fresh");
  });

  it("a revoked grant is an auth error, not an empty folder", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    const { provider } = make(fetchImpl);
    await expect(provider.listFolder("")).rejects.toBeInstanceOf(DropboxAuthError);
  });

  it("a failed refresh is an auth error", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    const { provider } = make(fetchImpl, vi.fn(async () => { throw new Error("bad"); }));
    await expect(provider.listFolder("")).rejects.toBeInstanceOf(DropboxAuthError);
  });

  it("a missing folder is its own error, never an empty listing", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error_summary: "path/not_found/." }, 409)
    ) as unknown as typeof fetch;
    const { provider } = make(fetchImpl);
    await expect(provider.listFolder("/gone")).rejects.toBeInstanceOf(FolderMissingError);
  });

  it("an expired cursor is a reset", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error_summary: "reset/..." }, 409)
    ) as unknown as typeof fetch;
    const { provider } = make(fetchImpl);
    await expect(provider.listContinue("stale")).rejects.toBeInstanceOf(FolderCursorResetError);
  });

  it("downloads by id with the argument header", async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("PDFBYTES"))) as unknown as typeof fetch;
    const { provider } = make(fetchImpl);
    const data = await provider.download({
      id: "id:1", name: "a.pdf", pathLower: "/a.pdf", pathDisplay: "/a.pdf", isFolder: false, isDeleted: false,
    });
    expect(data.toString()).toBe("PDFBYTES");
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://content.dropboxapi.com/2/files/download");
    expect(JSON.parse(init.headers["Dropbox-API-Arg"])).toEqual({ path: "id:1" });
  });

  it("lists only subfolders for the picker, sorted", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        cursor: "c", has_more: false,
        entries: [
          { ".tag": "folder", name: "Zeta", path_display: "/Zeta" },
          { ".tag": "file", name: "a.pdf", path_display: "/a.pdf" },
          { ".tag": "folder", name: "Alpha", path_display: "/Alpha" },
        ],
      })
    ) as unknown as typeof fetch;
    const { provider } = make(fetchImpl);
    expect(await provider.listSubfolders("")).toEqual([
      { name: "Alpha", path: "/Alpha" },
      { name: "Zeta", path: "/Zeta" },
    ]);
  });

  it("builds a link back into Dropbox", () => {
    const { provider } = make(vi.fn() as unknown as typeof fetch);
    expect(
      provider.linkFor({ id: "i", name: "a b.pdf", pathLower: "", pathDisplay: "/Belege/a b.pdf", isFolder: false, isDeleted: false })
    ).toBe("https://www.dropbox.com/home/Belege/a%20b.pdf");
  });
});

describe("refreshDropboxAccessToken", () => {
  it("returns the new access token", async () => {
    const fetchImpl = vi.fn(async () => json({ access_token: "tok" })) as unknown as typeof fetch;
    expect(await refreshDropboxAccessToken("rt", "k", "s", fetchImpl)).toBe("tok");
  });
  it("throws an auth error when Dropbox refuses", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "invalid_grant" }, 400)) as unknown as typeof fetch;
    await expect(refreshDropboxAccessToken("rt", "k", "s", fetchImpl)).rejects.toBeInstanceOf(DropboxAuthError);
  });
});
