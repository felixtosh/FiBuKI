/**
 * Which of the User's Mail Integrations the chat assistant's mail tools read
 * (#746): the receipt search's own rule, so the chat never tells a User with
 * an IMAP mailbox to "connect Gmail", and searches what the integrations page
 * lists as connected.
 */

import {
  SEARCHABLE_MAIL_PROVIDERS,
  mailProviderOf,
  searchedMailIntegrations,
} from "../../../functions/src/mail/searchable";

type Db = FirebaseFirestore.Firestore;

export interface ChatMailIntegration {
  id: string;
  email?: string;
  provider: string;
}

export interface ChatMailIntegrations {
  /** Connected mailboxes of a provider the search can read, needing reauth or not. */
  connected: ChatMailIntegration[];
  /** The ones a search reads now: the receipt search's selection. */
  searched: ChatMailIntegration[];
  /** Connected, but waiting for new credentials. */
  needingReauth: Array<{ integrationId: string; email?: string; needsReauth: true }>;
}

/** The answer a mail tool gives when the User has connected no mailbox at all. */
export const NO_MAILBOX_CONNECTED =
  "No mailbox is connected. Connect one on the integrations page to search mail.";

export async function chatMailIntegrations(db: Db, userId: string): Promise<ChatMailIntegrations> {
  const snapshot = await db.collection("emailIntegrations").where("userId", "==", userId).get();
  const records = snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }) as { id: string } & FirebaseFirestore.DocumentData)
    .filter(
      (record) =>
        record.isActive === true &&
        (SEARCHABLE_MAIL_PROVIDERS as readonly string[]).includes(mailProviderOf(record))
    );
  const shape = (record: { id: string } & FirebaseFirestore.DocumentData): ChatMailIntegration => ({
    id: record.id,
    email: record.email as string | undefined,
    provider: mailProviderOf(record),
  });

  return {
    connected: records.map(shape),
    searched: searchedMailIntegrations(records).map(shape),
    needingReauth: records
      .filter((record) => record.needsReauth === true)
      .map((record) => ({ integrationId: record.id, email: record.email as string | undefined, needsReauth: true as const })),
  };
}
