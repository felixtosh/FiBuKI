import { Timestamp } from "firebase/firestore";

/**
 * A Folder Integration: one folder in a cloud store, kept in step with FiBuKI's
 * Files (ADR-0009). Collection: /folderIntegrations/{id}. Written only by the
 * connect routes and callables; the screen reads it.
 */
export type FolderProvider = "dropbox" | "gdrive";

/** Why syncing stopped on its own. */
export type FolderPausedReason =
  /** One run would have removed too many Files (the circuit breaker). */
  | "removals"
  /** The chosen folder no longer exists at the provider. */
  | "folderMissing";

export interface FolderIntegration {
  id: string;
  userId: string;
  provider: FolderProvider;
  accountId: string;
  accountEmail: string;
  displayName?: string;
  /**
   * The chosen folder; null until one is chosen. A Dropbox path ("" for the
   * whole Dropbox) or a Drive folder id ("root" for My Drive).
   */
  folderPath: string | null;
  folderLabel: string | null;
  /** Also delete Files connected to a Transaction when deleted at the provider. */
  removeConnectedFiles: boolean;
  isActive: boolean;
  needsReauth: boolean;
  pausedReason: FolderPausedReason | null;
  /** Removals waiting for the owner's confirmation (pausedReason "removals"). */
  pendingRemovals: number;
  importedCount: number;
  unsupportedCount: number;
  lastError: string | null;
  lastSyncAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
