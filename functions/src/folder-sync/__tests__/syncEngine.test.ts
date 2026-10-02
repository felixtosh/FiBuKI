import { describe, expect, it } from "vitest";
import { runFolderSync, mimeTypeFor } from "../syncEngine";
import {
  FolderCursorResetError,
  type FolderEntryState,
  type FolderFileGateway,
  type FolderListingEntry,
  type FolderListingPage,
  type FolderProvider,
} from "../types";

const live = (id: string, path: string, rev = "r1", size = 100): FolderListingEntry => ({
  id,
  name: path.split("/").pop() as string,
  pathLower: path.toLowerCase(),
  pathDisplay: path,
  isFolder: false,
  isDeleted: false,
  size,
  rev,
});
const removed = (path: string): FolderListingEntry => ({
  id: null,
  name: path.split("/").pop() as string,
  pathLower: path.toLowerCase(),
  pathDisplay: path,
  isFolder: false,
  isDeleted: true,
});

function world(opts: { connected?: string[]; duplicateOf?: string[] } = {}) {
  const entries = new Map<string, FolderEntryState>();
  const fileState = new Map<string, { connected: boolean; deleted: boolean; gone: boolean }>();
  const log: string[] = [];
  let n = 0;
  const hashes = new Map<string, string>();

  const store = {
    get: async (id: string) => entries.get(id) ?? null,
    put: async (e: FolderEntryState) => void entries.set(e.externalId, e),
    list: async () => [...entries.values()],
  };
  const files: FolderFileGateway = {
    async importFile({ entry, contentHash }) {
      if (opts.duplicateOf?.includes(entry.id as string)) {
        return { fileId: "someone-elses", duplicate: true };
      }
      const fileId = `f${++n}`;
      hashes.set(fileId, contentHash);
      fileState.set(fileId, {
        connected: Boolean(opts.connected?.includes(entry.id as string)),
        deleted: false,
        gone: false,
      });
      return { fileId, duplicate: false };
    },
    async getState(id) {
      const s = fileState.get(id);
      return s ? { connected: s.connected, deleted: s.deleted, alreadyMarkedGone: s.gone } : null;
    },
    async markGone(id) {
      log.push(`mark ${id}`);
      fileState.get(id)!.gone = true;
    },
    async clearGone(id) {
      log.push(`clear ${id}`);
      fileState.get(id)!.gone = false;
    },
    async softDelete(id) {
      log.push(`delete ${id}`);
      fileState.get(id)!.deleted = true;
    },
    async restore(id) {
      log.push(`restore ${id}`);
      fileState.get(id)!.deleted = false;
    },
  };
  return { store, files, entries, fileState, log };
}

function provider(pages: FolderListingPage[], opts: { resetOnContinue?: boolean } = {}): FolderProvider {
  const queue = [...pages];
  return {
    async listFolder() {
      return queue.shift() as FolderListingPage;
    },
    async listContinue() {
      if (opts.resetOnContinue) {
        opts.resetOnContinue = false;
        throw new FolderCursorResetError();
      }
      return queue.shift() as FolderListingPage;
    },
    async download(entry) {
      return Buffer.from(`bytes-of-${entry.id}-${entry.rev}`);
    },
    linkFor: (e) => `https://example.test${e.pathDisplay}`,
  };
}

const page = (entries: FolderListingEntry[], cursor = "c1", hasMore = false): FolderListingPage => ({
  entries,
  cursor,
  hasMore,
});

const base = (w: ReturnType<typeof world>, p: FolderProvider, over = {}) => ({
  folderPath: "/Belege",
  cursor: null as string | null,
  settings: { removeConnectedFiles: false },
  provider: p,
  store: w.store,
  files: w.files,
  integrationId: "int1",
  userId: "u1",
  ...over,
});

describe("mimeTypeFor", () => {
  it("reads PDFs and images, nothing else", () => {
    expect(mimeTypeFor("a.PDF")).toBe("application/pdf");
    expect(mimeTypeFor("a.jpeg")).toBe("image/jpeg");
    expect(mimeTypeFor("a.docx")).toBeNull();
    expect(mimeTypeFor("noext")).toBeNull();
  });
});

