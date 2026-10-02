/**
 * Google Drive as a Folder Provider (ADR-0009). Read-only (`drive.readonly`).
 *
 * Drive has no change feed scoped to one folder tree, so this provider lists
 * the whole tree on every run (`listsFullyEachRun`) and the engine reads a
 * known file missing from it as gone. That only works if a listing is never
 * short: any error aborts the run, nothing is returned partially.
 */
import {
  FolderAuthError,
  FolderMissingError,
  type FolderListingEntry,
  type FolderListingPage,
  type FolderProvider,
} from "../types";

const API = "https://www.googleapis.com/drive/v3";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const NATIVE_PREFIX = "application/vnd.google-apps.";
/** Docs, Sheets and Slides come out as PDF; other native types have no export. */
const EXPORTABLE = new Set([
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
]);

/** A tree this large is a mistake in the folder choice, not a receipts folder. */
const MAX_FOLDERS = 2000;
const MAX_ENTRIES = 50_000;

export interface GoogleDriveProviderOptions {
  accessToken: string;
  refreshAccessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  md5Checksum?: string;
  version?: string;
  modifiedTime?: string;
  trashed?: boolean;
}

const FILE_FIELDS = "id,name,mimeType,size,md5Checksum,version,modifiedTime,trashed";

export class GoogleDriveProvider implements FolderProvider {
  readonly listsFullyEachRun = true;
  private accessToken: string;
  private readonly fetchImpl: typeof fetch;
  /** id -> the Drive mimeType, so download knows whether to export. */
  private readonly driveMime = new Map<string, string>();

  constructor(private readonly opts: GoogleDriveProviderOptions) {
    this.accessToken = opts.accessToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** `folderId` is a Drive folder id, or "root" for My Drive. */
  async listFolder(folderId: string): Promise<FolderListingPage> {
    const root = await this.get<DriveFile>(`/files/${encodeURIComponent(folderId)}`, {
      fields: "id,name,mimeType,trashed",
    });
    if (root.mimeType !== FOLDER_MIME || root.trashed) throw new FolderMissingError();

    const entries: FolderListingEntry[] = [];
    const queue: Array<{ id: string; path: string }> = [{ id: root.id, path: "" }];
    const seen = new Set([root.id]);
    let folders = 0;

    while (queue.length > 0) {
      const dir = queue.shift() as { id: string; path: string };
      if (++folders > MAX_FOLDERS) throw new Error("The folder tree is too large to sync");

      let pageToken: string | undefined;
      do {
        const res = await this.get<{ files: DriveFile[]; nextPageToken?: string }>("/files", {
          q: `'${dir.id}' in parents and trashed = false`,
          fields: `nextPageToken,files(${FILE_FIELDS})`,
          pageSize: "1000",
          supportsAllDrives: "true",
          includeItemsFromAllDrives: "true",
          ...(pageToken ? { pageToken } : {}),
        });
        pageToken = res.nextPageToken;

        for (const f of res.files) {
          const isFolder = f.mimeType === FOLDER_MIME;
          const native = f.mimeType.startsWith(NATIVE_PREFIX) && !isFolder;
          // Shortcuts, Forms, Maps and the like have nothing to download.
          if (native && !EXPORTABLE.has(f.mimeType)) continue;

          const name = native ? `${f.name}.pdf` : f.name;
          const display = `${dir.path}/${name}`;
          if (isFolder) {
            if (!seen.has(f.id)) {
              seen.add(f.id);
              queue.push({ id: f.id, path: `${dir.path}/${f.name}` });
            }
            continue;
          }
          this.driveMime.set(f.id, f.mimeType);
          entries.push({
            id: f.id,
            name,
            pathLower: display.toLowerCase(),
            pathDisplay: display,
            isFolder: false,
            isDeleted: false,
            size: f.size ? Number(f.size) : undefined,
            // md5 for stored files; a version counter for Google's own formats.
            rev: f.md5Checksum ?? `v${f.version ?? f.modifiedTime ?? "0"}`,
            modifiedAt: f.modifiedTime ? new Date(f.modifiedTime) : undefined,
            mimeType: native ? "application/pdf" : f.mimeType,
          });
          if (entries.length > MAX_ENTRIES) throw new Error("The folder holds too many files to sync");
        }
      } while (pageToken);
    }

    return { entries, cursor: "", hasMore: false };
  }

  async listContinue(): Promise<FolderListingPage> {
    // Never called: a full listing has no cursor to continue from.
    throw new Error("Google Drive lists the whole folder each run");
  }

  /** Subfolders of `folderId` (one level), for the folder picker. */
  async listSubfolders(folderId: string): Promise<Array<{ name: string; path: string }>> {
    const folders: Array<{ name: string; path: string }> = [];
    let pageToken: string | undefined;
    do {
      const res = await this.get<{ files: DriveFile[]; nextPageToken?: string }>("/files", {
        q: `'${folderId}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
        fields: "nextPageToken,files(id,name)",
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        ...(pageToken ? { pageToken } : {}),
      });
      pageToken = res.nextPageToken;
      for (const f of res.files) folders.push({ name: f.name, path: f.id });
    } while (pageToken);
    return folders.sort((a, b) => a.name.localeCompare(b.name));
  }

  async download(entry: FolderListingEntry): Promise<Buffer> {
    if (!entry.id) throw new Error("Cannot download an entry without an id");
    const mime = this.driveMime.get(entry.id) ?? entry.mimeType ?? "";
    const exporting = mime.startsWith(NATIVE_PREFIX);
    const path = exporting
      ? `/files/${encodeURIComponent(entry.id)}/export?${new URLSearchParams({ mimeType: "application/pdf" })}`
      : `/files/${encodeURIComponent(entry.id)}?${new URLSearchParams({ alt: "media", supportsAllDrives: "true" })}`;
    const res = await this.send(path);
    if (!res.ok) throw await this.errorFrom(res);
    return Buffer.from(await res.arrayBuffer());
  }

  linkFor(entry: FolderListingEntry): string | null {
    return entry.id ? `https://drive.google.com/file/d/${entry.id}/view` : null;
  }

  // --- internals ---

  private async get<T>(path: string, query: Record<string, string>): Promise<T> {
    const res = await this.send(`${path}?${new URLSearchParams(query)}`);
    if (!res.ok) throw await this.errorFrom(res);
    return (await res.json()) as T;
  }

  private async send(pathWithQuery: string): Promise<Response> {
    if (!this.accessToken) await this.refresh();
    const call = () =>
      this.fetchImpl(`${API}${pathWithQuery}`, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
    let res = await call();
    if (res.status === 401) {
      await this.refresh();
      res = await call();
    }
    return res;
  }

  private async refresh(): Promise<void> {
    try {
      this.accessToken = await this.opts.refreshAccessToken();
    } catch {
      throw new FolderAuthError();
    }
  }

  private async errorFrom(res: Response): Promise<Error> {
    const text = await res.text().catch(() => "");
    if (res.status === 401) return new FolderAuthError();
    if (res.status === 404) return new FolderMissingError();
    if (res.status === 403 && /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/.test(text)) {
      return new FolderAuthError("Google Drive access is missing the read permission");
    }
    return new Error(`Google Drive ${res.status}: ${text.slice(0, 300)}`);
  }
}

/** Exchange a refresh token for a fresh access token. */
export async function refreshGoogleAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new FolderAuthError();
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new FolderAuthError();
  return json.access_token;
}
