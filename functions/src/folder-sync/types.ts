/**
 * The seam between the Folder Integration sync engine and a cloud store
 * (ADR-0009). A provider lists changes and hands over bytes; it never writes
 * to the store. Dropbox is the first; Google Drive implements the same.
 */

/** One file or folder as a listing reports it. */
export interface FolderListingEntry {
  /** The provider's stable id. Absent on a deletion, which only carries a path. */
  id: string | null;
  name: string;
  /** Lower-cased full path in the store; the key deletions are matched by. */
  pathLower: string;
  /** Path as the user wrote it, for display. */
  pathDisplay: string;
  isFolder: boolean;
  isDeleted: boolean;
  size?: number;
  /** Changes whenever the content does. */
  rev?: string;
  modifiedAt?: Date;
  /**
   * The type of the stored document, when the provider knows it better than
   * the file name does (Drive: a Google Doc is delivered as a PDF).
   */
  mimeType?: string;
}

export interface FolderListingPage {
  entries: FolderListingEntry[];
  cursor: string;
  hasMore: boolean;
}

/** The stored cursor is no longer valid; list the folder from scratch. */
export class FolderCursorResetError extends Error {
  constructor() {
    super("Folder cursor was reset by the provider");
    this.name = "FolderCursorResetError";
  }
}

/** The grant is gone or expired for good: the owner must reconnect. */
export class FolderAuthError extends Error {
  constructor(message = "Access to the cloud store was revoked or has expired") {
    super(message);
    this.name = "FolderAuthError";
  }
}

/** The chosen folder no longer exists. Never "the files are gone". */
export class FolderMissingError extends Error {
  constructor() {
    super("The chosen folder no longer exists");
    this.name = "FolderMissingError";
  }
}

export interface FolderProvider {
  /**
   * True when the provider has no change feed: every run lists the whole
   * folder, the cursor is unused, and a known file missing from the listing is
   * gone. A listing that cannot complete must throw, never come back short.
   */
  readonly listsFullyEachRun?: boolean;
  /** First listing of `path`, recursive. */
  listFolder(path: string): Promise<FolderListingPage>;
  /** Changes since `cursor`. Throws FolderCursorResetError when it expired. */
  listContinue(cursor: string): Promise<FolderListingPage>;
  download(entry: FolderListingEntry): Promise<Buffer>;
  /** Link back to the file at the provider. */
  linkFor(entry: FolderListingEntry): string | null;
}

/** What the engine remembers per provider file (collection `folderEntries`). */
export interface FolderEntryState {
  integrationId: string;
  userId: string;
  externalId: string;
  pathLower: string;
  pathDisplay: string;
  rev: string;
  /** The File this entry produced, if it produced one of its own. */
  fileId: string | null;
  /**
   * imported:  became a File of its own
   * duplicate: same bytes were already on file; this entry never owns that File
   * gone:      deleted at the provider
   */
  status: "imported" | "duplicate" | "gone";
  /** For gone: what FiBuKI did about it. */
  goneAction?: "marked" | "deleted" | "none";
}

export interface FolderEntryStore {
  get(externalId: string): Promise<FolderEntryState | null>;
  put(entry: FolderEntryState): Promise<void>;
  /** Every entry of this integration. */
  list(): Promise<FolderEntryState[]>;
}

export interface FileStateForSync {
  connected: boolean;
  deleted: boolean;
  alreadyMarkedGone: boolean;
}

export interface FolderFileGateway {
  /** Store the bytes as a File. `duplicate` when these bytes were already on file. */
  importFile(input: {
    entry: FolderListingEntry;
    data: Buffer;
    contentHash: string;
    mimeType: string;
    externalUrl: string | null;
  }): Promise<{ fileId: string; duplicate: boolean }>;
  /** Null when the File no longer exists. */
  getState(fileId: string): Promise<FileStateForSync | null>;
  markGone(fileId: string): Promise<void>;
  clearGone(fileId: string): Promise<void>;
  /** The reversible delete of ADR-0006. */
  softDelete(fileId: string): Promise<void>;
  restore(fileId: string): Promise<void>;
}
