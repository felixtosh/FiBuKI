import { ImapFlow } from "imapflow";
// Shared with the sync worker so a connect-time failure, a repair-time failure
// and a sync-time failure speak with one voice. The app layer imports from
// functions/, never the reverse — functions/ builds standalone for deploy.
import {
  classifyImapError,
  type ImapErrorClassification,
} from "@/functions/src/mail/imap/classify-error";

/** Everything needed to attempt one login against a mailbox. */
export interface ImapVerifyParams {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  mailbox: string;
  allowSelfSigned: boolean;
}

/**
 * Prove a mailbox can be read with these credentials, before anything is
 * written down.
 *
 * Two routes persist IMAP credentials — connecting a new mailbox and repairing
 * a broken one — and both must refuse to store a credential they have not just
 * used successfully. Sharing the attempt is what keeps them from drifting into
 * two different definitions of "verified", which is the same reason the error
 * classifier is shared with the worker.
 *
 * Returns the classified failure rather than throwing it: at both call sites
 * the failure is a 400 the caller renders, not an exception.
 */
export async function verifyImapMailbox(
  params: ImapVerifyParams
): Promise<ImapErrorClassification | null> {
  const client = new ImapFlow({
    host: params.host,
    port: params.port,
    secure: params.secure,
    auth: { user: params.user, pass: params.password },
    logger: false,
    ...(params.allowSelfSigned ? { tls: { rejectUnauthorized: false } } : {}),
  });

  try {
    await client.connect();
    // Read-only: opening the mailbox proves the folder exists and is readable
    // without touching \Seen flags on the user's mail.
    const lock = await client.getMailboxLock(params.mailbox, { readOnly: true });
    lock.release();
    await client.logout();
    return null;
  } catch (error) {
    try {
      client.close();
    } catch {
      // ignore — connection may already be down
    }
    return classifyImapError(error);
  }
}
