/**
 * Dropbox as a Folder Provider (ADR-0009). Read-only: it lists, downloads and
 * lists folders for the picker. Talks to Dropbox through fetch alone.
 */
import {
  FolderAuthError,
  FolderCursorResetError,
  FolderMissingError,
  type FolderListingEntry,
  type FolderListingPage,
  type FolderProvider,
} from "../types";

const API = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";
export const DROPBOX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";

export { FolderAuthError as DropboxAuthError, FolderMissingError } from "../types";

export interface DropboxProviderOptions {
  /** Empty to mint one on first use. */
  accessToken: string;
  /** Mint a new access token from the refresh token. Called once per 401. */
  refreshAccessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

interface DropboxEntry {
  ".tag": "file" | "folder" | "deleted";
  id?: string;
  name: string;
  path_lower?: string;
  path_display?: string;
  rev?: string;
  size?: number;
  server_modified?: string;
}

export class DropboxProvider implements FolderProvider {
  private accessToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: DropboxProviderOptions) {
    this.accessToken = opts.accessToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async listFolder(path: string): Promise<FolderListingPage> {
    return this.toPage(
      await this.rpc("/files/list_folder", {
        path,
        recursive: true,
        include_deleted: false,
        include_non_downloadable_files: false,
        limit: 2000,
      })
    );
  }

  async listContinue(cursor: string): Promise<FolderListingPage> {
    return this.toPage(await this.rpc("/files/list_folder/continue", { cursor }));
  }

  /** Subfolders of `path` (one level), for the folder picker. */
  async listSubfolders(path: string): Promise<Array<{ name: string; path: string }>> {
    const folders: Array<{ name: string; path: string }> = [];
    let page = (await this.rpc("/files/list_folder", {
      path,
      recursive: false,
      limit: 2000,
    })) as { entries: DropboxEntry[]; cursor: string; has_more: boolean };
    for (;;) {
      for (const e of page.entries) {
        if (e[".tag"] === "folder") folders.push({ name: e.name, path: e.path_display ?? "" });
      }
      if (!page.has_more) break;
      page = (await this.rpc("/files/list_folder/continue", { cursor: page.cursor })) as typeof page;
    }
    return folders.sort((a, b) => a.name.localeCompare(b.name));
  }

  async download(entry: FolderListingEntry): Promise<Buffer> {
    if (!entry.id) throw new Error("Cannot download an entry without an id");
    await this.ensureToken();
    const send = () =>
      this.fetchImpl(`${CONTENT}/files/download`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Dropbox-API-Arg": JSON.stringify({ path: entry.id }),
        },
      });
    let res = await send();
    if (res.status === 401) {
      await this.refresh();
      res = await send();
    }
    if (!res.ok) throw await this.errorFrom(res);
    return Buffer.from(await res.arrayBuffer());
  }

  linkFor(entry: FolderListingEntry): string | null {
    const path = entry.pathDisplay;
    return path ? `https://www.dropbox.com/home${encodeURI(path)}` : null;
  }

  // --- internals ---

  private toPage(raw: unknown): FolderListingPage {
    const r = raw as { entries: DropboxEntry[]; cursor: string; has_more: boolean };
    return {
      cursor: r.cursor,
      hasMore: r.has_more,
      entries: r.entries.map((e) => ({
        id: e.id ?? null,
        name: e.name,
        pathLower: e.path_lower ?? "",
        pathDisplay: e.path_display ?? e.path_lower ?? "",
        isFolder: e[".tag"] === "folder",
        isDeleted: e[".tag"] === "deleted",
        size: e.size,
        rev: e.rev,
        modifiedAt: e.server_modified ? new Date(e.server_modified) : undefined,
      })),
    };
  }

  private async ensureToken(): Promise<void> {
    if (!this.accessToken) await this.refresh();
  }

  private async rpc(endpoint: string, body: unknown): Promise<unknown> {
    await this.ensureToken();
    const send = () =>
      this.fetchImpl(`${API}${endpoint}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    let res = await send();
    if (res.status === 401) {
      await this.refresh();
      res = await send();
    }
    if (!res.ok) throw await this.errorFrom(res, endpoint);
    return res.json();
  }

  private async refresh(): Promise<void> {
    try {
      this.accessToken = await this.opts.refreshAccessToken();
    } catch {
      throw new FolderAuthError();
    }
  }

  private async errorFrom(res: Response, endpoint?: string): Promise<Error> {
    const text = await res.text().catch(() => "");
    if (res.status === 401) return new FolderAuthError();
    if (res.status === 409) {
      if (endpoint === "/files/list_folder/continue" && /reset/.test(text)) {
        return new FolderCursorResetError();
      }
      if (/not_found|not_folder/.test(text)) return new FolderMissingError();
    }
    return new Error(`Dropbox ${res.status}: ${text.slice(0, 300)}`);
  }
}

/** Exchange a refresh token for a fresh access token. */
export async function refreshDropboxAccessToken(
  refreshToken: string,
  appKey: string,
  appSecret: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const res = await fetchImpl(DROPBOX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: appKey,
      client_secret: appSecret,
    }),
  });
  if (!res.ok) throw new FolderAuthError();
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new FolderAuthError();
  return json.access_token;
}
