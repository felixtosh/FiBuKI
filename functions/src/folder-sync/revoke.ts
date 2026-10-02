/**
 * Revoke a Folder Integration's grant at the provider (ADR-0009), so
 * disconnecting in FiBuKI also ends FiBuKI's access in the user's own Dropbox
 * or Google account, not just our copy of the token.
 *
 * Best effort and never throws: the user asked to disconnect, so a provider
 * that is down or has already invalidated the grant must not block that. The
 * caller learns the outcome and tells the user when it could not be done.
 */
import { decrypt } from "../utils/encryption";
import { refreshDropboxAccessToken } from "./dropbox/DropboxProvider";
import type { FolderProviderId, FolderRunnerSecrets } from "./folderSyncRunner";

export type RevokeOutcome =
  /** The provider confirmed. */
  | "revoked"
  /** The grant was already dead (revoked at the provider, or expired): nothing left to do. */
  | "already-invalid"
  /** Not revoked; the user can do it in their account settings. */
  | "failed";

const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const DROPBOX_REVOKE_URL = "https://api.dropboxapi.com/2/auth/token/revoke";

export async function revokeGrant(
  provider: FolderProviderId,
  refreshToken: string,
  secrets: FolderRunnerSecrets,
  fetchImpl: typeof fetch = fetch
): Promise<RevokeOutcome> {
  try {
    return provider === "gdrive"
      ? await revokeGoogle(refreshToken, fetchImpl)
      : await revokeDropbox(refreshToken, secrets, fetchImpl);
  } catch (e) {
    console.error(`[FolderRevoke] ${provider} revoke failed:`, e instanceof Error ? e.message : e);
    return "failed";
  }
}

/** Revoking the refresh token ends every access token minted from it. */
async function revokeGoogle(refreshToken: string, fetchImpl: typeof fetch): Promise<RevokeOutcome> {
  const res = await fetchImpl(GOOGLE_REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: refreshToken }),
  });
  if (res.ok) return "revoked";
  // Google answers 400 invalid_token for a token that is already gone.
  if (res.status === 400 && /invalid_token/.test(await res.text().catch(() => ""))) {
    return "already-invalid";
  }
  return "failed";
}

/**
 * Dropbox revokes the access token the call is made with, and with it the
 * refresh token behind it. We store only the refresh token, so mint an access
 * token first; if even that is refused, the grant is already dead.
 */
async function revokeDropbox(
  refreshToken: string,
  secrets: FolderRunnerSecrets,
  fetchImpl: typeof fetch
): Promise<RevokeOutcome> {
  let accessToken: string;
  try {
    accessToken = await refreshDropboxAccessToken(
      refreshToken,
      secrets.dropboxAppKey,
      secrets.dropboxAppSecret,
      fetchImpl
    );
  } catch {
    return "already-invalid";
  }
  const res = await fetchImpl(DROPBOX_REVOKE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.ok) return "revoked";
  if (res.status === 401) return "already-invalid";
  return "failed";
}

/** The stored refresh token of a folderTokens document, decrypted, or null. */
export function readStoredRefreshToken(
  tokens: FirebaseFirestore.DocumentData | undefined,
  secrets: FolderRunnerSecrets
): string | null {
  if (!tokens?.refreshToken || !tokens.refreshTokenIv) return null;
  try {
    return decrypt(tokens.refreshToken, tokens.refreshTokenIv, secrets.encryptionKey);
  } catch {
    return null;
  }
}


/**
 * Revoke every Folder Integration grant a user holds. For account deletion,
 * where the token documents are about to be deleted with everything else.
 * Returns how many grants were handled; failures are logged, never thrown.
 */
export async function revokeUserFolderGrants(
  db: FirebaseFirestore.Firestore,
  userId: string,
  secrets: FolderRunnerSecrets | null
): Promise<number> {
  if (!secrets) {
    console.warn("[FolderRevoke] secrets unavailable, grants are deleted but not revoked");
    return 0;
  }
  let handled = 0;
  const integrations = await db.collection("folderIntegrations").where("userId", "==", userId).get();
  for (const doc of integrations.docs) {
    const tokenSnap = await db.collection("folderTokens").doc(doc.id).get();
    const tokens = tokenSnap.data();
    if (!tokens || tokens.userId !== userId) continue;
    const refreshToken = readStoredRefreshToken(tokens, secrets);
    if (!refreshToken) continue;
    await revokeGrant(doc.data().provider as FolderProviderId, refreshToken, secrets);
    handled++;
  }
  return handled;
}
