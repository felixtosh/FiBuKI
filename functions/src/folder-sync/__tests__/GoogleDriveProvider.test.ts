import { describe, expect, it, vi } from "vitest";
import { GoogleDriveProvider, refreshGoogleAccessToken } from "../gdrive/GoogleDriveProvider";
import { FolderAuthError, FolderMissingError } from "../types";
import { runFolderSync } from "../syncEngine";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const FOLDER = "application/vnd.google-apps.folder";

/** A fake Drive: parents map folder id -> children. */
function drive(tree: Record<string, unknown[]>, over: { root?: Record<string, unknown> } = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/files") && url.searchParams.get("q")) {
      const parent = /'([^']+)' in parents/.exec(url.searchParams.get("q") as string)?.[1] as string;
      const onlyFolders = (url.searchParams.get("q") as string).includes(FOLDER);
      const kids = (tree[parent] ?? []).filter((k) => !onlyFolders || (k as { mimeType: string }).mimeType === FOLDER);
      return json({ files: kids });
    }
    const id = decodeURIComponent(url.pathname.split("/files/")[1].split("/")[0]);
    if (url.pathname.endsWith("/export")) return new Response("EXPORTED-PDF");
    if (url.searchParams.get("alt") === "media") return new Response(`BYTES-${id}`);
    if (id === "gone") return json({ error: "nf" }, 404);
    return json(over.root ?? { id, name: "Belege", mimeType: FOLDER });
  });
}

const make = (f: ReturnType<typeof drive>, refresh = vi.fn(async () => "fresh")) =>
  new GoogleDriveProvider({ accessToken: "tok", refreshAccessToken: refresh, fetchImpl: f as unknown as typeof fetch });

describe("GoogleDriveProvider", () => {
  it("walks subfolders and builds paths, reading md5 or version as the rev", async () => {
    const f = drive({
      root: [
        { id: "f1", name: "a.pdf", mimeType: "application/pdf", size: "10", md5Checksum: "m1" },
        { id: "d1", name: "2026", mimeType: FOLDER },
      ],
      d1: [{ id: "f2", name: "b.png", mimeType: "image/png", version: "7" }],
    });
    const page = await make(f).listFolder("root");
    expect(page.hasMore).toBe(false);
    expect(page.entries.map((e) => [e.id, e.pathDisplay, e.rev])).toEqual([
      ["f1", "/a.pdf", "m1"],
      ["f2", "/2026/b.png", "v7"],
    ]);
  });

  it("delivers Google Docs as PDF and skips what cannot be exported", async () => {
    const f = drive({
      root: [
        { id: "g1", name: "Rechnung", mimeType: "application/vnd.google-apps.document", version: "3" },
        { id: "g2", name: "Link", mimeType: "application/vnd.google-apps.shortcut" },
        { id: "g3", name: "Form", mimeType: "application/vnd.google-apps.form" },
      ],
    });
    const p = make(f);
    const page = await p.listFolder("root");
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({ name: "Rechnung.pdf", mimeType: "application/pdf" });
    expect((await p.download(page.entries[0])).toString()).toBe("EXPORTED-PDF");
  });

  it("downloads stored files with alt=media", async () => {
    const f = drive({ root: [{ id: "f1", name: "a.pdf", mimeType: "application/pdf", md5Checksum: "m" }] });
    const p = make(f);
    const [e] = (await p.listFolder("root")).entries;
    expect((await p.download(e)).toString()).toBe("BYTES-f1");
  });

  it("a folder cycle terminates", async () => {
    const f = drive({
      root: [{ id: "d1", name: "x", mimeType: FOLDER }],
      d1: [{ id: "root", name: "loop", mimeType: FOLDER }],
    });
    expect((await make(f).listFolder("root")).entries).toEqual([]);
  });

  it("a missing, trashed or non-folder target is FolderMissingError, never an empty listing", async () => {
    await expect(make(drive({})).listFolder("gone")).rejects.toBeInstanceOf(FolderMissingError);
    await expect(
      make(drive({}, { root: { id: "x", name: "n", mimeType: FOLDER, trashed: true } })).listFolder("x")
    ).rejects.toBeInstanceOf(FolderMissingError);
    await expect(
      make(drive({}, { root: { id: "x", name: "n", mimeType: "application/pdf" } })).listFolder("x")
    ).rejects.toBeInstanceOf(FolderMissingError);
  });

  it("a failure halfway through aborts instead of returning a short listing", async () => {
    const f = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.searchParams.get("q")?.includes("'d1'")) return new Response("boom", { status: 500 });
      if (url.searchParams.get("q")) {
        return json({ files: [{ id: "d1", name: "sub", mimeType: FOLDER }] });
      }
      return json({ id: "root", name: "r", mimeType: FOLDER });
    });
    await expect(make(f as ReturnType<typeof drive>).listFolder("root")).rejects.toThrow(/500/);
  });

  it("refreshes once on 401, and a revoked grant is an auth error", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response("x", { status: 401 }))
      .mockResolvedValueOnce(json({ id: "root", name: "r", mimeType: FOLDER }))
      .mockResolvedValue(json({ files: [] }));
    const refresh = vi.fn(async () => "fresh");
    await make(f as ReturnType<typeof drive>, refresh).listFolder("root");
    expect(refresh).toHaveBeenCalledTimes(1);

    const dead = vi.fn(async () => new Response("x", { status: 401 }));
    await expect(
      make(dead as unknown as ReturnType<typeof drive>, vi.fn(async () => { throw new Error("bad"); })).listFolder("root")
    ).rejects.toBeInstanceOf(FolderAuthError);
  });

  it("lists only subfolders for the picker, by id", async () => {
    const f = drive({
      root: [
        { id: "z", name: "Zeta", mimeType: FOLDER },
        { id: "a", name: "Alpha", mimeType: FOLDER },
        { id: "f", name: "x.pdf", mimeType: "application/pdf" },
      ],
    });
    expect(await make(f).listSubfolders("root")).toEqual([
      { name: "Alpha", path: "a" },
      { name: "Zeta", path: "z" },
    ]);
  });
});

