/**
 * Runs one Folder Integration against Firestore (ADR-0009): builds the
 * provider from the stored grant, gives the engine its store and file
 * gateway, and writes the outcome back to the integration.
 */
import * as crypto from "crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { buildDownloadUrl } from "../utils/buildDownloadUrl";
import { decrypt } from "../utils/encryption";
import { createFileRecord } from "../files/createFileRecord";
import { performDeleteFile } from "../files/deleteFile";
import { performRestoreFile, SplitPartsLiveError } from "../files/restoreFile";
import { isGeneratedInvoiceFile } from "../files/generatedInvoiceGuard";
import { DropboxProvider, refreshDropboxAccessToken } from "./dropbox/DropboxProvider";
import { GoogleDriveProvider, refreshGoogleAccessToken } from "./gdrive/GoogleDriveProvider";
import { runFolderSync, type FolderSyncResult } from "./syncEngine";
import {
  FolderAuthError,
  FolderMissingError,
  type FolderEntryState,
  FolderEntryStore,
  type FolderFileGateway,
  type FolderProvider,
} from "./types";

export type FolderProviderId = "dropbox" | "gdrive";

export const FOLDER_INTEGRATIONS = "folderIntegrations";
export const FOLDER_TOKENS = "folderTokens";
export const FOLDER_ENTRIES = "folderEntries";

/** A run that has not finished after this long is presumed dead. */
const CLAIM_TTL_MS = 10 * 60 * 1000;

export interface FolderRunnerSecrets {
  dropboxAppKey: string;
  dropboxAppSecret: string;
  googleClientId: string;
  googleClientSecret: string;
  encryptionKey: string;
}

type Db = FirebaseFirestore.Firestore;

export function entryDocId(integrationId: string, externalId: string): string {
  return `${integrationId}_${crypto.createHash("sha1").update(externalId).digest("hex")}`;
}

export function firestoreEntryStore(db: Db, integrationId: string): FolderEntryStore {
  return {
    async get(externalId) {
      const snap = await db.collection(FOLDER_ENTRIES).doc(entryDocId(integrationId, externalId)).get();
      return snap.exists ? (snap.data() as FolderEntryState) : null;
    },
    async put(entry) {
      // Firestore refuses undefined, and goneAction is optional.
      const clean = JSON.parse(JSON.stringify(entry)) as FolderEntryState;
      await db.collection(FOLDER_ENTRIES).doc(entryDocId(integrationId, entry.externalId)).set(clean);
    },
    async list() {
      const snap = await db.collection(FOLDER_ENTRIES).where("integrationId", "==", integrationId).get();
      return snap.docs.map((d) => d.data() as FolderEntryState);
    },
  };
}

export function firestoreFileGateway(
  db: Db,
  integration: { id: string; userId: string; provider: FolderProviderId; accountEmail: string }
): FolderFileGateway {
  const { userId } = integration;

  async function ownFile(fileId: string) {
    const snap = await db.collection("files").doc(fileId).get();
    if (!snap.exists) return null;
    const data = snap.data() as FirebaseFirestore.DocumentData;
    // Ownership is checked at every door that acts on a File by id.
    return data.userId === userId ? { ref: snap.ref, data } : null;
  }

  return {
    async importFile({ entry, data, contentHash, mimeType, externalUrl }) {
      const sanitized = entry.name.replace(/[^a-zA-Z0-9.-]/g, "_");
      const storagePath = `files/${userId}/${Date.now()}_${sanitized}`;
      const bucket = getStorage().bucket();
      const file = bucket.file(storagePath);
      await file.save(data, {
        metadata: {
          contentType: mimeType,
          contentDisposition: "inline",
          metadata: { originalFilename: entry.name, sourceIntegrationId: integration.id },
        },
      });
      const [meta] = await file.getMetadata();
      let token = (meta.metadata as Record<string, string> | undefined)?.firebaseStorageDownloadTokens;
      if (!token) {
        token = crypto.randomUUID();
        await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
      }
      const now = Timestamp.now();
      const { fileId, duplicate } = await createFileRecord(db, {
        userId,
        fileName: entry.name,
        fileType: mimeType,
        fileSize: data.length,
        storagePath,
        downloadUrl: buildDownloadUrl(bucket.name, storagePath, token),
        contentHash,
        sourceType: integration.provider,
        sourceIntegrationId: integration.id,
        sourceExternalId: entry.id,
        ...(externalUrl ? { sourceExternalUrl: externalUrl } : {}),
        sourceDomain: integration.accountEmail,
        extractionComplete: false,
        transactionIds: [],
        uploadedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      if (duplicate) {
        // The bytes were already on file; the upload we just made is waste.
        await file.delete().catch(() => undefined);
      }
      return { fileId, duplicate };
    },

    async getState(fileId) {
      const f = await ownFile(fileId);
      if (!f) return null;
      let connected = Array.isArray(f.data.transactionIds) && f.data.transactionIds.length > 0;
      if (!connected) {
        const c = await db.collection("fileConnections").where("fileId", "==", fileId).limit(1).get();
        connected = !c.empty;
      }
      return {
        connected,
        deleted: Boolean(f.data.deletedAt),
        alreadyMarkedGone: Boolean(f.data.sourceGoneAt),
      };
    },

    async markGone(fileId) {
      const f = await ownFile(fileId);
      if (f) await f.ref.update({ sourceGoneAt: Timestamp.now(), updatedAt: FieldValue.serverTimestamp() });
    },

    async clearGone(fileId) {
      const f = await ownFile(fileId);
      if (f) await f.ref.update({ sourceGoneAt: null, updatedAt: FieldValue.serverTimestamp() });
    },

    async softDelete(fileId) {
      const f = await ownFile(fileId);
      if (!f || isGeneratedInvoiceFile(f.data)) return;
      await performDeleteFile(db, userId, fileId, f.data);
      await f.ref.update({ sourceGoneAt: Timestamp.now() });
    },

    async restore(fileId) {
      const f = await ownFile(fileId);
      if (!f) return;
      try {
        await performRestoreFile(db, userId, fileId, f.data);
      } catch (error) {
        // A Split original stays deleted while its parts live (#550); the
        // bundle coming back at the source does not bring it back either.
        if (!(error instanceof SplitPartsLiveError)) throw error;
      }
      await f.ref.update({ sourceGoneAt: null });
    },
  };
}

/** Claim the integration for one run; false when another run holds it. */
async function claim(db: Db, id: string): Promise<boolean> {
  const ref = db.collection(FOLDER_INTEGRATIONS).doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const started = snap.data()?.syncStartedAt as Timestamp | null | undefined;
    if (started && Date.now() - started.toMillis() < CLAIM_TTL_MS) return false;
    tx.update(ref, { syncStartedAt: Timestamp.now() });
    return true;
  });
}

