/**
 * Reading one message out of a mailbox that is not Gmail, for the manual attach
 * path (#245).
 *
 * The connect overlay's mail tabs used to talk to Gmail only: search, preview,
 * attach and Mail to PDF all went through Gmail's REST client. Search already
 * goes through the provider factory (#240). These two callables are the other
 * half: the bytes of one attachment, and the body of one message, fetched
 * through the same `makeProvider` the Sync worker uses, so an IMAP mailbox can
 * be attached from exactly as it is synced.
 *
 * Gmail keeps its existing client on the attach routes; nothing here changes
 * what a Gmail user sees. Writing the File stays where it was, in the attach
 * routes: these callables only read.
 */

import { defineSecret } from "firebase-functions/params";
import { createCallable, HttpsError } from "../utils/createCallable";
import { makeProvider, MailProvider } from "./index";
import { imapConfigFromIntegration } from "./imap/config";

const tokenEncryptionKey = defineSecret("GMAIL_TOKEN_ENCRYPTION_KEY");

/**
 * Largest attachment this path hands back. The bytes travel base64 in a
 * callable response, so the cap keeps one attach from becoming a memory spike.
 */
export const MAX_MAIL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

interface MessageRequest {
  integrationId: string;
  messageId: string;
}

export interface GetMailAttachmentRequest extends MessageRequest {
  attachmentId: string;
}

export interface GetMailAttachmentResponse {
  filename: string;
  mimeType: string;
  size: number;
  dataBase64: string;
  integrationEmail: string | null;
}

export interface GetMailBodyResponse {
  htmlBody: string;
  textBody: string;
  subject: string;
  from: string;
  date: string;
  integrationEmail: string | null;
}

/**
 * Open the provider behind one of the caller's own integrations. Refuses
 * another user's integration as not-found, and a mailbox that needs
 * re-authentication as such, so the overlay can say which of the two it is.
 */
async function openProvider(
  db: FirebaseFirestore.Firestore,
  userId: string,
  integrationId: string
): Promise<{ provider: MailProvider; integrationEmail: string | null }> {
  if (!integrationId) {
    throw new HttpsError("invalid-argument", "integrationId is required");
  }
  const integrationSnap = await db.collection("emailIntegrations").doc(integrationId).get();
  const integration = integrationSnap.exists ? integrationSnap.data() : undefined;
  if (!integration || integration.userId !== userId) {
    throw new HttpsError("not-found", "Integration not found");
  }
  if (integration.needsReauth) {
    throw new HttpsError("failed-precondition", "Re-authentication required");
  }

  const providerName = (integration.provider as string) || "gmail";
  if (providerName !== "imap") {
    // Gmail is read through its own client on the attach routes.
    throw new HttpsError(
      "failed-precondition",
      `Mail provider "${providerName}" is not read through this path`
    );
  }

  const tokenSnap = await db.collection("emailTokens").doc(integrationId).get();
  if (!tokenSnap.exists) {
    throw new HttpsError("failed-precondition", "Re-authentication required");
  }

  const provider = makeProvider("imap", {
    imap: imapConfigFromIntegration(
      integration,
      tokenSnap.data() as { secret?: string; secretIv?: string },
      tokenEncryptionKey.value()
    ),
  });
  return { provider, integrationEmail: (integration.email as string) || null };
}

export const getMailAttachmentCallable = createCallable<
  GetMailAttachmentRequest,
  GetMailAttachmentResponse
>(
  {
    name: "getMailAttachment",
    memory: "512MiB",
    timeoutSeconds: 60,
    secrets: [tokenEncryptionKey],
  },
  async (ctx, request) => {
    const { integrationId, messageId, attachmentId } = request;
    if (!messageId || !attachmentId) {
      throw new HttpsError("invalid-argument", "messageId and attachmentId are required");
    }

    const { provider, integrationEmail } = await openProvider(ctx.db, ctx.userId, integrationId);
    try {
      const message = await provider.getMessage({ id: messageId });
      const attachment = message.attachments.find((a) => a.attachmentId === attachmentId);
      if (!attachment) {
        throw new HttpsError("not-found", "Attachment not found on this message");
      }
      if (attachment.size > MAX_MAIL_ATTACHMENT_BYTES) {
        throw new HttpsError("resource-exhausted", "Attachment is too large to attach");
      }

      const bytes = await provider.getAttachment(message, attachment);
      if (bytes.length > MAX_MAIL_ATTACHMENT_BYTES) {
        throw new HttpsError("resource-exhausted", "Attachment is too large to attach");
      }

      return {
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: bytes.length,
        dataBase64: bytes.toString("base64"),
        integrationEmail,
      };
    } finally {
      await provider.close();
    }
  }
);

export const getMailBodyCallable = createCallable<MessageRequest, GetMailBodyResponse>(
  {
    name: "getMailBody",
    memory: "512MiB",
    timeoutSeconds: 60,
    secrets: [tokenEncryptionKey],
  },
  async (ctx, request) => {
    const { integrationId, messageId } = request;
    if (!messageId) {
      throw new HttpsError("invalid-argument", "messageId is required");
    }

    const { provider, integrationEmail } = await openProvider(ctx.db, ctx.userId, integrationId);
    try {
      if (!provider.getBody) {
        throw new HttpsError("failed-precondition", "This mailbox cannot read message bodies");
      }
      const message = await provider.getMessage({ id: messageId });
      const body = await provider.getBody({ id: messageId });
      return {
        htmlBody: body.html ?? "",
        textBody: body.text ?? "",
        subject: message.subject,
        from: message.from,
        date: message.date.toISOString(),
        integrationEmail,
      };
    } finally {
      await provider.close();
    }
  }
);
