/**
 * The non-Gmail half of the manual attach routes (#245).
 *
 * The attach routes (`/api/mail/attachment`, `/api/mail/email-content`,
 * `/api/mail/convert-to-pdf`, and their older `/api/gmail/*` names) grew up
 * talking to Gmail's REST client. A mailbox on any other provider is read
 * through the callables in functions/src/mail/mailMessageCallables.ts, which
 * go through the same provider factory Sync uses. This module is the seam the
 * routes branch on: which provider an integration is, and the two reads.
 *
 * Gmail keeps its existing path untouched; nothing here runs for it.
 */

import { getAdminDb } from "@/lib/firebase/admin";
import { callFirebaseFunction } from "@/lib/api/firebase-callable";

/**
 * The provider of one of the user's own integrations, or null when the id is
 * absent, unknown or not theirs (the Gmail path then reports that as before).
 */
export async function ownedIntegrationProvider(
  integrationId: string | null | undefined,
  userId: string
): Promise<string | null> {
  if (!integrationId) return null;
  const snap = await getAdminDb().collection("emailIntegrations").doc(integrationId).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (!data || data.userId !== userId) return null;
  return (data.provider as string) || "gmail";
}

/** Gmail is the only provider the attach routes still read with their own client. */
export function readsThroughProviderFactory(provider: string | null): boolean {
  return provider !== null && provider !== "gmail";
}

export interface ProviderAttachment {
  data: Buffer;
  filename: string;
  mimeType: string;
  size: number;
  integrationEmail: string | null;
}

export async function fetchProviderAttachment(
  authToken: string,
  args: { integrationId: string; messageId: string; attachmentId: string }
): Promise<ProviderAttachment> {
  const res = await callFirebaseFunction<
    typeof args,
    {
      filename: string;
      mimeType: string;
      size: number;
      dataBase64: string;
      integrationEmail: string | null;
    }
  >("getMailAttachment", args, authToken);
  const data = Buffer.from(res.dataBase64, "base64");
  return {
    data,
    filename: res.filename,
    mimeType: res.mimeType,
    size: data.length,
    integrationEmail: res.integrationEmail,
  };
}

export interface ProviderBody {
  htmlBody: string;
  textBody: string;
  subject: string;
  from: string;
  date: string;
  integrationEmail: string | null;
}

export async function fetchProviderBody(
  authToken: string,
  args: { integrationId: string; messageId: string }
): Promise<ProviderBody> {
  return callFirebaseFunction<typeof args, ProviderBody>("getMailBody", args, authToken);
}

/**
 * A callable failure as the attach routes report it. Re-authentication is its
 * own code, so the overlay can tell "this mailbox needs reconnecting" apart
 * from "nothing is connected" (#245).
 */
export function providerErrorResponse(error: unknown): {
  status: number;
  body: { error: string; code?: string };
} {
  const message = error instanceof Error ? error.message : String(error);
  if (/re-?authentication required/i.test(message)) {
    return { status: 403, body: { error: "Re-authentication required", code: "REAUTH_REQUIRED" } };
  }
  if (/not.?found/i.test(message)) {
    return { status: 404, body: { error: message, code: "NOT_FOUND" } };
  }
  if (/too large/i.test(message)) {
    return { status: 413, body: { error: message, code: "TOO_LARGE" } };
  }
  return { status: 500, body: { error: message } };
}