describe("import", () => {
  it("imports supported files, counts the rest as unsupported", async () => {
    const w = world();
    const r = await runFolderSync(
      base(w, provider([page([live("id:1", "/Belege/a.pdf"), live("id:2", "/Belege/notes.docx")])]))
    );
    expect(r.imported).toBe(1);
    expect(r.unsupported).toBe(1);
    expect(r.cursor).toBe("c1");
    expect(w.entries.get("id:1")?.status).toBe("imported");
  });

  it("does not download a file again when its rev is unchanged", async () => {
    const w = world();
    await runFolderSync(base(w, provider([page([live("id:1", "/Belege/a.pdf")])])));
    const r = await runFolderSync(
      base(w, provider([page([live("id:1", "/Belege/a.pdf")])]), { cursor: "c1" })
    );
    expect(r.imported).toBe(0);
  });

  it("follows pages to the end", async () => {
    const w = world();
    const r = await runFolderSync(
      base(
        w,
        provider([
          page([live("id:1", "/Belege/a.pdf")], "c1", true),
          page([live("id:2", "/Belege/b.pdf")], "c2", false),
        ])
      )
    );
    expect(r.imported).toBe(2);
    expect(r.cursor).toBe("c2");
  });

  it("a duplicate of a File that is not ours is never owned by the entry", async () => {
    const w = world({ duplicateOf: ["id:1"] });
    const r = await runFolderSync(base(w, provider([page([live("id:1", "/Belege/a.pdf")])])));
    expect(r.duplicates).toBe(1);
    expect(w.entries.get("id:1")).toMatchObject({ status: "duplicate", fileId: null });

    // Deleting it at the store must not touch the File that was already there.
    const r2 = await runFolderSync(
      base(w, provider([page([removed("/Belege/a.pdf")], "c2")]), { cursor: "c1" })
    );
    expect(r2.deleted + r2.marked).toBe(0);
    expect(w.log).toEqual([]);
  });

  it("one failing download does not stop the run", async () => {
    const w = world();
    const p = provider([page([live("id:1", "/Belege/a.pdf"), live("id:2", "/Belege/b.pdf")])]);
    const orig = p.download.bind(p);
    p.download = async (e) => {
      if (e.id === "id:1") throw new Error("boom");
      return orig(e);
    };
    const r = await runFolderSync(base(w, p));
    expect(r.failed).toBe(1);
    expect(r.imported).toBe(1);
  });
});

