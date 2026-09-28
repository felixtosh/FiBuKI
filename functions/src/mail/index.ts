/**
 * Mail provider barrel + factory.
 *
 * Compiled-in Mail Providers are registered here, by importing this module
 * (#102): the register in registry.ts is the one list, and the factory serves
 * whatever is on it. Auth material is resolved by the caller (the queue worker
 * owns Gmail OAuth refresh) and passed in already-decrypted — see the
 * credential contract in registry.ts.
 */

import { MailProvider } from "./provider";
import { gmailDescriptor } from "./GmailProvider";
import { ImapProvider } from "./imap/ImapProvider";
import {
  MailCredentials,
  createMailProvider,
  getMailProviderDescriptor,
  registerMailProvider,
} from "./registry";

export * from "./provider";
export * from "./registry";
export { GmailProvider, gmailDescriptor } from "./GmailProvider";
export { ImapProvider } from "./imap/ImapProvider";
export type { ImapConfig } from "./imap/ImapProvider";
export { classifyImapError, FATAL_IMAP_ERROR_CODES, IMAP_ERROR_MESSAGES } from "./imap/classify-error";
export type { ImapErrorCode, ImapErrorClassification } from "./imap/classify-error";

// The compiled-in providers. Adding one is adding a file with a descriptor
// and one registration line here — nothing else to edit.
registerMailProvider(gmailDescriptor);

/**
 * Select a concrete MailProvider off the integration's `provider` field.
 *
 * Serves registered descriptors first. IMAP still sits in the legacy branch
 * below until its descriptor (credential fields for host/port/user/password,
 * capability flags for its scanned search) is written — the register is
 * skeleton-first, migrating one provider at a time.
 */
export function makeProvider(
  provider: string,
  credentials: MailCredentials
): MailProvider {
  if (getMailProviderDescriptor(provider)) {
    return createMailProvider(provider, credentials);
  }
  switch (provider) {
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
