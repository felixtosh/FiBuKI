/**
 * One sync run of a Folder Integration (ADR-0009). Everything it touches is
 * injected, so every rule of the ADR is a unit test.
 */
import crypto from "crypto";
import {
  breakerTripped,
  decideGoneFile,
  type FolderSyncSettings,
} from "./removalPolicy";
import {
  FolderCursorResetError,
  type FolderEntryState,
  type FolderEntryStore,
  type FolderFileGateway,
  type FolderListingEntry,
  type FolderProvider,
} from "./types";

/** What FiBuKI can read. Everything else in the folder is skipped and counted. */
const SUPPORTED: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  tif: "image/tiff",
  tiff: "image/tiff",
};

export function mimeTypeFor(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return null;
  return SUPPORTED[fileName.slice(dot + 1).toLowerCase()] ?? null;
}

const MAX_PAGES = 200;
/** A document bigger than this is not an invoice. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export interface FolderSyncInput {
  folderPath: string;
  cursor: string | null;
  settings: FolderSyncSettings;
  provider: FolderProvider;
  store: FolderEntryStore;
  files: FolderFileGateway;
  integrationId: string;
  userId: string;
  /** The owner confirmed a paused run: carry out its removals once. */
  approvedRemovals?: boolean;
}

export interface FolderSyncResult {
  /** Store this for the next run. Unchanged when the run paused. */
  cursor: string | null;
  imported: number;
  duplicates: number;
  unsupported: number;
  failed: number;
  marked: number;
  deleted: number;
  restored: number;
  /** The breaker stopped the removals; the owner must confirm. */
  paused: boolean;
  pendingRemovals: number;
  errors: string[];
}

const isUnder = (path: string, folder: string) =>
  path === folder || path.startsWith(folder + "/");

export async function runFolderSync(input: FolderSyncInput): Promise<FolderSyncResult> {
  const { provider, store, files, settings } = input;
  const result: FolderSyncResult = {
    cursor: input.cursor,
    imported: 0,
    duplicates: 0,
    unsupported: 0,
    failed: 0,
    marked: 0,
    deleted: 0,
    restored: 0,
    paused: false,
    pendingRemovals: 0,
    errors: [],
  };

  const known = await store.list();
  const byId = new Map(known.map((e) => [e.externalId, e]));

  const liveIds = new Set<string>();
  const deletedPaths: string[] = [];
  let fullListing = input.cursor === null;
  let cursor = input.cursor;

  // === 1. Read the listing, importing as we go ===
  let page;
  try {
    page = cursor ? await provider.listContinue(cursor) : await provider.listFolder(input.folderPath);
  } catch (e) {
    if (!(e instanceof FolderCursorResetError)) throw e;
    fullListing = true;
    cursor = null;
    page = await provider.listFolder(input.folderPath);
  }

  for (let pages = 0; ; pages++) {
    for (const entry of page.entries) {
      if (entry.isDeleted) {
        deletedPaths.push(entry.pathLower);
        continue;
      }
      if (entry.isFolder || !entry.id) continue;
      liveIds.add(entry.id);
      await handleLiveEntry(entry, byId.get(entry.id), input, result, byId);
    }
    cursor = page.cursor;
    if (!page.hasMore) break;
    if (pages >= MAX_PAGES) throw new Error("Folder listing exceeded the page limit");
    page = await provider.listContinue(page.cursor);
  }

  // === 2. Which known files are gone? ===
  const gone: FolderEntryState[] = [];
  for (const entry of byId.values()) {
    if (entry.status === "gone" || liveIds.has(entry.externalId)) continue;
    const removedByPath = deletedPaths.some((p) => isUnder(entry.pathLower, p));
    if (removedByPath || fullListing) gone.push(entry);
  }

  const plan: Array<{ entry: FolderEntryState; action: "mark" | "delete" | "none" }> = [];
  for (const entry of gone) {
    if (!entry.fileId) {
      plan.push({ entry, action: "none" });
      continue;
    }
    const state = await files.getState(entry.fileId);
    plan.push({
      entry,
      action: state ? decideGoneFile(state, settings) : "none",
    });
  }

  // === 3. The breaker ===
  const removals = plan.filter((p) => p.action === "delete").length;
  const importedCount = known.filter((e) => e.status === "imported").length;
  const tripped = !input.approvedRemovals && breakerTripped(removals, importedCount);

  for (const { entry, action } of plan) {
    if (action === "delete" && tripped) continue;
    try {
      if (action === "delete") {
        await files.softDelete(entry.fileId as string);
        result.deleted++;
      } else if (action === "mark") {
        await files.markGone(entry.fileId as string);
        result.marked++;
      }
      await store.put({
        ...entry,
        status: "gone",
        goneAction: action === "delete" ? "deleted" : action === "mark" ? "marked" : "none",
      });
    } catch (e) {
      result.failed++;
      result.errors.push(`gone ${entry.externalId}: ${String(e)}`);
    }
  }

  if (tripped) {
    // Cursor stays put, so the same removals reappear once the owner confirms.
    result.paused = true;
    result.pendingRemovals = removals;
    return result;
  }

  result.cursor = cursor;
  return result;
}

async function handleLiveEntry(
  entry: FolderListingEntry,
  existing: FolderEntryState | undefined,
  input: FolderSyncInput,
  result: FolderSyncResult,
  byId: Map<string, FolderEntryState>
): Promise<void> {
  const { provider, store, files } = input;
  const id = entry.id as string;

  const mimeType = mimeTypeFor(entry.name);
  if (!mimeType || (entry.size ?? 0) > MAX_FILE_BYTES) {
    result.unsupported++;
    return;
  }

  // Back in the folder after being gone (restored from the store's trash).
  if (existing?.status === "gone" && existing.fileId) {
    if (existing.goneAction === "deleted") await files.restore(existing.fileId);
    else if (existing.goneAction === "marked") await files.clearGone(existing.fileId);
    result.restored++;
    const back: FolderEntryState = {
      ...existing,
      pathLower: entry.pathLower,
      pathDisplay: entry.pathDisplay,
      status: "imported",
      goneAction: undefined,
    };
    await store.put(back);
    byId.set(id, back);
    if (existing.rev === entry.rev) return;
  } else if (existing && existing.rev === entry.rev) {
    // A move keeps the id and the rev: only the path changes.
    if (existing.pathLower !== entry.pathLower) {
      const moved = { ...existing, pathLower: entry.pathLower, pathDisplay: entry.pathDisplay };
      await store.put(moved);
      byId.set(id, moved);
    }
    return;
  }

  try {
    const data = await provider.download(entry);
    const contentHash = crypto.createHash("sha256").update(data).digest("hex");
    const { fileId, duplicate } = await files.importFile({
      entry,
      data,
      contentHash,
      mimeType,
      externalUrl: provider.linkFor(entry),
    });
    // A duplicate is a File that is not ours (a hand upload, a mail
    // attachment): the entry must never own it, or a delete at the store would
    // reach a File the store never produced.
    const state: FolderEntryState = {
      integrationId: input.integrationId,
      userId: input.userId,
      externalId: id,
      pathLower: entry.pathLower,
      pathDisplay: entry.pathDisplay,
      rev: entry.rev ?? "",
      fileId: duplicate ? null : fileId,
      status: duplicate ? "duplicate" : "imported",
    };
    await store.put(state);
    byId.set(id, state);
    if (duplicate) result.duplicates++;
    else result.imported++;
  } catch (e) {
    result.failed++;
    result.errors.push(`${entry.pathDisplay}: ${String(e)}`);
  }
}