describe("a file disappears (ADR-0009)", () => {
  async function seeded(opts: { connected?: string[] } = {}) {
    const w = world(opts);
    await runFolderSync(
      base(w, provider([page([live("id:1", "/Belege/a.pdf"), live("id:2", "/Belege/sub/b.pdf")])]))
    );
    return w;
  }

  it("deletes an unconnected File, reversibly, by path", async () => {
    const w = await seeded();
    const r = await runFolderSync(
      base(w, provider([page([removed("/Belege/a.pdf")], "c2")]), { cursor: "c1" })
    );
    expect(r.deleted).toBe(1);
    expect(w.log).toEqual(["delete f1"]);
    expect(w.entries.get("id:1")?.status).toBe("gone");
  });

  it("a deleted folder takes its files with it", async () => {
    const w = await seeded();
    const r = await runFolderSync(
      base(w, provider([page([removed("/Belege/sub")], "c2")]), { cursor: "c1" })
    );
    expect(r.deleted).toBe(1);
    expect(w.log).toEqual(["delete f2"]);
  });

  it("keeps a connected File and marks it", async () => {
    const w = await seeded({ connected: ["id:1"] });
    const r = await runFolderSync(
      base(w, provider([page([removed("/Belege/a.pdf")], "c2")]), { cursor: "c1" })
    );
    expect(r.marked).toBe(1);
    expect(w.log).toEqual(["mark f1"]);
    expect(w.fileState.get("f1")?.deleted).toBe(false);
  });

  it("deletes a connected File only with the toggle on", async () => {
    const w = await seeded({ connected: ["id:1"] });
    const r = await runFolderSync(
      base(w, provider([page([removed("/Belege/a.pdf")], "c2")]), {
        cursor: "c1",
        settings: { removeConnectedFiles: true },
      })
    );
    expect(r.deleted).toBe(1);
  });

  it("a move inside the folder is not a removal", async () => {
    const w = await seeded();
    const r = await runFolderSync(
      base(
        w,
        provider([page([removed("/Belege/a.pdf"), live("id:1", "/Belege/2026/a.pdf")], "c2")]),
        { cursor: "c1" }
      )
    );
    expect(r.deleted + r.marked).toBe(0);
    expect(w.entries.get("id:1")).toMatchObject({ status: "imported", pathLower: "/belege/2026/a.pdf" });
  });

  it("a file that returns is restored", async () => {
    const w = await seeded();
    await runFolderSync(base(w, provider([page([removed("/Belege/a.pdf")], "c2")]), { cursor: "c1" }));
    const r = await runFolderSync(
      base(w, provider([page([live("id:1", "/Belege/a.pdf")], "c3")]), { cursor: "c2" })
    );
    expect(r.restored).toBe(1);
    expect(w.log).toEqual(["delete f1", "restore f1"]);
    expect(w.entries.get("id:1")?.status).toBe("imported");
  });

  it("a marked File that returns loses its mark and is not restored", async () => {
    const w = await seeded({ connected: ["id:1"] });
    await runFolderSync(base(w, provider([page([removed("/Belege/a.pdf")], "c2")]), { cursor: "c1" }));
    await runFolderSync(base(w, provider([page([live("id:1", "/Belege/a.pdf")], "c3")]), { cursor: "c2" }));
    expect(w.log).toEqual(["mark f1", "clear f1"]);
  });

  it("a reset cursor re-lists and treats what is missing as gone", async () => {
    const w = await seeded();
    const r = await runFolderSync(
      base(
        w,
        provider([page([live("id:2", "/Belege/sub/b.pdf")], "c9")], { resetOnContinue: true }),
        { cursor: "stale" }
      )
    );
    expect(r.deleted).toBe(1);
    expect(w.log).toEqual(["delete f1"]);
    expect(r.cursor).toBe("c9");
  });
});

describe("circuit breaker", () => {
  async function bigFolder(count: number) {
    const w = world();
    await runFolderSync(
      base(
        w,
        provider([page(Array.from({ length: count }, (_, i) => live(`id:${i}`, `/Belege/f${i}.pdf`)))])
      )
    );
    return w;
  }

  it("pauses instead of deleting when a run would remove too many", async () => {
    const w = await bigFolder(8);
    const r = await runFolderSync(
      base(w, provider([page([removed("/Belege/f0.pdf"), removed("/Belege/f1.pdf"), removed("/Belege/f2.pdf"), removed("/Belege/f3.pdf")], "c2")]), {
        cursor: "c1",
      })
    );
    expect(r.paused).toBe(true);
    expect(r.pendingRemovals).toBe(4);
    expect(r.deleted).toBe(0);
    expect(r.cursor).toBe("c1");
    expect(w.log).toEqual([]);
  });

  it("carries the removals out once the owner approved", async () => {
    const w = await bigFolder(8);
    const gone = [0, 1, 2, 3].map((i) => removed(`/Belege/f${i}.pdf`));
    const r = await runFolderSync(
      base(w, provider([page(gone, "c2")]), { cursor: "c1", approvedRemovals: true })
    );
    expect(r.paused).toBe(false);
    expect(r.deleted).toBe(4);
    expect(r.cursor).toBe("c2");
  });

  it("an emptied folder (everything gone) always pauses", async () => {
    const w = await bigFolder(30);
    const r = await runFolderSync(
      base(w, provider([page([], "c9")], { resetOnContinue: true }), { cursor: "stale" })
    );
    expect(r.paused).toBe(true);
    expect(r.pendingRemovals).toBe(30);
  });
});
