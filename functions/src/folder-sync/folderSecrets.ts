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

export function readFolderSecrets(): FolderRunnerSecrets {
  return {
    dropboxAppKey: dropboxAppKey.value(),
    dropboxAppSecret: dropboxAppSecret.value(),
    googleClientId: googleClientId.value(),
    googleClientSecret: googleClientSecret.value(),
    encryptionKey: folderTokenKey.value(),
  };
}
