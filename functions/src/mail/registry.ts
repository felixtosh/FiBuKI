/**
 * The Mail Provider register (#102).
 *
 * Adding a Mail Provider is adding a file: the provider module exports a
 * MailProviderDescriptor — its self-description — and mail/index.ts registers
 * it here. Everything downstream reads the register instead of hardcoding a
 * provider: the factory creates from a descriptor, and the integrations UI is
 * meant to render its connect form from `credentialFields` and branch on
 * `capabilities` instead of shipping a Gmail-shaped page.
 *
 * Explicitly NOT a plugin runtime: first-party Mail Providers stay in-process
 * TypeScript, compiled in — that is where the snappiness comes from. This
 * register is what makes a real plugin boundary possible later without paying
 * for it now.
 */

import { MailProvider } from "./provider";
import type { ImapConfig } from "./imap/ImapProvider";

/**
 * The credential contract.
 *
 * How a Mail Provider's secret travels:
 *
 * - **Stored** encrypted at rest on the Mail Integration document, under the
 *   keys the provider's `credentialFields` declare. Only fields marked
 *   `secret` are encrypted; the rest (host, port, username) are plain config.
 * - **Decrypted by the caller**, in whichever container runs the mail work
 *   (the Sync worker in functions, or fibuki-web's server-side document IO —
 *   both must hold the encryption key; the self-host bug where the key never
 *   reached the web container is exactly what this contract exists to
 *   prevent). A provider never sees ciphertext and never decrypts.
 * - **Assumed present**: `create()` may assume every field its descriptor
 *   declares has been resolved and decrypted, and must refuse with a
 *   descriptive error when one is missing — never construct a provider that
 *   fails later on the wire for a reason known up front.
 *
 * The shape below is the union over the compiled-in providers; each
 * descriptor's `credentialFields` say which keys it actually reads.
 */
export interface MailCredentials {
  /** Gmail: a valid (refreshed) OAuth access token. */
  accessToken?: string;
  /** IMAP: connection config + decrypted app-password. */
  imap?: ImapConfig;
}

/** One field of a provider's connect form / stored credential material. */
export interface MailCredentialField {
  /** Key under which the value is stored on the Mail Integration. */
  key: string;
  /** English label; the UI translates via the message catalogue. */
  label: string;
  /** True: encrypted at rest, decrypted only by the container doing mail work. */
  secret: boolean;
  /** What the field is, for the connect form's help text. */
  description?: string;
}

/**
 * What a Mail Provider can and cannot do, so callers branch on declared
 * capability instead of on a provider id.
 */
export interface MailProviderCapabilities {
  /** Executes MailSearchTerms server-side (vs scanning a bounded slice). */
  serverSearch: boolean;
  /** Can search attachment filenames (see MailSearchTerms.filenames). */
  filenameSearch: boolean;
  /** Can resume a Sync from a cursor instead of re-walking a date window. */
  incrementalSync: boolean;
}

/** A Mail Provider's self-description: everything outside code needs to know. */
export interface MailProviderDescriptor {
  /** Stable id, the Mail Integration's `provider` value. */
  id: string;
  /** Human-readable name for the integrations UI. */
  label: string;
  /** What the connect form asks for and what is stored — see MailCredentials. */
  credentialFields: MailCredentialField[];
  capabilities: MailProviderCapabilities;
  /**
   * Build the provider from already-decrypted credentials. Must throw a
   * descriptive Error when a declared credential is missing.
   */
  create(credentials: MailCredentials): MailProvider;
}

const registry = new Map<string, MailProviderDescriptor>();

/** Register a compiled-in provider. One registration per id, at module load. */
export function registerMailProvider(descriptor: MailProviderDescriptor): void {
  if (registry.has(descriptor.id)) {
    throw new Error(`Mail provider "${descriptor.id}" is already registered`);
  }
  registry.set(descriptor.id, descriptor);
}

export function getMailProviderDescriptor(
  id: string
): MailProviderDescriptor | undefined {
  return registry.get(id);
}

/** Every registered descriptor, for the integrations UI and diagnostics. */
export function listMailProviderDescriptors(): MailProviderDescriptor[] {
  return [...registry.values()];
}

/** Create a provider off the register. */
export function createMailProvider(
  id: string,
  credentials: MailCredentials
): MailProvider {
  const descriptor = registry.get(id);
  if (!descriptor) {
    const known = [...registry.keys()].join(", ");
    throw new Error(`Unknown mail provider: ${id} (registered: ${known})`);
  }
  return descriptor.create(credentials);
}
