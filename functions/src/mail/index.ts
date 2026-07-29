/**
 * Mail provider factory.
 *
 * Selects a concrete MailProvider off the integration's `provider` field.
 * Auth material is resolved by the caller (the queue worker owns Gmail OAuth
 * refresh) and passed in already-decrypted.
 */

import { MailProvider } from "./provider";
import { GmailProvider } from "./GmailProvider";
import { ImapProvider, ImapConfig } from "./imap/ImapProvider";

export * from "./provider";
export { GmailProvider } from "./GmailProvider";
export { ImapProvider } from "./imap/ImapProvider";
export type { ImapConfig } from "./imap/ImapProvider";

/** Provider-specific, already-decrypted credentials. */
export interface MailCredentials {
  /** Gmail: a valid (refreshed) OAuth access token. */
  accessToken?: string;
  /** IMAP: connection config + decrypted app-password. */
  imap?: ImapConfig;
}

export function makeProvider(
  provider: string,
  credentials: MailCredentials
): MailProvider {
  switch (provider) {
    case "gmail": {
      if (!credentials.accessToken) {
        throw new Error("Gmail provider requires an access token");
      }
      return new GmailProvider(credentials.accessToken);
    }
    case "imap": {
      if (!credentials.imap) {
        throw new Error("IMAP provider requires connection config");
      }
      return new ImapProvider(credentials.imap);
    }
    default:
      throw new Error(`Unknown mail provider: ${provider}`);
  }
}
