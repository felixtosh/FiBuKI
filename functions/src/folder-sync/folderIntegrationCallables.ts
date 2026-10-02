/**
 * Callables behind the Folder Integration screen (ADR-0009). Every one loads
 * the integration by id and refuses one the caller does not own, with the same
 * answer as for one that does not exist.
 */
import { Timestamp } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { decrypt } from "../utils/encryption";
import {
  FOLDER_ENTRIES,
  FOLDER_INTEGRATIONS,
  FOLDER_TOKENS,
  buildProvider,
  syncFolderIntegration,
} from "./folderSyncRunner";
import { folderSecretParams, readFolderSecrets } from "./folderSecrets";

type Db = FirebaseFirestore.Firestore;

async function ownedIntegration(db: Db, userId: string, integrationId: unknown) {
  if (typeof integrationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(integrationId)) {
    throw new HttpsError("invalid-argument", "integrationId is required");
  }
  const ref = db.collection(FOLDER_INTEGRATIONS).doc(integrationId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.userId !== userId) {
    throw new HttpsError("not-found", "Integration not found");
  }
  return { ref, data: snap.data() as FirebaseFirestore.DocumentData };
}

/**
 * Dropbox folders are paths, Drive folders are ids. Either way the value ends
 * up in a request to the provider, so it is checked here.
 */
export function validFolderRef(provider: unknown, ref: unknown): boolean {
  if (typeof ref !== "string") return false;
  if (provider === "gdrive") return /^[A-Za-z0-9_-]{1,100}$/.test(ref);
  return ref.length <= 1000 && !ref.includes("..") && (ref === "" || ref.startsWith("/"));
}

function summarize(outcome: Awaited<ReturnType<typeof syncFolderIntegration>>) {
  if (outcome.status === "skipped") return { skipped: outcome.reason };
  const r = outcome.result;
  return {
    imported: r.imported,
    duplicates: r.duplicates,
    unsupported: r.unsupported,
    failed: r.failed,
    marked: r.marked,
    deleted: r.deleted,
    restored: r.restored,
    paused: r.paused,
    pendingRemovals: r.pendingRemovals,
  };
}

export const listFolderChoicesCallable = createCallable<
  { integrationId: string; path?: string },
  { folders: Array<{ name: string; path: string }> }
>(
  { name: "listFolderChoices", timeoutSeconds: 60, secrets: folderSecretParams },
  async (ctx, request) => {
    const { data } = await ownedIntegration(ctx.db, ctx.userId, request.integrationId);
    const isDrive = data.provider === "gdrive";
    const path = typeof request.path === "string" && request.path ? request.path : isDrive ? "root" : "";
    if (!validFolderRef(data.provider, path)) throw new HttpsError("invalid-argument", "Invalid path");
    const secrets = readFolderSecrets();
    const tokenSnap = await ctx.db.collection(FOLDER_TOKENS).doc(request.integrationId).get();
    const tokens = tokenSnap.data();
    if (!tokens || tokens.userId !== ctx.userId) {
      throw new HttpsError("failed-precondition", "Not connected");
    }
    const refreshToken = decrypt(tokens.refreshToken, tokens.refreshTokenIv, secrets.encryptionKey);
    const provider = buildProvider(data.provider, refreshToken, secrets);
    return { folders: await provider.listSubfolders(path) };
  }
);

export const setFolderIntegrationFolderCallable = createCallable<
  { integrationId: string; path: string; label?: string },
  { success: boolean; sync: Record<string, unknown> }