/** The provider behind an integration, authenticated from its stored grant. */
export function buildProvider(
  provider: FolderProviderId,
  refreshToken: string,
  secrets: FolderRunnerSecrets
): FolderProvider & { listSubfolders(path: string): Promise<Array<{ name: string; path: string }>> } {
  const needed =
    provider === "gdrive"
      ? [secrets.googleClientId, secrets.googleClientSecret]
      : [secrets.dropboxAppKey, secrets.dropboxAppSecret];
  if (needed.some((v) => !v)) {
    // A server problem, not the user's grant: it must not read as "reconnect".
    throw new Error(`${provider === "gdrive" ? "Google Drive" : "Dropbox"} is not configured on this server`);
  }
  if (provider === "gdrive") {
    return new GoogleDriveProvider({
      accessToken: "",
      refreshAccessToken: () =>
        refreshGoogleAccessToken(refreshToken, secrets.googleClientId, secrets.googleClientSecret),
    });
  }
  return new DropboxProvider({
    accessToken: "",
    refreshAccessToken: () =>
      refreshDropboxAccessToken(refreshToken, secrets.dropboxAppKey, secrets.dropboxAppSecret),
  });
}

export type SyncOutcome =
  | { status: "skipped"; reason: string }
  | { status: "done"; result: FolderSyncResult };

export async function syncFolderIntegration(
  db: Db,
  integrationId: string,
  secrets: FolderRunnerSecrets,
  opts: {
    approvedRemovals?: boolean;
    /** Only the owner may run; a scheduled run passes null. */
    onlyForUser?: string | null;
    providerOverride?: FolderProvider;
  } = {}
): Promise<SyncOutcome> {
  const ref = db.collection(FOLDER_INTEGRATIONS).doc(integrationId);
  const snap = await ref.get();
  if (!snap.exists) return { status: "skipped", reason: "not-found" };
  const integration = snap.data() as FirebaseFirestore.DocumentData;
  if (opts.onlyForUser && integration.userId !== opts.onlyForUser) {
    return { status: "skipped", reason: "not-found" };
  }
  if (!integration.isActive || integration.needsReauth) return { status: "skipped", reason: "inactive" };
  if (integration.folderPath == null) return { status: "skipped", reason: "no-folder" };
  if (integration.pausedReason && !opts.approvedRemovals) return { status: "skipped", reason: "paused" };
  if (!(await claim(db, integrationId))) return { status: "skipped", reason: "running" };

  try {
    const tokenSnap = await db.collection(FOLDER_TOKENS).doc(integrationId).get();
    const tokens = tokenSnap.data();
    if (!tokens || tokens.userId !== integration.userId) {
      throw new FolderAuthError("No stored grant");
    }

    let provider = opts.providerOverride;
    if (!provider) {
      const refreshToken = decrypt(tokens.refreshToken, tokens.refreshTokenIv, secrets.encryptionKey);
      provider = buildProvider(integration.provider, refreshToken, secrets);
    }

    const result = await runFolderSync({
      folderPath: integration.folderPath,
      cursor: (tokens.cursor as string | null) ?? null,
      settings: { removeConnectedFiles: Boolean(integration.removeConnectedFiles) },
      provider,
      store: firestoreEntryStore(db, integrationId),
      files: firestoreFileGateway(db, {
        id: integrationId,
        userId: integration.userId,
        provider: integration.provider,
        accountEmail: integration.accountEmail,
      }),
      integrationId,
      userId: integration.userId,
      approvedRemovals: opts.approvedRemovals,
    });

    await db.collection(FOLDER_TOKENS).doc(integrationId).update({ cursor: result.cursor });
    const entries = await firestoreEntryStore(db, integrationId).list();
    await ref.update({
      syncStartedAt: null,
      lastSyncAt: Timestamp.now(),
      lastError: result.errors.length ? result.errors[0].slice(0, 300) : null,
      pausedReason: result.paused ? "removals" : null,
      pendingRemovals: result.paused ? result.pendingRemovals : 0,
      importedCount: entries.filter((e) => e.status === "imported").length,
      unsupportedCount: result.unsupported,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { status: "done", result };
  } catch (e) {
    const patch: Record<string, unknown> = {
      syncStartedAt: null,
      lastError: String(e instanceof Error ? e.message : e).slice(0, 300),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (e instanceof FolderAuthError) patch.needsReauth = true;
    // A missing folder is an integration problem, never "the files are gone".
    if (e instanceof FolderMissingError) patch.pausedReason = "folderMissing";
    await ref.update(patch);
    throw e;
  }
}
