import { defineSecret } from "firebase-functions/params";
import type { FolderRunnerSecrets } from "./folderSyncRunner";

// firebase functions:secrets:set DROPBOX_APP_KEY / DROPBOX_APP_SECRET
// The token key is the one mail tokens already use.
export const dropboxAppKey = defineSecret("DROPBOX_APP_KEY");
export const dropboxAppSecret = defineSecret("DROPBOX_APP_SECRET");
export const googleClientId = defineSecret("GOOGLE_CLIENT_ID");
export const googleClientSecret = defineSecret("GOOGLE_CLIENT_SECRET");
export const folderTokenKey = defineSecret("GMAIL_TOKEN_ENCRYPTION_KEY");

export const folderSecretParams = [dropboxAppKey, dropboxAppSecret, googleClientId, googleClientSecret, folderTokenKey];

/**
 * A deployment may configure Dropbox, Drive or both, so one missing secret must
 * not take the other provider down. A secret that is not set reads as "" and
 * `buildProvider` refuses to build a provider that lacks its own.
 */
function optional(secret: { value(): string }): string {
  try {
    return secret.value() ?? "";
  } catch {
    return "";
  }
}

export function readFolderSecrets(): FolderRunnerSecrets {
  return {
    dropboxAppKey: optional(dropboxAppKey),
    dropboxAppSecret: optional(dropboxAppSecret),
    googleClientId: optional(googleClientId),
    googleClientSecret: optional(googleClientSecret),
    encryptionKey: optional(folderTokenKey),
  };
}

/** For callers that can run without the secrets (account deletion must not fail on them). */
export function tryReadFolderSecrets(): FolderRunnerSecrets | null {
  try {
    return readFolderSecrets();
  } catch {
    return null;
  }
}