>(
  { name: "setFolderIntegrationFolder", timeoutSeconds: 300, memory: "1GiB", secrets: folderSecretParams },
  async (ctx, request) => {
    const { ref, data } = await ownedIntegration(ctx.db, ctx.userId, request.integrationId);
    if (!validFolderRef(data.provider, request.path)) {
      throw new HttpsError("invalid-argument", "path is required");
    }
    const label =
      typeof request.label === "string" && request.label.trim()
        ? request.label.trim().slice(0, 200)
        : request.path === ""
          ? "/"
          : request.path;
    // A new folder starts from a fresh listing. Files already imported stay.
    await ctx.db.collection(FOLDER_TOKENS).doc(request.integrationId).update({ cursor: null });
    await ref.update({
      folderPath: request.path,
      folderLabel: label,
      pausedReason: null,
      pendingRemovals: 0,
      updatedAt: Timestamp.now(),
    });
    // Existing entries from the previous folder must not be judged against the
    // new listing, or switching folders would read as "everything was deleted".
    const old = await ctx.db.collection(FOLDER_ENTRIES).where("integrationId", "==", request.integrationId).get();
    for (let i = 0; i < old.docs.length; i += 400) {
      const batch = ctx.db.batch();
      old.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    const outcome = await syncFolderIntegration(ctx.db, request.integrationId, readFolderSecrets(), {
      onlyForUser: ctx.userId,
    });
    return { success: true, sync: summarize(outcome) };
  }
);

export const updateFolderIntegrationSettingsCallable = createCallable<
  { integrationId: string; removeConnectedFiles: boolean },
  { success: boolean }
>({ name: "updateFolderIntegrationSettings" }, async (ctx, request) => {
  const { ref } = await ownedIntegration(ctx.db, ctx.userId, request.integrationId);
  if (typeof request.removeConnectedFiles !== "boolean") {
    throw new HttpsError("invalid-argument", "removeConnectedFiles must be a boolean");
  }
  await ref.update({
    removeConnectedFiles: request.removeConnectedFiles,
    updatedAt: Timestamp.now(),
  });
  return { success: true };
});

export const syncFolderIntegrationCallable = createCallable<
  { integrationId: string; approveRemovals?: boolean },
  { success: boolean; sync: Record<string, unknown> }
>(
  { name: "syncFolderIntegration", timeoutSeconds: 300, memory: "1GiB", secrets: folderSecretParams },
  async (ctx, request) => {
    await ownedIntegration(ctx.db, ctx.userId, request.integrationId);
    const outcome = await syncFolderIntegration(ctx.db, request.integrationId, readFolderSecrets(), {
      onlyForUser: ctx.userId,
      approvedRemovals: request.approveRemovals === true,
    });
    return { success: true, sync: summarize(outcome) };
  }
);

export const disconnectFolderIntegrationCallable = createCallable<
  { integrationId: string },
  { success: boolean }
>({ name: "disconnectFolderIntegration" }, async (ctx, request) => {
  const { ref } = await ownedIntegration(ctx.db, ctx.userId, request.integrationId);
  // Files stay: disconnecting stops the sync, it does not unimport anything.
  await ctx.db.collection(FOLDER_TOKENS).doc(request.integrationId).delete();
  const entries = await ctx.db.collection(FOLDER_ENTRIES).where("integrationId", "==", request.integrationId).get();
  for (let i = 0; i < entries.docs.length; i += 400) {
    const batch = ctx.db.batch();
    entries.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  await ref.update({ isActive: false, syncStartedAt: null, updatedAt: Timestamp.now() });
  return { success: true };
});

/** Keep every connected folder current. One at a time: a failure in one never blocks the rest. */
export const syncFolderIntegrations = onSchedule(
  {
    schedule: "*/15 * * * *",
    timeZone: "Europe/Vienna",
    region: "europe-west1",
    memory: "1GiB",
    timeoutSeconds: 540,
    secrets: folderSecretParams,
  },
  async () => {
    const db = getFirestore();
    const snap = await db.collection(FOLDER_INTEGRATIONS).where("isActive", "==", true).get();
    const secrets = readFolderSecrets();
    const deadline = Date.now() + 480_000;
    for (const doc of snap.docs) {
      if (Date.now() > deadline) break;
      try {
        await syncFolderIntegration(db, doc.id, secrets);
      } catch (e) {
        console.error(`[FolderSync] ${doc.id} failed:`, e);
      }
    }
  }
);
