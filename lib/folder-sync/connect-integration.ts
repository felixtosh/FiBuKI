import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { encrypt, getEncryptionKey } from "@/lib/crypto/encryption";

export class EncryptionNotConfiguredError extends Error {
  constructor() {
    super("Cannot encrypt the grant");
    this.name = "EncryptionNotConfiguredError";
  }
}

/**
 * Create (or re-activate) the Folder Integration for a provider account and
 * store its refresh token encrypted. A grant is never stored in the clear: a
 * missing key stops the connect before anything is written.
 *
 * A reconnect of the same account keeps the chosen folder, the settings and
 * the sync cursor.
 */
export async function saveFolderIntegration(input: {
  userId: string;
  provider: "dropbox" | "gdrive";
  accountId: string;
  accountEmail: string;
  displayName?: string;
  refreshToken: string;
}): Promise<{ integrationId: string }> {
  let encrypted: string;
  let iv: string;
  try {
    ({ encrypted, iv } = encrypt(input.refreshToken, getEncryptionKey()));
  } catch {
    throw new EncryptionNotConfiguredError();
  }

  const db = getAdminDb();
  const now = Timestamp.now();
  const existing = await db
    .collection("folderIntegrations")
    .where("userId", "==", input.userId)
    .where("provider", "==", input.provider)
    .where("accountId", "==", input.accountId)
    .limit(1)
    .get();

  let integrationId: string;
  if (!existing.empty) {
    integrationId = existing.docs[0].id;
    await existing.docs[0].ref.update({
      isActive: true,
      needsReauth: false,
      lastError: null,
      accountEmail: input.accountEmail,
      updatedAt: now,
    });
  } else {
    const ref = db.collection("folderIntegrations").doc();
    integrationId = ref.id;
    await ref.set({
      userId: input.userId,
      provider: input.provider,
      accountId: input.accountId,
      accountEmail: input.accountEmail,
      displayName: input.displayName ?? input.accountEmail,
      folderPath: null,
      folderLabel: null,
      removeConnectedFiles: false,
      isActive: true,
      needsReauth: false,
      pausedReason: null,
      pendingRemovals: 0,
      importedCount: 0,
      unsupportedCount: 0,
      lastError: null,
      lastSyncAt: null,
      syncStartedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  const prior = await db.collection("folderTokens").doc(integrationId).get();
  await db.collection("folderTokens").doc(integrationId).set({
    integrationId,
    userId: input.userId,
    provider: input.provider,
    refreshToken: encrypted,
    refreshTokenIv: iv,
    cursor: prior.exists ? (prior.data()?.cursor ?? null) : null,
    updatedAt: now,
  });

  return { integrationId };
}
