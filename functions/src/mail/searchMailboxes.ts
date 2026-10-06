/**
 * The Mail Integrations one receipt search reads, opened through their Mail
 * Providers (#746).
 *
 * The search queue and the header scan both open mailboxes here, so there is
 * one way to turn a Mail Integration into a MailProvider (the Gmail OAuth
 * refresh, the IMAP app-password decrypt) and one way to record what a search
 * did to it: when it last searched it, the Files it created, and the last
 * error. The browser only reads those fields (ADR-0016).
 */

import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import type { MailProvider } from "./provider";
import { classifyImapError, FATAL_IMAP_ERROR_CODES } from "./imap/classify-error";
import { mailProviderOf, searchedMailIntegrations } from "./searchable";

const googleClientId = defineSecret("GOOGLE_CLIENT_ID");
const googleClientSecret = defineSecret("GOOGLE_CLIENT_SECRET");
const tokenEncryptionKey = defineSecret("GMAIL_TOKEN_ENCRYPTION_KEY");

/** The secrets a function that opens mailboxes must declare. */
export const MAIL_PROVIDER_SECRETS = [googleClientId, googleClientSecret, tokenEncryptionKey];

/** Builds the MailProvider for one Mail Integration. */
export type MailProviderFactory = (
  integrationId: string,
  integration: FirebaseFirestore.DocumentData
) => Promise<MailProvider>;

/**
 * The production factory: reads the integration's token record and hands it
 * to the provider fork the old Sync used (Gmail refreshes its token and marks
 * the integration for reauth when it cannot; IMAP decrypts its app-password).
 */
export const openMailProvider: MailProviderFactory = async (integrationId, integration) => {
  const tokenSnap = await getFirestore().collection("emailTokens").doc(integrationId).get();
  if (!tokenSnap.exists) throw new Error(`no token document for integration ${integrationId}`);
  const { resolveMailProvider } = await import("../gmail/gmailSyncQueue");
  return resolveMailProvider(mailProviderOf(integration), integration, tokenSnap.data()!, integrationId, {
    clientId: secretOrEmpty(googleClientId),
    clientSecret: secretOrEmpty(googleClientSecret),
    encryptionKey: secretOrEmpty(tokenEncryptionKey),
  });
};

/**
 * A secret's value, or "" where the deployment does not set it. An IMAP-only
 * self-host box has no Google OAuth client, and reading one must not stop it
 * opening an IMAP mailbox; a Gmail refresh without one fails on its own terms
 * and marks the mailbox for reauth.
 */
function secretOrEmpty(secret: { value(): string }): string {
  try {
    return secret.value();
  } catch {
    return "";
  }
}

let factoryOverride: MailProviderFactory | null = null;

/**
 * Replace the factory, for tests that stand a fake mailbox in for a real one.
 * The override may return `null` to fall through to the real factory.
 */
export function __setMailProviderFactory(
  factory: ((integrationId: string, integration: FirebaseFirestore.DocumentData) => Promise<MailProvider | null>) | null
): void {
  factoryOverride = factory as MailProviderFactory | null;
}

async function providerFor(integrationId: string, integration: FirebaseFirestore.DocumentData): Promise<MailProvider> {
  if (factoryOverride) {
    const provider = await factoryOverride(integrationId, integration);
    if (provider) return provider;
  }
  return openMailProvider(integrationId, integration);
}

/** The Mail Integration's provider, for the header scan's own selection. */
export function mailProviderForIntegration(
  integrationId: string,
  integration: FirebaseFirestore.DocumentData
): Promise<MailProvider> {
  return providerFor(integrationId, integration);
}

/** What a failure means for the Mail Integration it happened on. */
export interface MailFailure {
  /** The login was refused: the Mail Integration needs new credentials. */
  needsCredentials: boolean;
  /** Nothing more can be read from it in this search. */
  fatal: boolean;
  /** A classified cause the page renders in fixed words; IMAP only. */
  code: string | null;
  /** Plain words for the mailbox page. */
  message: string;
}

/**
 * Classify a failure from one Mail Provider. IMAP has a classification of its
 * own (the connect form uses it too); any other provider's error is recorded
 * as it came.
 */
export function classifyMailFailure(provider: string, error: unknown): MailFailure {
  if (provider === "imap") {
    const { code, message } = classifyImapError(error);
    return {
      needsCredentials: code === "auth_failed",
      fatal: FATAL_IMAP_ERROR_CODES.has(code),
      code,
      message,
    };
  }
  return {
    needsCredentials: false,
    fatal: false,
    code: null,
    message: error instanceof Error ? error.message : String(error),
  };
}

