/**
 * Send invite notification email via the central mailer.
 */

import { buildInviteSubject, buildInviteHtml, buildInviteText } from "./inviteEmail";
import { sendEmail } from "../utils/mailer";

export async function sendInviteEmail(email: string): Promise<void> {
  if (!email) {
    console.warn("[InviteEmail] No email provided");
    return;
  }

  const sent = await sendEmail({
    to: email,
    subject: buildInviteSubject(),
    text: buildInviteText(),
    html: buildInviteHtml(),
  });

  if (sent) {
    console.log(`[InviteEmail] Sent invite to ${email}`);
  }
}
