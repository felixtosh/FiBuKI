/**
 * How a stored mail integration becomes an ImapConfig.
 *
 * Lifted out of gmailSyncQueue's `resolveMailProvider` when the manual attach
 * path needed the same resolution (#240): Sync and attach must reach the same
 * mailbox with the same defaults, and two copies of "port 993 unless told
 * otherwise" is how they stop doing that.
 */

import { decrypt } from "../../utils/encryption";
import { ImapConfig } from "./ImapProvider";

/** The `emailTokens` shape an IMAP integration writes: one encrypted app-password. */
export interface ImapStoredSecret {
  secret?: string;
  secretIv?: string;
}

export function imapConfigFromIntegration(
  integrationData: FirebaseFirestore.DocumentData | undefined,
  tokenData: ImapStoredSecret,
  encryptionKey: string
): ImapConfig {
  if (!tokenData.secret || !tokenData.secretIv) {
    throw new Error("IMAP integration is missing its stored app-password");
  }
  const host = integrationData?.imapHost as string | undefined;
  const user = integrationData?.email as string | undefined;
  if (!host || !user) {
    throw new Error("IMAP integration is missing host or username");
  }

  return {
    host,
    port: (integrationData?.imapPort as number) ?? 993,
    secure: integrationData?.imapSecure !== false,
    allowSelfSigned: Boolean(integrationData?.imapAllowSelfSigned),
    mailbox: (integrationData?.imapMailbox as string) || "INBOX",
    keywordPrefilter: integrationData?.imapKeywordPrefilter !== false,
    user,
    password: decrypt(tokenData.secret, tokenData.secretIv, encryptionKey),
  };
}