/** One Mail Integration, opened for one search. */
export interface SearchedMailbox {
  id: string;
  email: string;
  provider: string;
  mail: MailProvider;
  /** Files this search created from it. */
  filesCreated: number;
  /** Whether this search reached it at all; only then is a search recorded. */
  searched: boolean;
  /** The last failure in this search, if any. */
  failure: MailFailure | null;
}

/** A failure reading a mailbox, as opposed to one in the code around the read. */
export class MailboxReadError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "MailboxReadError";
  }
}

/** Mark a provider call's failure as the mailbox's own. */
export function fromMailbox<T>(read: Promise<T>): Promise<T> {
  return read.catch((error: unknown) => {
    throw new MailboxReadError(error);
  });
}

/** Whether the search can still read this mailbox. */
export function isUsable(mailbox: SearchedMailbox): boolean {
  return !mailbox.failure?.fatal;
}

/**
 * Record a failure on the Mail Integration. A refused login marks it as
 * needing new credentials (the mailbox page then asks for them); any failure
 * is kept as the search's last error. The search moves on either way.
 */
export async function recordMailboxFailure(
  db: FirebaseFirestore.Firestore,
  integrationId: string,
  provider: string,
  error: unknown
): Promise<MailFailure> {
  const failure = classifyMailFailure(provider, error);
  const now = Timestamp.now();
  console.error(`[ReceiptSearch] Mail Integration ${integrationId} (${provider}) failed: ${failure.message}`);
  await db
    .collection("emailIntegrations")
    .doc(integrationId)
    .update({
      receiptSearchLastError: failure.message,
      receiptSearchLastErrorAt: now,
      ...(failure.code ? { lastSyncErrorCode: failure.code } : {}),
      ...(failure.needsCredentials ? { needsReauth: true, lastError: failure.message } : {}),
      updatedAt: now,
    });
  return failure;
}

/** Record a failure on an opened mailbox; a fatal one ends its part in this search. */
export async function failMailbox(
  db: FirebaseFirestore.Firestore,
  mailbox: SearchedMailbox,
  error: unknown
): Promise<void> {
  mailbox.searched = true;
  mailbox.failure = await recordMailboxFailure(db, mailbox.id, mailbox.provider, error);
}

/**
 * Open every Mail Integration the receipt search reads for this User. A
 * mailbox that cannot even be opened is recorded and left out; the others
 * are still searched.
 */
export async function openSearchedMailboxes(
  db: FirebaseFirestore.Firestore,
  userId: string
): Promise<SearchedMailbox[]> {
  const snapshot = await db.collection("emailIntegrations").where("userId", "==", userId).get();
  const selected = searchedMailIntegrations(
    snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as { id: string } & FirebaseFirestore.DocumentData)
  );

  const opened: SearchedMailbox[] = [];
  for (const integration of selected) {
    const provider = mailProviderOf(integration);
    try {
      const mail = await providerFor(integration.id, integration);
      opened.push({
        id: integration.id,
        email: (integration.email as string | undefined) ?? "",
        provider,
        mail,
        filesCreated: 0,
        searched: false,
        failure: null,
      });
    } catch (error) {
      await recordMailboxFailure(db, integration.id, provider, error);
    }
  }
  return opened;
}

/**
 * Close the mailboxes and record the search on each one it reached: the time,
 * the Files it created (a running count), and, when it went through without
 * an error, no last error any more.
 */
export async function closeSearchedMailboxes(
  db: FirebaseFirestore.Firestore,
  mailboxes: SearchedMailbox[]
): Promise<void> {
  for (const mailbox of mailboxes) {
    try {
      await mailbox.mail.close();
    } catch (error) {
      console.warn(`[ReceiptSearch] closing Mail Integration ${mailbox.id} failed:`, error);
    }
    if (!mailbox.searched) continue;
    const now = Timestamp.now();
    await db
      .collection("emailIntegrations")
      .doc(mailbox.id)
      .update({
        receiptSearchLastSearchedAt: now,
        ...(mailbox.filesCreated > 0
          ? { receiptSearchFilesCreated: FieldValue.increment(mailbox.filesCreated) }
          : {}),
        ...(mailbox.failure ? {} : { receiptSearchLastError: null, receiptSearchLastErrorAt: null }),
        updatedAt: now,
      });
  }
}