describe("refreshGoogleAccessToken", () => {
  it("returns the token or throws an auth error", async () => {
    expect(await refreshGoogleAccessToken("rt", "id", "s", vi.fn(async () => json({ access_token: "t" })) as unknown as typeof fetch)).toBe("t");
    await expect(
      refreshGoogleAccessToken("rt", "id", "s", vi.fn(async () => json({ error: "invalid_grant" }, 400)) as unknown as typeof fetch)
    ).rejects.toBeInstanceOf(FolderAuthError);
  });
});

describe("stateless listing in the engine", () => {
  it("treats a file missing from the next full listing as gone, with no cursor", async () => {
    const entries = new Map<string, import("../types").FolderEntryState>();
    const log: string[] = [];
    const store = {
      get: async (id: string) => entries.get(id) ?? null,
      put: async (e: import("../types").FolderEntryState) => void entries.set(e.externalId, e),
      list: async () => [...entries.values()],
    };
    let n = 0;
    const files = {
      importFile: async () => ({ fileId: `f${++n}`, duplicate: false }),
      getState: async () => ({ connected: false, deleted: false, alreadyMarkedGone: false }),
      markGone: async () => undefined,
      clearGone: async () => undefined,
      softDelete: async (id: string) => void log.push(`delete ${id}`),
      restore: async () => undefined,
    };
    const f1 = { id: "f1", name: "a.pdf", pathLower: "/a.pdf", pathDisplay: "/a.pdf", isFolder: false, isDeleted: false, rev: "m1", mimeType: "application/pdf" };
    const f2 = { ...f1, id: "f2", name: "b.pdf", pathLower: "/b.pdf", pathDisplay: "/b.pdf" };
    const run = async (list: unknown[]) =>
      runFolderSync({
        folderPath: "root", cursor: null, settings: { removeConnectedFiles: false },
        provider: {
          listsFullyEachRun: true,
          listFolder: async () => ({ entries: list as never, cursor: "", hasMore: false }),
          listContinue: async () => { throw new Error("no"); },
          download: async () => Buffer.from("x"),
          linkFor: () => null,
        },
        store, files, integrationId: "i", userId: "u",
      });
    const first = await run([f1, f2, { ...f1, id: "f3", name: "c.pdf", pathLower: "/c.pdf" }]);
    expect(first.imported).toBe(3);
    expect(first.cursor).toBeNull();
    const second = await run([f1, f2]);
    expect(second.deleted).toBe(1);
    expect(log).toEqual(["delete f3"]);
  });
});
